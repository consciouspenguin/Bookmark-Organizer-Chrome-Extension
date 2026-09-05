import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { OrganizerService } from './organizer'
import * as bookmarksExport from './bookmarks_export'
import fixture from './__fixtures__/finance-heavy-bookmarks.json'

// Regression suite for the "everything lands in General" bug, run through the
// real generateSchema -> classifyBatch -> reconcileSubcategories pipeline with
// only `fetch` mocked, so schema validation and reconciliation genuinely fire.

const bookmarks = fixture.map(({ title, url, dateAdded }) => ({ title, url, dateAdded }))
const expectedByUrl = new Map(fixture.map(b => [b.url, b]))

const DOMINANT_CATEGORY = 'Finance & Crypto'

// The structure a healthy model would return for this fixture.
const healthySchema = {
    categories: [...new Set(fixture.map(b => b.expected_category))].map(name => ({
        name,
        sub_categories: [...new Set(fixture.filter(b => b.expected_category === name).map(b => b.expected_sub_category))]
    }))
}

const flatSchema = {
    categories: [...new Set(fixture.map(b => b.expected_category))].map(name => ({ name, sub_categories: [] }))
}

// Both providers' success envelopes, so the same run can be driven through the
// OpenRouter and the native Gemini response parsers.
const jsonResponse = (payload, provider = 'openrouter') => {
    const content = JSON.stringify(payload)
    return {
        ok: true,
        status: 200,
        json: async () => provider === 'gemini'
            ? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: content }] } }] }
            : { choices: [{ finish_reason: 'stop', message: { content } }] }
    }
}

const API_KEYS = { openrouter: 'sk-or-test-key', gemini: 'AIzaSyTestKey' }

const errorResponse = (status) => ({
    ok: false,
    status,
    text: async () => JSON.stringify({ error: { message: 'nope' } })
})

const promptOf = (options) => {
    const body = JSON.parse(options.body)
    return body.messages ? body.messages[1].content : body.contents[0].parts[0].text
}
const isSchemaCall = (prompt) => prompt.includes('BOOKMARKS TO ANALYZE')

// Pulls the batch the classifier was handed back out of its prompt.
const batchFromPrompt = (prompt) => {
    const marker = 'BOOKMARKS (each with its index "i"):'
    const start = prompt.indexOf(marker) + marker.length
    return JSON.parse(prompt.slice(start, prompt.lastIndexOf(']') + 1).trim())
}

// The schema the classifier was actually told to use.
const schemaFromPrompt = (prompt) => {
    const start = prompt.indexOf('APPROVED SCHEMA:') + 'APPROVED SCHEMA:'.length
    return JSON.parse(prompt.slice(start, prompt.indexOf('RULES')).trim())
}

/**
 * Builds a fetch mock that answers schema calls from `schemaResponses` (one per
 * call, last repeating) and classification calls from the fixture's expected
 * labels, optionally distorted by `distort` to simulate model sloppiness.
 */
const mockAi = ({ schemaResponses, distort = null, provider = 'openrouter' }) => {
    let schemaCall = 0

    return vi.fn(async (url, options) => {
        const prompt = promptOf(options)

        if (isSchemaCall(prompt)) {
            const next = schemaResponses[Math.min(schemaCall, schemaResponses.length - 1)]
            schemaCall++
            return typeof next === 'number' ? errorResponse(next) : jsonResponse(next, provider)
        }

        const batch = batchFromPrompt(prompt)
        const classified = batch.map(({ i, url: bookmarkUrl }) => {
            const expected = expectedByUrl.get(bookmarkUrl)
            const entry = {
                i,
                category: expected.expected_category,
                sub_category: expected.expected_sub_category
            }
            return distort ? distort(entry, expected) : entry
        })

        return jsonResponse({ classified }, provider)
    })
}

const runOrganizer = async (fetchMock, { subfolderTarget = '5-10', provider = 'openrouter', input = bookmarks } = {}) => {
    global.fetch = fetchMock
    const logs = []
    const service = new OrganizerService(
        API_KEYS[provider],
        [...new Set(fixture.map(b => b.expected_category))],
        (e) => logs.push(e),
        'google/gemini-3.1-flash-lite',
        subfolderTarget
    )
    const results = await service.start(input)
    return { results, logs, service, messages: logs.map(l => l.message).filter(Boolean) }
}

const subfoldersIn = (results, category) =>
    new Set(results.filter(r => r.category === category).map(r => r.sub_category))

const generalShare = (results) =>
    results.filter(r => (r.sub_category || '').toLowerCase() === 'general').length / results.length

