import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
    validateSchema,
    subfolderBounds,
    salvagePartialJson,
    generateSchema,
    classifyBatch,
    SCHEMA_MAX_TOKENS
} from './ai'

// Builds an OpenRouter-shaped success response carrying `content` verbatim.
const orResponse = (content, finishReason = 'stop') => ({
    ok: true,
    status: 200,
    json: async () => ({
        choices: [{ finish_reason: finishReason, message: { content } }]
    })
})

// Five subcategories per category so the same fixture satisfies every
// granularity floor, including the strictest ('10+' requires 5); three
// categories so it also clears the breadth floor a narrowed (e.g. salvaged)
// response fails.
const healthySchema = {
    categories: [
        { name: 'Finance & Crypto', sub_categories: ['Trading & Markets', 'Crypto & Blockchain', 'Investing & Wealth', 'Banking & Payments', 'Tax & Economics'] },
        { name: 'Tech & Development', sub_categories: ['Web Development', 'AI & Machine Learning', 'DevOps & Cloud', 'Databases', 'Security'] },
        { name: 'Work & Career', sub_categories: ['Job Search', 'Resume & Interviews', 'Industry Research', 'Networking', 'Learning & Courses'] }
    ]
}

// Builds a native Gemini generateContent response. `parts` is spread across
// `content.parts` verbatim, which is how the API streams a long answer back.
const geminiResponse = (parts, finishReason = 'STOP') => ({
    ok: true,
    status: 200,
    json: async () => ({
        candidates: [{ finishReason, content: { parts: parts.map(text => ({ text })) } }]
    })
})

// Google AI Studio keys select the native Gemini path.
const GEMINI_KEY = 'AIzaSyTestKey'

// Enough bookmarks to clear TINY_COLLECTION_THRESHOLD (40) so the strict floors apply.
const manyBookmarks = Array.from({ length: 50 }, (_, i) => ({
    title: `Bookmark ${i}`,
    url: `https://example.com/${i}`
}))

describe('subfolderBounds', () => {
    it('maps each granularity setting to its ask range, floor and ceiling', () => {
        expect(subfolderBounds('0-5')).toEqual({ ask: [3, 5], min: 2, max: 5 })
        expect(subfolderBounds('5-10')).toEqual({ ask: [5, 10], min: 3, max: 10 })
        expect(subfolderBounds('10+')).toEqual({ ask: [10, 14], min: 5, max: 16 })
    })

    it('falls back to the balanced default for unknown or missing values', () => {
        expect(subfolderBounds(undefined)).toEqual(subfolderBounds('5-10'))
        expect(subfolderBounds('nonsense')).toEqual(subfolderBounds('5-10'))
    })
})

