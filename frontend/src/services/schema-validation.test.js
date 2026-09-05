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
// granularity floor, including the strictest ('10+' requires 5).
const healthySchema = {
    categories: [
        { name: 'Finance & Crypto', sub_categories: ['Trading & Markets', 'Crypto & Blockchain', 'Investing & Wealth', 'Banking & Payments', 'Tax & Economics'] },
        { name: 'Tech & Development', sub_categories: ['Web Development', 'AI & Machine Learning', 'DevOps & Cloud', 'Databases', 'Security'] }
    ]
}

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
        expect(result.schema.categories).toHaveLength(2)
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
                { name: 'Finance', sub_categories: ['Trading', 'Crypto'] }
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
        expect(schema.categories).toHaveLength(2)
        expect(schema.categories[0].sub_categories).toContain('Trading & Markets')
    })

    it('re-prompts once when the model returns a flat schema, and accepts the correction', async () => {
        const flat = { categories: [{ name: 'Tech', sub_categories: [] }, { name: 'Finance', sub_categories: [] }] }
        global.fetch = vi.fn()
            .mockImplementationOnce(async () => orResponse(JSON.stringify(flat)))
            .mockImplementationOnce(async () => orResponse(JSON.stringify(healthySchema)))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', ['Tech'], undefined, '5-10')

        expect(global.fetch).toHaveBeenCalledTimes(2)
        expect(schema.categories).toHaveLength(2)

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
        const truncated = '{"categories":[{"name":"Finance","sub_categories":["Trading","Crypto","Investing"]},{"name":"Tech","sub_categories":["Web Dev","AI","DevOp'
        global.fetch = vi.fn(async () => orResponse(truncated, 'length'))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', ['Finance'], undefined, '0-5')

        expect(global.fetch).toHaveBeenCalledTimes(1)
        expect(schema.categories).toHaveLength(2)
        expect(schema.categories[1].sub_categories).toEqual(['Web Dev', 'AI'])
    })

    it('still retries a truncated schema when nothing can be recovered', async () => {
        global.fetch = vi.fn()
            .mockImplementationOnce(async () => orResponse('totally unparseable', 'length'))
            .mockImplementationOnce(async () => orResponse(JSON.stringify(healthySchema)))

        const schema = await generateSchema(manyBookmarks, 'sk-or-test-key', ['Tech'], undefined, '5-10')

        expect(global.fetch).toHaveBeenCalledTimes(2)
        expect(schema.categories).toHaveLength(2)
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
