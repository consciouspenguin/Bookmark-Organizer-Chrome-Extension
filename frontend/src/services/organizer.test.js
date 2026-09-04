import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { removeDuplicateUrls, checkUrlReachable, filterReachableBookmarks, OrganizerService } from './organizer'
import * as ai from './ai'
import { classifyBatch, generateSchema, withRetry, geminiModelId } from './ai'
import * as bookmarksExport from './bookmarks_export'

describe('removeDuplicateUrls', () => {
    it('keeps the first bookmark for each exact URL', () => {
        const bookmarks = [
            { title: 'First', url: 'https://example.com' },
            { title: 'Second', url: 'https://example.com' },
            { title: 'Different', url: 'https://example.com/page' }
        ]

        expect(removeDuplicateUrls(bookmarks)).toEqual([
            { title: 'First', url: 'https://example.com' },
            { title: 'Different', url: 'https://example.com/page' }
        ])
    })
})

describe('checkUrlReachable', () => {
    it('returns false for invalid or non-http URLs', async () => {
        expect(await checkUrlReachable('')).toBe(false)
        expect(await checkUrlReachable(null)).toBe(false)
        expect(await checkUrlReachable('ftp://example.com')).toBe(false)
        expect(await checkUrlReachable('chrome://bookmarks')).toBe(false)
    })
})

describe('filterReachableBookmarks', () => {
    const originalFetch = global.fetch

    afterEach(() => {
        global.fetch = originalFetch
    })

    it('isolates dead links under Archive -> Broken Links', async () => {
        global.fetch = vi.fn(async (url) => {
            if (url.includes('dead-domain.com')) {
                throw new Error('DNS resolution failed')
            }
            return { ok: true }
        })

        const bookmarks = [
            { title: 'Working Link', url: 'https://example.com' },
            { title: 'Dead Link', url: 'https://dead-domain.com' }
        ]

        const progressCalls = []
        const onProgress = (msg) => progressCalls.push(msg)

        const { activeLinks, deadLinks } = await filterReachableBookmarks(
            bookmarks,
            onProgress,
            () => false
        )

        expect(activeLinks).toEqual([
            { title: 'Working Link', url: 'https://example.com' }
        ])
        expect(deadLinks).toEqual([
            {
                title: 'Dead Link',
                url: 'https://dead-domain.com',
                category: 'Archive',
                sub_category: 'Broken Links'
            }
        ])
    })
})

describe('OrganizerService adaptive batch sizes', () => {
    it('uses larger batch sizes up to 50 for faster processing with Flash models', () => {
        const service = new OrganizerService('test-key', [], () => {}, 'google/gemini-3.8-flash')

        expect(service.calculateAdaptiveBatchSize(30)).toBe(30)
        expect(service.calculateAdaptiveBatchSize(150)).toBe(45)
        expect(service.calculateAdaptiveBatchSize(600)).toBe(50)
    })
})