describe('validateSchema', () => {
    it('accepts a schema meeting the granularity floor', () => {
        const result = validateSchema(healthySchema, { subfolderTarget: '5-10', bookmarkCount: 500 })

        expect(result.ok).toBe(true)
        expect(result.issues).toEqual([])
        expect(result.schema.categories).toHaveLength(3)
    })

    it('rejects a response that covers too few of the configured categories', () => {
        // The exact shape a MAX_TOKENS salvage produces: structurally fine, but
        // every bookmark outside the two surviving categories would be coerced
        // to "Other / General" during classification.
        const narrow = { categories: healthySchema.categories.slice(0, 2) }
        const expectedCategories = ['Finance & Crypto', 'Tech & Development', 'Work & Career', 'Design & Media', 'Travel & Lifestyle', 'Shopping & Tools']

        const result = validateSchema(narrow, { subfolderTarget: '5-10', bookmarkCount: 4000, expectedCategories })

        expect(result.ok).toBe(false)
        expect(result.issues.join(' ')).toMatch(/covered only 2 categories; at least 3 are needed/)
    })

    it('scales the breadth floor to half the configured category list', () => {
        const narrow = { categories: healthySchema.categories }
        const tenCategories = Array.from({ length: 10 }, (_, i) => `Category ${i}`)

        const result = validateSchema(narrow, { subfolderTarget: '5-10', bookmarkCount: 4000, expectedCategories: tenCategories })

        expect(result.ok).toBe(false)
        expect(result.issues.join(' ')).toMatch(/at least 5 are needed/)
    })

    it('exempts a tiny collection from the breadth floor', () => {
        const oneCategory = { categories: [healthySchema.categories[0]] }

        expect(validateSchema(oneCategory, { subfolderTarget: '5-10', bookmarkCount: 12 }).ok).toBe(true)
        expect(validateSchema(oneCategory, { subfolderTarget: '5-10', bookmarkCount: 4000 }).ok).toBe(false)
    })

    it('rejects a response with no categories at all', () => {
        expect(validateSchema(null).ok).toBe(false)
        expect(validateSchema({}).ok).toBe(false)
        expect(validateSchema({ categories: [] }).ok).toBe(false)
        expect(validateSchema({ categories: [] }).issues[0]).toMatch(/no categories/i)
    })

    it('rejects the empty-subcategory schema that caused the original bug', () => {
        const flat = {
            categories: [
                { name: 'Work & Career', sub_categories: [] },
                { name: 'Finance & Crypto', sub_categories: [] }
            ]
        }

        const result = validateSchema(flat, { subfolderTarget: '5-10', bookmarkCount: 3000 })

        expect(result.ok).toBe(false)
        expect(result.issues.join(' ')).toMatch(/at least 3 subcategories/)
    })

    it('treats a schema of nothing but filler names as flat', () => {
        const filler = {
            categories: [
                { name: 'Work & Career', sub_categories: ['General'] },
                { name: 'Finance & Crypto', sub_categories: ['Misc', 'Other'] }
            ]
        }

        const result = validateSchema(filler, { subfolderTarget: '5-10', bookmarkCount: 3000 })

        expect(result.ok).toBe(false)
        // Filler names are stripped, so both categories read as empty.
        expect(result.schema.categories.every(c => c.sub_categories.length === 0)).toBe(true)
    })

    it('enforces a different floor per granularity setting', () => {
        const twoSubs = {
            categories: [
                { name: 'Tech', sub_categories: ['Web Dev', 'AI'] },
                { name: 'Finance', sub_categories: ['Trading', 'Crypto'] },
                { name: 'Travel', sub_categories: ['Flights', 'Hotels'] }
            ]
        }

        expect(validateSchema(twoSubs, { subfolderTarget: '0-5', bookmarkCount: 3000 }).ok).toBe(true)
        expect(validateSchema(twoSubs, { subfolderTarget: '5-10', bookmarkCount: 3000 }).ok).toBe(false)
        expect(validateSchema(twoSubs, { subfolderTarget: '10+', bookmarkCount: 3000 }).ok).toBe(false)
    })

    it('relaxes the floor and the flatness check for tiny collections', () => {
        const oneSub = { categories: [{ name: 'Tech', sub_categories: ['Coding'] }] }

        expect(validateSchema(oneSub, { subfolderTarget: '10+', bookmarkCount: 12 }).ok).toBe(true)
        expect(validateSchema(oneSub, { subfolderTarget: '10+', bookmarkCount: 3000 }).ok).toBe(false)
    })

    it('exempts catch-all categories from the subcategory floor', () => {
        const withCatchAll = {
            categories: [
                ...healthySchema.categories,
                { name: 'Other', sub_categories: [] },
                { name: 'Archive', sub_categories: [] }
            ]
        }

        const result = validateSchema(withCatchAll, { subfolderTarget: '5-10', bookmarkCount: 3000 })

        expect(result.ok).toBe(true)
        expect(result.schema.categories.map(c => c.name)).toContain('Other')
    })

    it('flags a structure that is flat on average even when each category clears the floor', () => {
        const spread = {
            categories: [
                { name: 'A', sub_categories: ['A1'] },
                { name: 'B', sub_categories: ['B1'] },
                { name: 'C', sub_categories: ['C1'] }
            ]
        }

        const result = validateSchema(spread, { subfolderTarget: '0-5', bookmarkCount: 3000 })

        expect(result.ok).toBe(false)
        expect(result.issues.join(' ')).toMatch(/flat overall/)
    })

    it('normalizes names, drops duplicates and drops a subcategory echoing its parent', () => {
        const messy = {
            categories: [
                {
                    name: '  Tech & Development  ',
                    sub_categories: ['Web Dev', '  web dev ', 'Tech & Development', 'AI', '', null, 42, 'DevOps']
                },
                { name: 'Tech & Development', sub_categories: ['Duplicate Category'] },
                { name: '   ', sub_categories: ['Ignored'] }
            ]
        }

        const result = validateSchema(messy, { subfolderTarget: '0-5', bookmarkCount: 3000 })

        expect(result.schema.categories).toHaveLength(1)
        expect(result.schema.categories[0].name).toBe('Tech & Development')
        expect(result.schema.categories[0].sub_categories).toEqual(['Web Dev', 'AI', 'DevOps'])
    })
})