describe('subcategory pipeline regression', () => {
    let originalFetch

    beforeEach(() => {
        originalFetch = global.fetch
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
    })

    it('produces real subfolders across categories and places every bookmark exactly once', async () => {
        const { results } = await runOrganizer(mockAi({ schemaResponses: [healthySchema] }))

        expect(results).toHaveLength(bookmarks.length)
        expect(new Set(results.map(r => r.url)).size).toBe(bookmarks.length)

        expect(subfoldersIn(results, DOMINANT_CATEGORY).size).toBeGreaterThanOrEqual(3)
        expect(generalShare(results)).toBeLessThan(0.15)

        // The original bug: one General folder per category and nothing else.
        const everyCategoryOnlyGeneral = [...new Set(results.map(r => r.category))]
            .every(c => subfoldersIn(results, c).size === 1 && subfoldersIn(results, c).has('General'))
        expect(everyCategoryOnlyGeneral).toBe(false)
    })

    it('recovers when the model first returns a flat schema, without dumping everything in General', async () => {
        const fetchMock = mockAi({ schemaResponses: [flatSchema, healthySchema] })
        const { results, messages } = await runOrganizer(fetchMock)

        const correctionSent = fetchMock.mock.calls
            .map(([, options]) => promptOf(options))
            .filter(isSchemaCall)
        expect(correctionSent).toHaveLength(2)
        expect(correctionSent[1]).toContain('CORRECTION REQUIRED')

        expect(subfoldersIn(results, DOMINANT_CATEGORY).size).toBeGreaterThanOrEqual(3)
        expect(generalShare(results)).toBeLessThan(0.15)
        expect(messages.some(m => m.startsWith('Schema:'))).toBe(true)
    })

    it('falls back to curated default folders when schema generation cannot succeed', async () => {
        // 400 is permanent, so both the initial attempt and the reduced-sample
        // retry fail immediately rather than burning backoff.
        const fetchMock = mockAi({ schemaResponses: [400] })
        const { results, messages } = await runOrganizer(fetchMock)

        expect(messages.some(m => m.includes('used built-in default folders'))).toBe(true)
        expect(messages.some(m => m.includes('Retrying schema generation on a smaller sample'))).toBe(true)

        // The schema handed to the classifier carries real curated subfolders,
        // never the empty arrays that caused the original collapse.
        const classifySchema = schemaFromPrompt(
            fetchMock.mock.calls.map(([, o]) => promptOf(o)).find(p => !isSchemaCall(p))
        )
        const finance = classifySchema.categories.find(c => c.name === DOMINANT_CATEGORY)
        expect(finance.sub_categories.length).toBeGreaterThanOrEqual(3)
        expect(classifySchema.categories.every(c => c.sub_categories.length === 0)).toBe(false)

        expect(results).toHaveLength(bookmarks.length)
    })

    it('merges spelling variants and folds one-off proposals during a full run', async () => {
        let seenTradingCall = 0

        const fetchMock = mockAi({
            schemaResponses: [healthySchema],
            distort: (entry) => {
                // Alternate the casing of one subcategory across batches, the way
                // independent concurrent batches actually diverge.
                if (entry.sub_category === 'Trading & Markets') {
                    seenTradingCall++
                    // A minority variant, so the canonical spelling is the clear
                    // winner and the assertion does not hinge on tie-breaking.
                    if (seenTradingCall % 3 === 0) return { ...entry, sub_category: 'trading & markets' }
                }
                // A single-bookmark invented subcategory, which must not survive.
                if (entry.sub_category === 'Economic Data') {
                    return { ...entry, sub_category: 'Fed Watch Corner' }
                }
                return entry
            }
        })

        const { results, messages } = await runOrganizer(fetchMock)

        const financeSubs = subfoldersIn(results, DOMINANT_CATEGORY)
        // Casing variants collapsed to a single folder.
        expect(financeSubs.has('Trading & Markets')).toBe(true)
        expect(financeSubs.has('trading & markets')).toBe(false)

        expect(messages.some(m => m.startsWith('Subcategories:'))).toBe(true)
        expect(results).toHaveLength(bookmarks.length)
    })

    it('reports the General share in the run log', async () => {
        const { messages } = await runOrganizer(mockAi({ schemaResponses: [healthySchema] }))

        expect(messages.some(m => m.includes('Filed directly under their category (General)'))).toBe(true)
    })

    it('produces the same structure over the native Gemini response envelope', async () => {
        const { results } = await runOrganizer(
            mockAi({ schemaResponses: [healthySchema], provider: 'gemini' }),
            { provider: 'gemini' }
        )

        expect(results).toHaveLength(bookmarks.length)
        expect(subfoldersIn(results, DOMINANT_CATEGORY).size).toBeGreaterThanOrEqual(3)
        expect(generalShare(results)).toBeLessThan(0.15)
    })

    it('keeps a thin collection out of General, at two bookmarks per subcategory', async () => {
        // The full fixture carries >= 4 bookmarks per subcategory, which sits
        // above reconciliation's floor and hid the collapse entirely. Two per
        // subcategory is the shape a real small collection has.
        const seen = new Map()
        const thin = fixture.filter(b => {
            const key = `${b.expected_category}/${b.expected_sub_category}`
            const n = (seen.get(key) || 0) + 1
            seen.set(key, n)
            return n <= 2
        })
        const thinInput = thin.map(({ title, url, dateAdded }) => ({ title, url, dateAdded }))
        const thinSchema = {
            categories: [...new Set(thin.map(b => b.expected_category))].map(name => ({
                name,
                sub_categories: [...new Set(thin.filter(b => b.expected_category === name).map(b => b.expected_sub_category))]
            }))
        }

        const { results } = await runOrganizer(
            mockAi({ schemaResponses: [thinSchema] }),
            { input: thinInput }
        )

        expect(results).toHaveLength(thinInput.length)
        expect(generalShare(results)).toBeLessThan(0.2)
        expect(subfoldersIn(results, DOMINANT_CATEGORY).size).toBeGreaterThanOrEqual(3)
    })
})