describe('classifyBatch cleanTitles option', () => {
    const originalFetch = global.fetch

    afterEach(() => {
        global.fetch = originalFetch
    })

    const sampleBookmarks = [
        { title: 'GitHub - Where software is built', url: 'https://github.com' },
        { title: 'Wikipedia, the free encyclopedia', url: 'https://wikipedia.org' },
        { title: 'Clean Blog', url: 'https://cleanblog.com' }
    ]

    const sampleSchema = {
        categories: [
            { name: 'Development', sub_categories: ['Tools'] },
            { name: 'Reference', sub_categories: ['General'] }
        ]
    }

    it('retains original titles when cleanTitles is false or omitted', async () => {
        let capturedBody = null
        global.fetch = vi.fn(async (url, options) => {
            capturedBody = JSON.parse(options.body)
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    classified: [
                                        { i: 0, category: 'Development', sub_category: 'Tools', clean_title: 'GitHub' },
                                        { i: 1, category: 'Reference', sub_category: 'General', clean_title: 'Wikipedia' },
                                        { i: 2, category: 'Other', sub_category: 'General', clean_title: 'Clean Blog' }
                                    ]
                                })
                            }
                        }
                    ]
                })
            }
        })

        // Test with cleanTitles omitted (default: false)
        const resultDefault = await classifyBatch(sampleBookmarks, 'sk-or-test-key', sampleSchema)
        expect(resultDefault[0].title).toBe('GitHub - Where software is built')
        expect(resultDefault[1].title).toBe('Wikipedia, the free encyclopedia')
        expect(resultDefault[2].title).toBe('Clean Blog')
        expect(capturedBody.messages[1].content).not.toContain('6. Title cleanup')
        expect(capturedBody.messages[1].content).toContain('{ "classified": [ { "i": 0, "category": "...", "sub_category": "..." } ] }')
        expect(capturedBody.messages[1].content).not.toContain('"clean_title"')

        // Test with cleanTitles explicitly false
        const resultFalse = await classifyBatch(sampleBookmarks, 'sk-or-test-key', sampleSchema, 'google/gemini-3.1-flash-lite', false)
        expect(resultFalse[0].title).toBe('GitHub - Where software is built')
        expect(resultFalse[1].title).toBe('Wikipedia, the free encyclopedia')
        expect(resultFalse[2].title).toBe('Clean Blog')
    })

    it('maps clean_title to title when cleanTitles is true and clean_title is non-empty string', async () => {
        let capturedBody = null
        global.fetch = vi.fn(async (url, options) => {
            capturedBody = JSON.parse(options.body)
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    classified: [
                                        { i: 0, category: 'Development', sub_category: 'Tools', clean_title: '  GitHub  ' },
                                        { i: 1, category: 'Reference', sub_category: 'General', clean_title: '   ' },
                                        { i: 2, category: 'Other', sub_category: 'General' }
                                    ]
                                })
                            }
                        }
                    ]
                })
            }
        })

        const result = await classifyBatch(sampleBookmarks, 'sk-or-test-key', sampleSchema, 'google/gemini-3.1-flash-lite', true)

        // Bookmark 0 has valid clean_title -> trimmed clean_title
        expect(result[0].title).toBe('GitHub')
        expect(result[0].category).toBe('Development')
        expect(result[0].sub_category).toBe('Tools')

        // Bookmark 1 has whitespace-only clean_title -> retains original title
        expect(result[1].title).toBe('Wikipedia, the free encyclopedia')
        expect(result[1].category).toBe('Reference')
        expect(result[1].sub_category).toBe('General')

        // Bookmark 2 has no clean_title -> retains original title
        expect(result[2].title).toBe('Clean Blog')
        expect(result[2].category).toBe('Other')
        expect(result[2].sub_category).toBe('General')

        // Verify prompt contains title cleanup instructions and updated example return schema
        expect(capturedBody.messages[1].content).toContain('6. Title cleanup: If clean_title is requested')
        expect(capturedBody.messages[1].content).toContain('{ "classified": [ { "i": 0, "category": "...", "sub_category": "...", "clean_title": "..." } ] }')
    })
})