describe('salvagePartialJson', () => {
    it('closes brackets left open by a response cut off mid-array', () => {
        const truncated = '{"categories":[{"name":"Tech","sub_categories":["Web Dev","AI"'

        expect(salvagePartialJson(truncated)).toEqual({
            categories: [{ name: 'Tech', sub_categories: ['Web Dev', 'AI'] }]
        })
    })

    it('rewinds past a string that was cut off mid-token', () => {
        const truncated = '{"categories":[{"name":"Tech","sub_categories":["Web Dev","Machine Lear'

        expect(salvagePartialJson(truncated)).toEqual({
            categories: [{ name: 'Tech', sub_categories: ['Web Dev'] }]
        })
    })

    it('drops a trailing element that was only partially written', () => {
        const truncated = '{"categories":[{"name":"Tech","sub_categories":["AI"]},{"name":"Fin'

        expect(salvagePartialJson(truncated)).toEqual({
            categories: [{ name: 'Tech', sub_categories: ['AI'] }]
        })
    })

    it('strips markdown fences before repairing', () => {
        const truncated = '```json\n{"categories":[{"name":"Tech","sub_categories":["AI"'

        expect(salvagePartialJson(truncated)).toEqual({
            categories: [{ name: 'Tech', sub_categories: ['AI'] }]
        })
    })

    it('returns null when there is nothing recoverable', () => {
        expect(salvagePartialJson('')).toBeNull()
        expect(salvagePartialJson(null)).toBeNull()
        expect(salvagePartialJson('no json here at all')).toBeNull()
        expect(salvagePartialJson('{')).toBeNull()
    })
})