describe('OrganizerService cleanTitles integration', () => {
    let originalFetch

    beforeEach(() => {
        originalFetch = global.fetch
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
    })

    it('defaults cleanTitles to false when omitted', () => {
        const service = new OrganizerService('test-key', [], () => {})
        expect(service.cleanTitles).toBe(false)
    })

    it('stores cleanTitles as true when passed in constructor', () => {
        const service = new OrganizerService('test-key', [], () => {}, 'google/gemini-3.1-flash-lite', '5-10', true, true, true)
        expect(service.cleanTitles).toBe(true)
    })

    it('passes cleanTitles as false by default to classifyBatch during start()', async () => {
        global.fetch = vi.fn(async () => ({ ok: true }))

        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: ['Coding'] }]
        })
        const classifyBatchSpy = vi.spyOn(ai, 'classifyBatch').mockResolvedValue([
            { title: 'Original Tech', url: 'https://example.com', category: 'Tech', sub_category: 'Coding' }
        ])

        const service = new OrganizerService('test-key', ['Tech'], () => {})

        const bookmarks = [{ title: 'Original Tech', url: 'https://example.com' }]
        await service.start(bookmarks)

        expect(classifyBatchSpy).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ url: 'https://example.com' })]),
            'test-key',
            expect.any(Object),
            'google/gemini-3.1-flash-lite',
            false,
            expect.any(Function),
            expect.any(Function)
        )
    })

    it('passes cleanTitles to classifyBatch during start() in main worker pass', async () => {
        global.fetch = vi.fn(async () => ({ ok: true }))

        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: ['Coding'] }]
        })
        const classifyBatchSpy = vi.spyOn(ai, 'classifyBatch').mockResolvedValue([
            { title: 'Clean Tech', url: 'https://example.com', category: 'Tech', sub_category: 'Coding' }
        ])

        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            true
        )

        const bookmarks = [{ title: 'Messy Tech Site', url: 'https://example.com' }]
        await service.start(bookmarks)

        expect(classifyBatchSpy).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ url: 'https://example.com' })]),
            'test-key',
            expect.any(Object),
            'google/gemini-3.1-flash-lite',
            true,
            expect.any(Function),
            expect.any(Function)
        )
    })

    it('passes cleanTitles to classifyBatch during retry pass for failed batches', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        global.fetch = vi.fn(async () => ({ ok: true }))

        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: ['Coding'] }]
        })
        // First call fails (triggering retry pass), second call succeeds
        const classifyBatchSpy = vi.spyOn(ai, 'classifyBatch')
            .mockRejectedValueOnce(new Error('Rate limit or network drop'))
            .mockResolvedValueOnce([
                { title: 'Clean Tech', url: 'https://example.com', category: 'Tech', sub_category: 'Coding' }
            ])

        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            true
        )

        const bookmarks = [{ title: 'Messy Tech Site', url: 'https://example.com' }]
        await service.start(bookmarks)

        // classifyBatch should have been called twice: initial pass and retry pass
        expect(classifyBatchSpy).toHaveBeenCalledTimes(2)
        // Both calls must have received cleanTitles = true as the 5th argument
        expect(classifyBatchSpy).toHaveBeenNthCalledWith(
            1,
            expect.any(Array),
            'test-key',
            expect.any(Object),
            'google/gemini-3.1-flash-lite',
            true,
            expect.any(Function),
            expect.any(Function)
        )
        expect(classifyBatchSpy).toHaveBeenNthCalledWith(
            2,
            expect.any(Array),
            'test-key',
            expect.any(Object),
            'google/gemini-3.1-flash-lite',
            true,
            expect.any(Function),
            expect.any(Function)
        )
    })
})

describe('withRetry resilient retry and cancellation', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('retries rate-limit errors up to 8 attempts with progressive backoff and caps at 60s', async () => {
        const rateLimitError = new Error('Resource exhausted / quota exceeded')
        rateLimitError.statusCode = 429

        const fn = vi.fn().mockRejectedValue(rateLimitError)
        const onRetry = vi.fn()

        const promise = withRetry(fn, 5, 1500, null, onRetry)
        const rejection = expect(promise).rejects.toThrow('Resource exhausted / quota exceeded')

        await vi.runAllTimersAsync()
        await rejection

        // 8 total attempts
        expect(fn).toHaveBeenCalledTimes(8)
        // 7 retry notifications
        expect(onRetry).toHaveBeenCalledTimes(7)

        for (let i = 0; i < 7; i++) {
            const call = onRetry.mock.calls[i][0]
            expect(call.attempt).toBe(i + 1)
            expect(call.isRateLimit).toBe(true)
            expect(call.error).toBe(rateLimitError)
            expect(call.delayMs).toBeLessThanOrEqual(60000)

            if (i === 0) {
                // 5000 * 1.8^0 * [0.8, 1.2] = 4000 to 6000
                expect(call.delayMs).toBeGreaterThanOrEqual(4000)
                expect(call.delayMs).toBeLessThanOrEqual(6000)
            }
        }
    })

    it('respects error.retryAfterMs when provided on rate-limit errors', async () => {
        const rateLimitError = new Error('Too many requests')
        rateLimitError.statusCode = 429
        rateLimitError.retryAfterMs = 12500

        const fn = vi.fn()
            .mockRejectedValueOnce(rateLimitError)
            .mockResolvedValueOnce({ success: true })
        const onRetry = vi.fn()

        const promise = withRetry(fn, 5, 1500, null, onRetry)
        await vi.runAllTimersAsync()
        const result = await promise

        expect(result).toEqual({ success: true })
        expect(fn).toHaveBeenCalledTimes(2)
        expect(onRetry).toHaveBeenCalledWith({
            attempt: 1,
            delayMs: 12500,
            error: rateLimitError,
            isRateLimit: true
        })
    })

    it('uses standard exponential backoff up to maxRetries (5) for other retryable errors', async () => {
        const serverError = new Error('Internal Server Error')
        serverError.statusCode = 500

        const fn = vi.fn().mockRejectedValue(serverError)
        const onRetry = vi.fn()

        const promise = withRetry(fn, 5, 1500, null, onRetry)
        const rejection = expect(promise).rejects.toThrow('Internal Server Error')

        await vi.runAllTimersAsync()
        await rejection

        expect(fn).toHaveBeenCalledTimes(5)
        expect(onRetry).toHaveBeenCalledTimes(4)
        onRetry.mock.calls.forEach(call => {
            expect(call[0].isRateLimit).toBe(false)
        })
    })

    it('throws immediately on non-retryable errors without retrying', async () => {
        const badRequestError = new Error('Bad Request')
        badRequestError.statusCode = 400

        const fn = vi.fn().mockRejectedValue(badRequestError)
        const onRetry = vi.fn()

        await expect(withRetry(fn, 5, 1500, null, onRetry)).rejects.toThrow('Bad Request')
        expect(fn).toHaveBeenCalledTimes(1)
        expect(onRetry).not.toHaveBeenCalled()
    })

    it('aborts backoff sleep immediately when isCancelled returns true', async () => {
        const error = new Error('Temporary gateway error')
        error.statusCode = 502

        let cancelled = false
        const isCancelled = () => cancelled

        const fn = vi.fn().mockRejectedValue(error)
        const onRetry = vi.fn(() => {
            // Cancel as soon as we enter the retry backoff
            cancelled = true
        })

        const promise = withRetry(fn, 5, 1500, isCancelled, onRetry)
        const rejection = expect(promise).rejects.toMatchObject({
            message: 'Operation cancelled.',
            isCancelled: true
        })

        // Advance only one 200ms sleep tick
        await vi.advanceTimersByTimeAsync(200)
        await rejection

        expect(fn).toHaveBeenCalledTimes(1)
    })
})

describe('classifyBatch and generateSchema default model and cancellation forwarding', () => {
    const originalFetch = global.fetch

    afterEach(() => {
        global.fetch = originalFetch
        vi.useRealTimers()
    })

    it('defaults model to google/gemini-3.1-flash-lite in classifyBatch', async () => {
        let capturedPayload = null
        global.fetch = vi.fn(async (url, options) => {
            capturedPayload = JSON.parse(options.body)
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    classified: [{ i: 0, category: 'Tech', sub_category: 'Code' }]
                                })
                            }
                        }
                    ]
                })
            }
        })

        const bookmarks = [{ title: 'Code Site', url: 'https://code.example.com' }]
        const schema = { categories: [{ name: 'Tech', sub_categories: ['Code'] }] }

        await classifyBatch(bookmarks, 'sk-or-test-key', schema)

        expect(capturedPayload.model).toBe('google/gemini-3.1-flash-lite')
    })

    it('defaults model to google/gemini-3.1-flash-lite in generateSchema', async () => {
        let capturedPayload = null
        global.fetch = vi.fn(async (url, options) => {
            capturedPayload = JSON.parse(options.body)
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    categories: [{ name: 'Tech', sub_categories: ['General'] }]
                                })
                            }
                        }
                    ]
                })
            }
        })

        const bookmarks = [{ title: 'Code Site', url: 'https://code.example.com' }]
        await generateSchema(bookmarks, 'sk-or-test-key', ['Tech'])

        expect(capturedPayload.model).toBe('google/gemini-3.1-flash-lite')
    })

    it('forwards isCancelled and onRetry from classifyBatch to withRetry', async () => {
        vi.useFakeTimers()

        global.fetch = vi.fn(async () => ({
            ok: false,
            status: 429,
            text: async () => 'Rate limit reached'
        }))

        let cancelled = false
        const retryEvents = []

        const bookmarks = [{ title: 'Example', url: 'https://example.com' }]
        const schema = { categories: [{ name: 'General', sub_categories: [] }] }

        const promise = classifyBatch(
            bookmarks,
            'sk-or-test-key',
            schema,
            'google/gemini-3.1-flash-lite',
            false,
            () => cancelled,
            (evt) => {
                retryEvents.push(evt)
                cancelled = true
            }
        )
        const rejection = expect(promise).rejects.toMatchObject({
            message: 'Operation cancelled.',
            isCancelled: true
        })

        await vi.advanceTimersByTimeAsync(200)
        await rejection

        expect(retryEvents.length).toBe(1)
        expect(retryEvents[0].isRateLimit).toBe(true)
    })
})