describe('generateSchema validation and corrective retry', () => {
    let originalFetch

    beforeEach(() => {
        originalFetch = global.fetch
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
        vi.useRealTimers()
    })

    it('returns the schema unchanged when the first response is already valid', async () => {
        global.fetch = vi.fn(async () => orResponse(JSON.stringify(healthySchema)))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', ['Tech'], undefined, '5-10')

        expect(global.fetch).toHaveBeenCalledTimes(1)
        expect(schema.categories).toHaveLength(3)
        expect(schema.categories[0].sub_categories).toContain('Trading & Markets')
    })

    it('re-prompts once when the model returns a flat schema, and accepts the correction', async () => {
        const flat = { categories: [{ name: 'Tech', sub_categories: [] }, { name: 'Finance', sub_categories: [] }] }
        global.fetch = vi.fn()
            .mockImplementationOnce(async () => orResponse(JSON.stringify(flat)))
            .mockImplementationOnce(async () => orResponse(JSON.stringify(healthySchema)))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', ['Tech'], undefined, '5-10')

        expect(global.fetch).toHaveBeenCalledTimes(2)
        expect(schema.categories).toHaveLength(3)

        const correctionPrompt = JSON.parse(global.fetch.mock.calls[1][1].body).messages[1].content
        expect(correctionPrompt).toContain('CORRECTION REQUIRED')
        expect(correctionPrompt).toMatch(/at least 5 distinct, specific subcategories/)
    })

    it('reports the correction attempt through onRetry', async () => {
        const flat = { categories: [{ name: 'Tech', sub_categories: [] }] }
        global.fetch = vi.fn()
            .mockImplementationOnce(async () => orResponse(JSON.stringify(flat)))
            .mockImplementationOnce(async () => orResponse(JSON.stringify(healthySchema)))

        const events = []
        await generateSchema(manyBookmarks, 'sk-or-test-key', ['Tech'], undefined, '5-10', null, (e) => events.push(e))

        expect(events).toHaveLength(1)
        expect(events[0].isSchemaCorrection).toBe(true)
        expect(events[0].isRateLimit).toBe(false)
    })

    it('throws a schemaInvalid error carrying the partial schema when the correction also fails', async () => {
        const flat = { categories: [{ name: 'Tech', sub_categories: [] }, { name: 'Finance', sub_categories: [] }] }
        global.fetch = vi.fn(async () => orResponse(JSON.stringify(flat)))

        await expect(
            generateSchema(manyBookmarks, 'sk-or-test-key', ['Tech'], undefined, '5-10')
        ).rejects.toMatchObject({
            schemaInvalid: true,
            partialSchema: { categories: [{ name: 'Tech', sub_categories: [] }, { name: 'Finance', sub_categories: [] }] }
        })

        expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('asks for the granularity-appropriate subcategory range and forbids filler names', async () => {
        const cases = [
            ['0-5', 'MUST define 3-5 concrete'],
            ['5-10', 'MUST define 5-10 concrete'],
            ['10+', 'MUST define 10-14 concrete']
        ]

        for (const [target, expected] of cases) {
            global.fetch = vi.fn(async () => orResponse(JSON.stringify(healthySchema)))
            await generateSchema(manyBookmarks, 'sk-or-test-key', ['Tech'], undefined, target)

            const prompt = JSON.parse(global.fetch.mock.calls[0][1].body).messages[1].content
            expect(prompt).toContain(expected)
            expect(prompt).toContain('is INVALID and will be rejected')
            expect(prompt).toMatch(/Never use "General", "Other", "Misc" or "Various" as a subcategory name/)
        }
    })

    it('requests the raised schema token ceiling', async () => {
        global.fetch = vi.fn(async () => orResponse(JSON.stringify(healthySchema)))

        await generateSchema(manyBookmarks, 'sk-or-test-key', ['Tech'])

        expect(JSON.parse(global.fetch.mock.calls[0][1].body).max_tokens).toBe(SCHEMA_MAX_TOKENS)
        expect(SCHEMA_MAX_TOKENS).toBe(16000)
    })
})

describe('classifyBatch hybrid subcategory proposals', () => {
    let originalFetch

    const classifyResponse = (classified) =>
        orResponse(JSON.stringify({ classified }))

    const threeBookmarks = [
        { title: 'A', url: 'https://a.example.com' },
        { title: 'B', url: 'https://b.example.com' },
        { title: 'C', url: 'https://c.example.com' }
    ]

    beforeEach(() => {
        originalFetch = global.fetch
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
    })

    it('keeps a sub_category absent from the schema and flags it as proposed', async () => {
        global.fetch = vi.fn(async () => classifyResponse([
            { i: 0, category: 'Tech & Development', sub_category: 'Web Development' },
            { i: 1, category: 'Tech & Development', sub_category: 'Rust Ecosystem' },
            { i: 2, category: 'Tech & Development', sub_category: 'Rust Ecosystem' }
        ]))

        const result = await classifyBatch(threeBookmarks, 'sk-or-test-key', healthySchema)

        expect(result[0].sub_category).toBe('Web Development')
        expect(result[0].proposed).toBeUndefined()

        expect(result[1].sub_category).toBe('Rust Ecosystem')
        expect(result[1].proposed).toBe(true)
        expect(result[2].proposed).toBe(true)
    })

    it('matches schema sub-categories case-insensitively rather than calling them proposed', async () => {
        global.fetch = vi.fn(async () => classifyResponse([
            { i: 0, category: 'Tech & Development', sub_category: '  web development  ' },
            { i: 1, category: 'tech & development', sub_category: 'Databases' },
            { i: 2, category: 'Tech & Development', sub_category: 'Security' }
        ]))

        const result = await classifyBatch(threeBookmarks, 'sk-or-test-key', healthySchema)

        expect(result.every(r => r.proposed === undefined)).toBe(true)
        expect(result[0].sub_category).toBe('web development')
    })

    it('emits the schema spelling of a category the model wrote in another casing', async () => {
        global.fetch = vi.fn(async () => classifyResponse([
            { i: 0, category: 'Tech & Development', sub_category: 'Databases' },
            { i: 1, category: 'tech & development', sub_category: 'Databases' },
            { i: 2, category: 'TECH & DEVELOPMENT', sub_category: 'Security' }
        ]))

        const result = await classifyBatch(threeBookmarks, 'sk-or-test-key', healthySchema)

        // Two spellings of one category would otherwise become two sibling
        // top-level folders, each holding a partial set of the bookmarks.
        expect(new Set(result.map(r => r.category))).toEqual(new Set(['Tech & Development']))
    })

    it('coerces an invented category to Other/General', async () => {
        global.fetch = vi.fn(async () => classifyResponse([
            { i: 0, category: 'Totally Made Up', sub_category: 'Something' },
            { i: 1, category: 'Tech & Development', sub_category: 'Databases' },
            { i: 2, category: 'Tech & Development', sub_category: 'Security' }
        ]))

        const result = await classifyBatch(threeBookmarks, 'sk-or-test-key', healthySchema)

        expect(result[0].category).toBe('Other')
        expect(result[0].sub_category).toBe('General')
        expect(result[0].proposed).toBeUndefined()
    })

    it('never marks General as proposed, and fills in missing entries', async () => {
        global.fetch = vi.fn(async () => classifyResponse([
            { i: 0, category: 'Tech & Development', sub_category: 'General' }
            // indexes 1 and 2 omitted entirely by the model
        ]))

        const result = await classifyBatch(threeBookmarks, 'sk-or-test-key', healthySchema)

        expect(result).toHaveLength(3)
        expect(result[0]).toMatchObject({ category: 'Tech & Development', sub_category: 'General' })
        expect(result[0].proposed).toBeUndefined()
        expect(result[1]).toMatchObject({ category: 'Other', sub_category: 'General' })
        expect(result[2]).toMatchObject({ category: 'Other', sub_category: 'General' })
    })

    it('preserves clean titles and source fields alongside a proposed subcategory', async () => {
        global.fetch = vi.fn(async () => classifyResponse([
            { i: 0, category: 'Finance & Crypto', sub_category: 'Options Trading', clean_title: '  Barchart Options  ' }
        ]))

        const source = [{ title: 'Barchart Options Screener | barchart.com', url: 'https://barchart.com', icon: 'data:image/png;base64,AA', add_date: '1700000000' }]
        const result = await classifyBatch(source, 'sk-or-test-key', healthySchema, undefined, true)

        expect(result[0]).toMatchObject({
            title: 'Barchart Options',
            url: 'https://barchart.com',
            icon: 'data:image/png;base64,AA',
            add_date: '1700000000',
            category: 'Finance & Crypto',
            sub_category: 'Options Trading',
            proposed: true
        })
    })

    it('instructs the model that categories are fixed but sub-categories may be proposed', async () => {
        global.fetch = vi.fn(async () => classifyResponse([]))

        await classifyBatch(threeBookmarks, 'sk-or-test-key', healthySchema)

        const prompt = JSON.parse(global.fetch.mock.calls[0][1].body).messages[1].content
        expect(prompt).toContain('CATEGORY is fixed')
        expect(prompt).toContain('Never invent a new category')
        expect(prompt).toMatch(/at least 3 bookmarks in THIS batch share a clear, specific theme/)
        expect(prompt).toMatch(/Use "General" as the sub_category ONLY when/)
    })
})

describe('truncation handling differs between schema design and classification', () => {
    let originalFetch

    beforeEach(() => {
        originalFetch = global.fetch
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
        vi.useRealTimers()
    })

    it('salvages a truncated schema response instead of burning retries on it', async () => {
        const truncated = '{"categories":[{"name":"Finance","sub_categories":["Trading","Crypto","Investing"]},'
            + '{"name":"Tech","sub_categories":["Web Dev","AI","DevOps"]},'
            + '{"name":"Travel","sub_categories":["Flights","Hotels","Guides"]},'
            + '{"name":"Heal'
        global.fetch = vi.fn(async () => orResponse(truncated, 'length'))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', ['Finance'], undefined, '0-5')

        expect(global.fetch).toHaveBeenCalledTimes(1)
        // The three complete categories survive; the half-written fourth is dropped.
        expect(schema.categories.map(c => c.name)).toEqual(['Finance', 'Tech', 'Travel'])
    })

    it('re-prompts when a salvaged schema is too narrow to classify the collection against', async () => {
        // Cut off after category 2 of a 6-category ask: structurally valid but
        // it would coerce every other bookmark to "Other / General".
        const truncated = '{"categories":[{"name":"Finance","sub_categories":["Trading","Crypto","Investing"]},'
            + '{"name":"Tech","sub_categories":["Web Dev","AI","DevOp'
        const sixCategories = ['Finance', 'Tech', 'Travel', 'Health', 'Design', 'Shopping']

        global.fetch = vi.fn()
            .mockImplementationOnce(async () => orResponse(truncated, 'length'))
            .mockImplementationOnce(async () => orResponse(JSON.stringify(healthySchema)))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', sixCategories, undefined, '0-5')

        expect(global.fetch).toHaveBeenCalledTimes(2)
        expect(JSON.parse(global.fetch.mock.calls[1][1].body).messages[1].content)
            .toMatch(/covered only 2 categories; at least 3 are needed/)
        expect(schema.categories).toHaveLength(3)
    })

    it('still retries a truncated schema when nothing can be recovered', async () => {
        global.fetch = vi.fn()
            .mockImplementationOnce(async () => orResponse('totally unparseable', 'length'))
            .mockImplementationOnce(async () => orResponse(JSON.stringify(healthySchema)))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', ['Tech'], undefined, '5-10')

        expect(global.fetch).toHaveBeenCalledTimes(2)
        expect(schema.categories).toHaveLength(3)
    })

    it('never salvages a truncated classification batch, since the tail would be lost bookmarks', async () => {
        vi.useFakeTimers()

        const truncated = '{"classified":[{"i":0,"category":"Tech","sub_category":"Web Dev"'
        global.fetch = vi.fn(async () => orResponse(truncated, 'length'))

        let cancelled = false
        const retryEvents = []

        const promise = classifyBatch(
            [{ title: 'Example', url: 'https://example.com' }],
            'sk-or-test-key',
            healthySchema,
            'google/gemini-3.1-flash-lite',
            false,
            () => cancelled,
            (evt) => {
                retryEvents.push(evt)
                cancelled = true
            }
        )
        const rejection = expect(promise).rejects.toMatchObject({ isCancelled: true })

        await vi.advanceTimersByTimeAsync(200)
        await rejection

        // A retry was scheduled, proving the truncated body was rejected rather than salvaged.
        expect(retryEvents).toHaveLength(1)
        expect(retryEvents[0].error.message).toMatch(/cut off/)
    })
})

describe('native Gemini response path', () => {
    let originalFetch

    const geminiBody = (call) => JSON.parse(call[1].body)

    beforeEach(() => {
        originalFetch = global.fetch
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
        vi.useRealTimers()
    })

    it('salvages a schema cut off at MAX_TOKENS rather than burning a retry', async () => {
        const truncated = '{"categories":[{"name":"Finance","sub_categories":["Trading","Crypto","Investing"]},'
            + '{"name":"Tech","sub_categories":["Web Dev","AI","DevOps"]},'
            + '{"name":"Travel","sub_categories":["Flights","Hotels","Guides"]},'
            + '{"name":"Heal'
        global.fetch = vi.fn(async () => geminiResponse([truncated], 'MAX_TOKENS'))

        const schema = await generateSchema(manyBookmarks, GEMINI_KEY, ['Finance'], undefined, '0-5')

        expect(global.fetch).toHaveBeenCalledTimes(1)
        expect(schema.categories.map(c => c.name)).toEqual(['Finance', 'Tech', 'Travel'])
    })

    it('reassembles a response split across several content parts', async () => {
        const whole = JSON.stringify(healthySchema)
        const parts = [whole.slice(0, 40), whole.slice(40, 200), whole.slice(200)]
        global.fetch = vi.fn(async () => geminiResponse(parts))

        const schema = await generateSchema(manyBookmarks, GEMINI_KEY, ['Tech'], undefined, '5-10')

        expect(global.fetch).toHaveBeenCalledTimes(1)
        expect(schema.categories).toHaveLength(3)
    })

    it('treats a safety block as permanent and does not retry it', async () => {
        global.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } })
        }))

        await expect(
            generateSchema(manyBookmarks, GEMINI_KEY, ['Tech'], undefined, '5-10')
        ).rejects.toThrow(/Gemini blocked the request \(SAFETY\)/)

        expect(global.fetch).toHaveBeenCalledTimes(1)
    })

    it('sends the bare model id and a JSON generationConfig', async () => {
        global.fetch = vi.fn(async () => geminiResponse([JSON.stringify(healthySchema)]))

        await generateSchema(manyBookmarks, GEMINI_KEY, ['Tech'], 'google/gemini-3.1-flash-lite', '5-10')

        const [url, options] = global.fetch.mock.calls[0]
        expect(url).toContain('/v1beta/models/gemini-3.1-flash-lite:generateContent')
        expect(options.headers).not.toHaveProperty('Authorization')

        const body = geminiBody(global.fetch.mock.calls[0])
        expect(body.generationConfig).toMatchObject({
            maxOutputTokens: SCHEMA_MAX_TOKENS,
            responseMimeType: 'application/json'
        })
        expect(body.system_instruction.parts[0].text).toMatch(/information architect/)
    })

    it('never salvages a classification batch cut off at MAX_TOKENS', async () => {
        vi.useFakeTimers()

        const truncated = '{"classified":[{"i":0,"category":"Tech & Development","sub_category":"Web Development"'
        global.fetch = vi.fn(async () => geminiResponse([truncated], 'MAX_TOKENS'))

        let cancelled = false
        const retryEvents = []

        const promise = classifyBatch(
            [{ title: 'Example', url: 'https://example.com' }],
            GEMINI_KEY,
            healthySchema,
            'google/gemini-3.1-flash-lite',
            false,
            () => cancelled,
            (evt) => {
                retryEvents.push(evt)
                cancelled = true
            }
        )
        const rejection = expect(promise).rejects.toMatchObject({ isCancelled: true })

        await vi.advanceTimersByTimeAsync(200)
        await rejection

        expect(retryEvents).toHaveLength(1)
        expect(retryEvents[0].error.message).toMatch(/cut off/)
    })
})