describe('OrganizerService resilient batch processing and sub-batch subdivision', () => {
    let originalFetch

    beforeEach(() => {
        originalFetch = global.fetch
        global.fetch = vi.fn(async () => ({ ok: true }))
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
    })

    it('defaults model to google/gemini-3.1-flash-lite in constructor', () => {
        const service = new OrganizerService('test-key', ['Tech'], () => {})
        expect(service.model).toBe('google/gemini-3.1-flash-lite')
    })

    it('subdivides failing batches in half recursively on retry until classification succeeds without dumping to Other -> General', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})

        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Engineering', sub_categories: ['Frontend', 'Backend'] }]
        })

        const bookmarks = Array.from({ length: 10 }, (_, i) => ({
            title: `Bookmark ${i + 1}`,
            url: `https://example.com/${i + 1}`
        }))

        const progressMessages = []
        const onProgress = (evt) => {
            if (evt?.message) progressMessages.push(evt.message)
        }

        const classifyBatchSpy = vi.spyOn(ai, 'classifyBatch')
            // 1. Initial worker pass fails for all 10 items
            .mockRejectedValueOnce(new Error('Payload size limit or malformed output'))
            // 2. Retry pass on full 10 items fails again
            .mockRejectedValueOnce(new Error('Still failing with full batch'))
            // 3. Sub-batch 1 (items 1..5) succeeds
            .mockResolvedValueOnce(
                bookmarks.slice(0, 5).map(b => ({ ...b, category: 'Engineering', sub_category: 'Frontend' }))
            )
            // 4. Sub-batch 2 (items 6..10) succeeds
            .mockResolvedValueOnce(
                bookmarks.slice(5).map(b => ({ ...b, category: 'Engineering', sub_category: 'Backend' }))
            )

        const service = new OrganizerService('test-key', ['Engineering'], onProgress)
        const results = await service.start(bookmarks)

        // classifyBatch called 4 times: initial, retry-full, sub-batch 1, sub-batch 2
        expect(classifyBatchSpy).toHaveBeenCalledTimes(4)

        // Progress message logged sub-batch split
        const splitMsg = progressMessages.find(m => m.includes('Splitting batch 1 (10 items) into smaller chunks of 5'))
        expect(splitMsg).toBeDefined()

        // 100% of bookmarks classified cleanly — none dumped to Other -> General
        expect(results).toHaveLength(10)
        expect(results.every(b => b.category === 'Engineering')).toBe(true)
        expect(results.some(b => b.category === 'Other')).toBe(false)
        expect(results.some(b => b.sub_category === 'General')).toBe(false)
        expect(results.filter(b => b.sub_category === 'Frontend')).toHaveLength(5)
        expect(results.filter(b => b.sub_category === 'Backend')).toHaveLength(5)
    })

    it('falls back to Other -> General only when batch size <= 5 and still fails on retry', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})

        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Engineering', sub_categories: [] }]
        })

        const bookmarks = Array.from({ length: 4 }, (_, i) => ({
            title: `Bookmark ${i + 1}`,
            url: `https://example.com/${i + 1}`
        }))

        const progressMessages = []
        const onProgress = (evt) => {
            if (evt?.message) progressMessages.push(evt.message)
        }

        // Both initial pass and retry pass fail
        vi.spyOn(ai, 'classifyBatch')
            .mockRejectedValueOnce(new Error('Unrecoverable parsing failure'))
            .mockRejectedValueOnce(new Error('Unrecoverable parsing failure'))

        const service = new OrganizerService('test-key', ['Engineering'], onProgress)
        const results = await service.start(bookmarks)

        expect(results).toHaveLength(4)
        // All 4 filed under Other -> General so none are lost
        expect(results.every(b => b.category === 'Other' && b.sub_category === 'General')).toBe(true)

        const fallbackMsg = progressMessages.find(m => m.includes('Its 4 bookmarks were filed under Other → General so none are lost.'))
        expect(fallbackMsg).toBeDefined()
    })

    it('immediately stops processing and returns null when cancelled during schema generation', async () => {
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})

        const progressEvents = []
        const onProgress = (evt) => progressEvents.push(evt)

        const service = new OrganizerService('test-key', ['Tech'], onProgress)

        vi.spyOn(ai, 'generateSchema').mockImplementation(async () => {
            service.cancel()
            const err = new Error('Operation cancelled.')
            err.isCancelled = true
            throw err
        })
        const classifyBatchSpy = vi.spyOn(ai, 'classifyBatch')

        const bookmarks = [{ title: 'Site', url: 'https://example.com' }]
        const result = await service.start(bookmarks)

        expect(result).toBeNull()
        expect(classifyBatchSpy).not.toHaveBeenCalled()
        expect(progressEvents).toContainEqual({ status: 'warning', message: 'Process cancelled.' })
    })

    it('immediately stops processing and returns null when cancelled during batch classification', async () => {
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: [] }]
        })

        const progressEvents = []
        const onProgress = (evt) => progressEvents.push(evt)

        const service = new OrganizerService('test-key', ['Tech'], onProgress)

        vi.spyOn(ai, 'classifyBatch').mockImplementation(async () => {
            service.cancel()
            return [{ title: 'Site', url: 'https://example.com', category: 'Tech', sub_category: 'General' }]
        })

        const bookmarks = [{ title: 'Site', url: 'https://example.com' }]
        const result = await service.start(bookmarks)

        expect(result).toBeNull()
        expect(bookmarksExport.downloadBookmarks).not.toHaveBeenCalled()
        expect(progressEvents).toContainEqual({ status: 'warning', message: 'Process cancelled.' })
    })

    it('reports rate limit and network retry notifications to onProgress callback', async () => {
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: [] }]
        })

        const progressEvents = []
        const onProgress = (evt) => progressEvents.push(evt)

        const service = new OrganizerService('test-key', ['Tech'], onProgress)

        vi.spyOn(ai, 'classifyBatch').mockImplementation(async (b, key, sch, m, c, isCanc, onRetry) => {
            // Simulate rate-limit notification from withRetry
            onRetry({ attempt: 1, delayMs: 8000, isRateLimit: true, error: new Error('Rate limit') })
            // Simulate network issue notification
            onRetry({ attempt: 2, delayMs: 3000, isRateLimit: false, error: new Error('Network error') })
            return [{ title: 'Site', url: 'https://example.com', category: 'Tech', sub_category: 'General' }]
        })

        const bookmarks = [{ title: 'Site', url: 'https://example.com' }]
        await service.start(bookmarks)

        expect(progressEvents).toContainEqual({
            status: 'warning',
            message: 'Rate limit reached (429). Pausing for 8s before retrying batch 1...'
        })
        expect(progressEvents).toContainEqual({
            status: 'warning',
            message: 'Network issue on batch 1. Retrying in 3s...'
        })
    })

    it('does not recursively subdivide on permanent HTTP 404/401/403 errors', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})

        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Engineering', sub_categories: [] }]
        })

        const bookmarks = Array.from({ length: 20 }, (_, i) => ({
            title: `Bookmark ${i + 1}`,
            url: `https://example.com/${i + 1}`
        }))

        const progressMessages = []
        const onProgress = (evt) => {
            if (evt?.message) progressMessages.push(evt.message)
        }

        const notFoundError = new Error('model not found — models/gemini-2.5-pro is no longer available')
        notFoundError.statusCode = 404

        vi.spyOn(ai, 'classifyBatch').mockRejectedValue(notFoundError)

        const service = new OrganizerService('test-key', ['Engineering'], onProgress)
        const results = await service.start(bookmarks)

        // It should NOT attempt to split 20 -> 10 -> 5
        expect(progressMessages.some(m => m.includes('Splitting batch'))).toBe(false)
        expect(results).toHaveLength(20)
        expect(results.every(b => b.category === 'Other' && b.sub_category === 'General')).toBe(true)
    })
})

describe('geminiModelId provider mapping and legacy model aliasing', () => {
    it('strips google/ prefix from standard model names', () => {
        expect(geminiModelId('google/gemini-3.1-flash-lite')).toBe('gemini-3.1-flash-lite')
        expect(geminiModelId('google/gemini-3.8-flash')).toBe('gemini-3.8-flash')
        expect(geminiModelId('google/gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview')
    })

    it('aliases deprecated gemini-2.5-pro to gemini-3.1-pro-preview', () => {
        expect(geminiModelId('google/gemini-2.5-pro')).toBe('gemini-3.1-pro-preview')
        expect(geminiModelId('gemini-2.5-pro')).toBe('gemini-3.1-pro-preview')
    })
})


