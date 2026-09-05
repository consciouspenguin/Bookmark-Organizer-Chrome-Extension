import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { removeDuplicateUrls, checkUrlReachable, filterReachableBookmarks, OrganizerService, getBookmarkTimestamp, getBookmarkDomain, calculateDateSpan } from './organizer'
import * as ai from './ai'
import { classifyBatch, generateSchema, withRetry, geminiModelId, isNetworkError, isRateLimitError, isRetryableError } from './ai'
import * as bookmarksExport from './bookmarks_export'
import * as bookmarksService from './bookmarks'
import { DEFAULT_CATEGORIES, SUGGESTED_ADDABLE_CATEGORIES, SCHEMA_SORT_OPTIONS } from '../components/Organizer'

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

describe('isNetworkError, isRateLimitError, and isRetryableError helpers', () => {
    it('accurately identifies network and timeout errors', () => {
        expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
        expect(isNetworkError(new Error('request timeout'))).toBe(true)
        expect(isNetworkError(new Error('NetworkError when attempting to fetch resource'))).toBe(true)
        expect(isNetworkError(new Error('connect ECONNRESET 127.0.0.1'))).toBe(true)
        expect(isNetworkError(new Error('getaddrinfo ENOTFOUND api.google.com'))).toBe(true)

        const abortError = new Error('The operation was aborted')
        abortError.name = 'AbortError'
        expect(isNetworkError(abortError)).toBe(true)

        const timeoutError = new Error('Timeout')
        timeoutError.name = 'TimeoutError'
        expect(isNetworkError(timeoutError)).toBe(true)

        const err502 = new Error('Bad Gateway')
        err502.statusCode = 502
        expect(isNetworkError(err502)).toBe(true)

        const err504 = new Error('Gateway Timeout')
        err504.statusCode = 504
        expect(isNetworkError(err504)).toBe(true)

        const err408 = new Error('Request Timeout')
        err408.statusCode = 408
        expect(isNetworkError(err408)).toBe(true)

        // Non-network errors
        expect(isNetworkError(new Error('model returned invalid JSON'))).toBe(false)
        expect(isNetworkError(new Error('model response was cut off at the max_tokens limit'))).toBe(false)
        const err401 = new Error('Unauthorized')
        err401.statusCode = 401
        expect(isNetworkError(err401)).toBe(false)
    })

    it('accurately identifies rate limit errors', () => {
        const err429 = new Error('Too Many Requests')
        err429.statusCode = 429
        expect(isRateLimitError(err429)).toBe(true)

        expect(isRateLimitError(new Error('Resource exhausted: quota exceeded'))).toBe(true)
        expect(isRateLimitError(new Error('rate limited — too many requests'))).toBe(true)

        expect(isRateLimitError(new Error('Internal Server Error'))).toBe(false)
        expect(isRateLimitError(new Error('Bad Request'))).toBe(false)
    })

    it('accurately identifies retryable errors', () => {
        const explicitRetryable = new Error('something failed')
        explicitRetryable.retryable = true
        expect(isRetryableError(explicitRetryable)).toBe(true)

        expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true)
        expect(isRetryableError(new Error('request timeout'))).toBe(true)

        const abortErr = new Error('Aborted')
        abortErr.name = 'AbortError'
        expect(isRetryableError(abortErr)).toBe(true)

        const err408 = new Error('Timeout')
        err408.statusCode = 408
        expect(isRetryableError(err408, 408)).toBe(true)

        const err500 = new Error('Server Error')
        err500.statusCode = 500
        expect(isRetryableError(err500, 500)).toBe(true)

        const err400 = new Error('Bad Request')
        err400.statusCode = 400
        expect(isRetryableError(err400, 400)).toBe(false)
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

    it('does not recursively subdivide on network errors or request timeouts', async () => {
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

        const networkError = new TypeError('Failed to fetch')

        vi.spyOn(ai, 'classifyBatch').mockRejectedValue(networkError)

        const service = new OrganizerService('test-key', ['Engineering'], onProgress)
        const results = await service.start(bookmarks)

        // It should NOT attempt to split 20 -> 10 -> 5 when network fails
        expect(progressMessages.some(m => m.includes('Splitting batch'))).toBe(false)
        expect(results).toHaveLength(20)
        expect(results.every(b => b.category === 'Other' && b.sub_category === 'General')).toBe(true)
        const warningMsg = progressMessages.find(m => m.includes('Failed to fetch'))
        expect(warningMsg).toBeDefined()
    })

    it('does not recursively subdivide on 429 rate-limit errors or 5xx server errors', async () => {
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

        const rateLimitErr = new Error('Resource exhausted / quota exceeded')
        rateLimitErr.statusCode = 429

        vi.spyOn(ai, 'classifyBatch').mockRejectedValue(rateLimitErr)

        const service = new OrganizerService('test-key', ['Engineering'], onProgress)
        const results = await service.start(bookmarks)

        // It should NOT attempt to split 20 -> 10 -> 5 on rate limits
        expect(progressMessages.some(m => m.includes('Splitting batch'))).toBe(false)
        expect(results).toHaveLength(20)
        expect(results.every(b => b.category === 'Other' && b.sub_category === 'General')).toBe(true)
    })

    it('aborts immediately and reports error when navigator.onLine is false for AI modes', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const originalOnLine = navigator.onLine
        Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })

        try {
            const progressEvents = []
            const onProgress = (evt) => progressEvents.push(evt)

            const service = new OrganizerService('test-key', ['Tech'], onProgress)
            const bookmarks = [{ title: 'Site', url: 'https://example.com' }]
            const result = await service.start(bookmarks)

            expect(result).toBeNull()
            expect(progressEvents).toContainEqual({
                status: 'error',
                message: 'No internet connection detected. Please check your network and try again.'
            })
        } finally {
            Object.defineProperty(navigator, 'onLine', { value: originalOnLine, configurable: true })
        }
    })

    it('computes categoryBreakdown in stats and logs flat category tally to onProgress', async () => {
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [
                { name: 'Tech', sub_categories: [] },
                { name: 'News', sub_categories: [] }
            ]
        })

        const progressMessages = []
        const onProgress = (evt) => {
            if (evt?.message) progressMessages.push(evt.message)
        }

        vi.spyOn(ai, 'classifyBatch').mockResolvedValue([
            { title: 'Site 1', url: 'https://site1.com', category: 'Tech', sub_category: 'Code' },
            { title: 'Site 2', url: 'https://site2.com', category: 'Tech', sub_category: 'Tools' },
            { title: 'Site 3', url: 'https://site3.com', category: 'News', sub_category: 'Daily' }
        ])

        const bookmarks = [
            { title: 'Site 1', url: 'https://site1.com' },
            { title: 'Site 2', url: 'https://site2.com' },
            { title: 'Site 3', url: 'https://site3.com' }
        ]

        const service = new OrganizerService('test-key', ['Tech', 'News'], onProgress)
        const results = await service.start(bookmarks)

        expect(service.stats.categoryBreakdown).toEqual({
            Tech: 2,
            News: 1
        })
        expect(results.stats.categoryBreakdown).toEqual({
            Tech: 2,
            News: 1
        })
        expect(progressMessages).toContain('Category breakdown:')
        expect(progressMessages).toContain('  • News: 1')
        expect(progressMessages).toContain('  • Tech: 2')
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

describe('getBookmarkTimestamp', () => {
    it('normalizes Netscape epoch seconds to milliseconds', () => {
        expect(getBookmarkTimestamp({ add_date: '1609459200' })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ add_date: 1609459200 })).toBe(1609459200000)
    })

    it('preserves Chrome dateAdded milliseconds directly', () => {
        expect(getBookmarkTimestamp({ dateAdded: 1609459200000 })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ dateAdded: '1609459200000' })).toBe(1609459200000)
    })

    it('returns 0 for missing, null, or invalid dates', () => {
        expect(getBookmarkTimestamp(null)).toBe(0)
        expect(getBookmarkTimestamp({})).toBe(0)
        expect(getBookmarkTimestamp({ add_date: 'invalid' })).toBe(0)
        expect(getBookmarkTimestamp({ dateAdded: null })).toBe(0)
    })
})

describe('generateNetscapeHTML flat list generation', () => {
    it('generates a single flat list without DT/H3 folder headers when bookmarks have no category or isFlat is true', () => {
        const bookmarks = [
            { title: 'Alpha', url: 'https://alpha.com', add_date: '1600000000' },
            { title: 'Beta', url: 'https://beta.com', add_date: '1700000000' }
        ]
        bookmarks.isFlat = true

        const html = bookmarksExport.generateNetscapeHTML(bookmarks)
        expect(html).toContain('<TITLE>Bookmarks</TITLE>')
        expect(html).not.toContain('<H3')
        expect(html).toContain('<DT><A HREF="https://alpha.com" ADD_DATE="1600000000">Alpha</A>')
        expect(html).toContain('<DT><A HREF="https://beta.com" ADD_DATE="1700000000">Beta</A>')
    })
})

describe('OrganizerService flat chronological date sorting', () => {
    let downloadSpy

    beforeEach(() => {
        downloadSpy = vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
        downloadSpy.mockClear()
    })

    it('sorts bookmarks descending (newest first) and bypasses AI schema and classification', async () => {
        const schemaSpy = vi.spyOn(ai, 'generateSchema')
        const classifySpy = vi.spyOn(ai, 'classifyBatch')

        const progressMessages = []
        const onProgress = (evt) => {
            if (evt.message) progressMessages.push(evt.message)
        }

        const bookmarks = [
            { title: 'Oldest', url: 'https://oldest.com', add_date: '1500000000' },
            { title: 'Newest', url: 'https://newest.com', add_date: '1700000000' },
            { title: 'Middle', url: 'https://middle.com', add_date: '1600000000' }
        ]

        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            onProgress,
            'google/gemini-3.1-flash-lite',
            '5-10',
            true, // sortAlphabetically
            true, // removeDuplicates
            false, // cleanTitles
            true, // flatDateSort
            'desc' // dateSortOrder (newest first)
        )

        const results = await service.start(bookmarks)

        expect(schemaSpy).not.toHaveBeenCalled()
        expect(classifySpy).not.toHaveBeenCalled()

        expect(results.map(b => b.title)).toEqual(['Newest', 'Middle', 'Oldest'])
        expect(results.isFlat).toBe(true)
        expect(service.stats.isFlat).toBe(true)
        expect(service.stats.categoriesCount).toBe(0)
        expect(service.stats.categoryBreakdown).toEqual({})
        expect(service.stats.dateSpan).toBeTruthy()
        expect(progressMessages.some(m => m.includes('Sorting 3 bookmarks chronologically (Newest First)'))).toBe(true)
        expect(bookmarksExport.downloadBookmarks).toHaveBeenCalledWith(results)
    })

    it('sorts bookmarks ascending (oldest first)', async () => {
        const bookmarks = [
            { title: 'Newest', url: 'https://newest.com', add_date: '1700000000' },
            { title: 'Oldest', url: 'https://oldest.com', add_date: '1500000000' },
            { title: 'Middle', url: 'https://middle.com', add_date: '1600000000' }
        ]

        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            false,
            true, // flatDateSort
            'asc' // dateSortOrder (oldest first)
        )

        const results = await service.start(bookmarks)
        expect(results.map(b => b.title)).toEqual(['Oldest', 'Middle', 'Newest'])
        expect(bookmarksExport.downloadBookmarks).toHaveBeenCalledWith(results)
    })

    it('cleans titles in flat mode when cleanTitles is enabled', async () => {
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => {
            return batch.map(b => ({
                ...b,
                title: b.title.replace(' - Site', '')
            }))
        })

        const bookmarks = [
            { title: 'Old Article - Site', url: 'https://old.com', add_date: '1500000000' },
            { title: 'New Article - Site', url: 'https://new.com', add_date: '1700000000' }
        ]

        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            true, // cleanTitles enabled
            true, // flatDateSort
            'desc'
        )

        const results = await service.start(bookmarks)
        expect(results.map(b => b.title)).toEqual(['New Article', 'Old Article'])
        expect(results.every(b => b.category === null)).toBe(true)
        expect(bookmarksExport.downloadBookmarks).toHaveBeenCalledWith(results)
    })

    it('breaks timestamp ties alphabetically by title', async () => {
        const bookmarks = [
            { title: 'Zebra', url: 'https://zebra.com', add_date: '1600000000' },
            { title: 'Apple', url: 'https://apple.com', add_date: '1600000000' },
            { title: 'Mango', url: 'https://mango.com', add_date: '1600000000' }
        ]

        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            false,
            true,
            'desc'
        )

        const results = await service.start(bookmarks)
        expect(results.map(b => b.title)).toEqual(['Apple', 'Mango', 'Zebra'])
    })

    it('removes duplicate URLs before chronological sorting when removeDuplicates is enabled', async () => {
        const bookmarks = [
            { title: 'First Copy', url: 'https://example.com', add_date: '1500000000' },
            { title: 'Second Copy', url: 'https://example.com', add_date: '1700000000' },
            { title: 'Unique Page', url: 'https://unique.com', add_date: '1600000000' }
        ]

        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true, // removeDuplicates enabled
            false,
            true,
            'desc'
        )

        const results = await service.start(bookmarks)
        expect(results).toHaveLength(2)
        expect(service.stats.duplicatesRemoved).toBe(1)
        expect(results.map(b => b.url)).toEqual(['https://unique.com', 'https://example.com'])
    })

    it('saves directly to a single chronological browser folder when in browser mode', async () => {
        const browserTree = [
            {
                id: '1',
                title: 'Bookmarks Bar',
                children: [
                    { id: '10', title: 'Older Link', url: 'https://older.com', dateAdded: 1500000000000 },
                    { id: '11', title: 'Newer Link', url: 'https://newer.com', dateAdded: 1700000000000 }
                ]
            }
        ]

        vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(browserTree)
        const mockFolder = { id: 'chron-root-123', title: 'Chronological Bookmarks' }
        vi.spyOn(bookmarksService, 'findOrCreateFolder').mockResolvedValue(mockFolder)
        const createdBookmarks = []
        vi.spyOn(bookmarksService, 'createBookmark').mockImplementation(async (parentId, title, url) => {
            createdBookmarks.push({ parentId, title, url })
            return { id: `bm-${createdBookmarks.length}`, parentId, title, url }
        })

        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            false,
            true, // flatDateSort
            'desc' // newest first
        )

        // Null fileBookmarks triggers browser mode
        const results = await service.start(null)

        expect(results.map(b => b.title)).toEqual(['Newer Link', 'Older Link'])
        expect(bookmarksService.findOrCreateFolder).toHaveBeenCalledWith('2', expect.stringContaining('Chronological Bookmarks'))
        expect(createdBookmarks).toHaveLength(2)
        expect(createdBookmarks[0]).toEqual({
            parentId: 'chron-root-123',
            title: 'Newer Link',
            url: 'https://newer.com'
        })
        expect(createdBookmarks[1]).toEqual({
            parentId: 'chron-root-123',
            title: 'Older Link',
            url: 'https://older.com'
        })
        expect(bookmarksExport.downloadBookmarks).not.toHaveBeenCalled()
    })
})

describe('Category Presets and Suggestions', () => {
    it('orders Work & Career first and Tech & Development last in default categories', () => {
        expect(DEFAULT_CATEGORIES[0]).toBe('Work & Career')
        expect(DEFAULT_CATEGORIES[DEFAULT_CATEGORIES.length - 1]).toBe('Tech & Development')
    })

    it('provides exactly 10 unique common suggested addable categories with no overlap in defaults', () => {
        expect(SUGGESTED_ADDABLE_CATEGORIES).toHaveLength(10)
        const uniqueSet = new Set(SUGGESTED_ADDABLE_CATEGORIES)
        expect(uniqueSet.size).toBe(10)
        for (const sug of SUGGESTED_ADDABLE_CATEGORIES) {
            expect(DEFAULT_CATEGORIES).not.toContain(sug)
        }
    })
})

describe('getBookmarkDomain', () => {
    it('extracts clean domain without leading www', () => {
        expect(getBookmarkDomain({ url: 'https://www.github.com/repo' })).toBe('github.com')
        expect(getBookmarkDomain({ url: 'http://www.google.com' })).toBe('google.com')
    })

    it('preserves subdomains other than www', () => {
        expect(getBookmarkDomain({ url: 'https://developer.mozilla.org/en-US/' })).toBe('developer.mozilla.org')
        expect(getBookmarkDomain({ url: 'https://api.v2.service.co.uk/test' })).toBe('api.v2.service.co.uk')
    })

    it('safely handles missing or malformed URLs', () => {
        expect(getBookmarkDomain(null)).toBe('')
        expect(getBookmarkDomain({})).toBe('')
        expect(getBookmarkDomain({ url: 'not-a-valid-url' })).toBe('')
    })
})

describe('SCHEMA_SORT_OPTIONS Configuration', () => {
    it('defines all 5 sorting strategies with valid metadata and icons', () => {
        expect(SCHEMA_SORT_OPTIONS).toHaveLength(5)
        const ids = SCHEMA_SORT_OPTIONS.map(o => o.id)
        expect(ids).toEqual(['alpha', 'date-desc', 'date-asc', 'domain', 'alpha-desc'])
        for (const option of SCHEMA_SORT_OPTIONS) {
            expect(option.label).toBeTruthy()
            expect(option.badge).toBeTruthy()
            expect(option.desc).toBeTruthy()
            expect(option.icon).toBeDefined()
        }
    })
})

describe('Schema Folder Content Sorting (schemaSortOrder)', () => {
    beforeEach(() => {
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [
                { name: 'Tech', sub_categories: [] },
                { name: 'Design', sub_categories: [] }
            ]
        })

        vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => {
            return batch.map(b => ({
                ...b,
                category: b.url.includes('design') ? 'Design' : 'Tech',
                sub_category: null
            }))
        })

        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('sorts bookmarks inside folders by Date Added (Newest First) when schemaSortOrder is date-desc', async () => {
        const bookmarks = [
            { title: 'Older Tech', url: 'https://tech.com/old', add_date: '1500000000' },
            { title: 'Newer Tech', url: 'https://tech.com/new', add_date: '1700000000' },
            { title: 'Oldest Design', url: 'https://design.com/oldest', add_date: '1400000000' },
            { title: 'Newest Design', url: 'https://design.com/newest', add_date: '1800000000' }
        ]

        const service = new OrganizerService(
            'test-key',
            ['Tech', 'Design'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            false, // sortAlphabetically
            true, // removeDuplicates
            false, // cleanTitles
            false, // flatDateSort
            'desc',
            'date-desc' // schemaSortOrder
        )

        const results = await service.start(bookmarks)

        // Categories remain ordered A-Z (Design before Tech)
        // Inside Design: Newest Design (1800000000) then Oldest Design (1400000000)
        // Inside Tech: Newer Tech (1700000000) then Older Tech (1500000000)
        expect(results.map(b => b.title)).toEqual([
            'Newest Design',
            'Oldest Design',
            'Newer Tech',
            'Older Tech'
        ])
        expect(service.stats.schemaSortOrder).toBe('date-desc')
        expect(service.stats.isFlat).toBe(false)
    })

    it('sorts bookmarks inside folders by Date Added (Oldest First) when schemaSortOrder is date-asc', async () => {
        const bookmarks = [
            { title: 'Newer Tech', url: 'https://tech.com/new', add_date: '1700000000' },
            { title: 'Older Tech', url: 'https://tech.com/old', add_date: '1500000000' }
        ]

        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            false,
            true,
            false,
            false,
            'desc',
            'date-asc'
        )

        const results = await service.start(bookmarks)
        expect(results.map(b => b.title)).toEqual(['Older Tech', 'Newer Tech'])
        expect(service.stats.schemaSortOrder).toBe('date-asc')
    })

    it('sorts bookmarks inside folders by Website Domain A-Z when schemaSortOrder is domain', async () => {
        const bookmarks = [
            { title: 'YouTube Video', url: 'https://www.youtube.com/watch?v=123' },
            { title: 'GitHub Repo B', url: 'https://github.com/repo-b' },
            { title: 'GitHub Repo A', url: 'https://github.com/repo-a' },
            { title: 'ArXiv Paper', url: 'https://arxiv.org/abs/1234' }
        ]

        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            false,
            true,
            false,
            false,
            'desc',
            'domain'
        )

        const results = await service.start(bookmarks)
        // Domains: arxiv.org -> github.com -> youtube.com
        // Within github.com: tie-breaks by title A-Z
        expect(results.map(b => b.title)).toEqual([
            'ArXiv Paper',
            'GitHub Repo A',
            'GitHub Repo B',
            'YouTube Video'
        ])
        expect(service.stats.schemaSortOrder).toBe('domain')
    })

    it('sorts bookmarks inside folders reverse alphabetically when schemaSortOrder is alpha-desc', async () => {
        const bookmarks = [
            { title: 'Alpha Tech', url: 'https://tech.com/alpha' },
            { title: 'Zeta Tech', url: 'https://tech.com/zeta' },
            { title: 'Beta Tech', url: 'https://tech.com/beta' }
        ]

        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            false,
            true,
            false,
            false,
            'desc',
            'alpha-desc'
        )

        const results = await service.start(bookmarks)
        expect(results.map(b => b.title)).toEqual(['Zeta Tech', 'Beta Tech', 'Alpha Tech'])
        expect(service.stats.schemaSortOrder).toBe('alpha-desc')
    })

    it('sorts bookmarks inside folders alphabetically when schemaSortOrder is alpha', async () => {
        const bookmarks = [
            { title: 'Zeta Tech', url: 'https://tech.com/zeta' },
            { title: 'Alpha Tech', url: 'https://tech.com/alpha' },
            { title: 'Beta Tech', url: 'https://tech.com/beta' }
        ]

        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            false,
            false,
            'desc',
            'alpha'
        )

        const results = await service.start(bookmarks)
        expect(results.map(b => b.title)).toEqual(['Alpha Tech', 'Beta Tech', 'Zeta Tech'])
        expect(service.stats.schemaSortOrder).toBe('alpha')
    })
})

describe('calculateDateSpan', () => {
    it('returns null for empty, null, or undated bookmark collections', () => {
        expect(calculateDateSpan(null)).toBeNull()
        expect(calculateDateSpan([])).toBeNull()
        expect(calculateDateSpan([{ title: 'No Date', url: 'https://example.com' }])).toBeNull()
        expect(calculateDateSpan([{ title: 'Zero Date', url: 'https://example.com', add_date: '0' }])).toBeNull()
    })

    it('returns a single formatted date when all bookmarks share the same day', () => {
        // 1609459200 = 2021-01-01T00:00:00.000Z
        const singleDayBookmarks = [
            { title: 'Morning', url: 'https://a.com', add_date: '1609459200' },
            { title: 'Noon', url: 'https://b.com', add_date: '1609470000' }
        ]
        const expectedDate = new Date(1609459200000).toLocaleDateString()
        expect(calculateDateSpan(singleDayBookmarks)).toBe(expectedDate)
    })

    it('returns formatted oldest to newest range matching the oldest and newest bookmarks', () => {
        const bookmarks = [
            { title: 'Middle', url: 'https://b.com', add_date: '1600000000' }, // 2020-09-13
            { title: 'Oldest', url: 'https://a.com', add_date: '1500000000' }, // 2017-07-14
            { title: 'Newest', url: 'https://c.com', add_date: '1700000000' }  // 2023-11-14
        ]
        const oldestDate = new Date(1500000000000).toLocaleDateString()
        const newestDate = new Date(1700000000000).toLocaleDateString()
        expect(calculateDateSpan(bookmarks)).toBe(`${oldestDate} – ${newestDate}`)
    })

    it('handles large collections without stack overflow', () => {
        const largeList = Array.from({ length: 70000 }, (_, i) => ({
            title: `Item ${i}`,
            url: `https://example.com/${i}`,
            add_date: `${1500000000 + i}`
        }))
        const span = calculateDateSpan(largeList)
        const oldestDate = new Date(1500000000000).toLocaleDateString()
        const newestDate = new Date((1500000000 + 69999) * 1000).toLocaleDateString()
        expect(span).toBe(`${oldestDate} – ${newestDate}`)
    })
})

describe('total date range in categorized mode and oldest first sorting', () => {
    beforeEach(() => {
        vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})
    })

    it('computes total date range (dateSpan) across all categorized bookmarks and logs it', async () => {
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: [] }]
        })
        vi.spyOn(ai, 'classifyBatch').mockResolvedValue([
            { title: 'Oldest Link', url: 'https://old.com', add_date: '1500000000', category: 'Tech', sub_category: 'Code' },
            { title: 'Newest Link', url: 'https://new.com', add_date: '1700000000', category: 'Tech', sub_category: 'Code' }
        ])

        const progressMessages = []
        const onProgress = (evt) => {
            if (evt?.message) progressMessages.push(evt.message)
        }

        const bookmarks = [
            { title: 'Oldest Link', url: 'https://old.com', add_date: '1500000000' },
            { title: 'Newest Link', url: 'https://new.com', add_date: '1700000000' }
        ]

        const service = new OrganizerService('test-key', ['Tech'], onProgress)
        const results = await service.start(bookmarks)

        const oldestDate = new Date(1500000000000).toLocaleDateString()
        const newestDate = new Date(1700000000000).toLocaleDateString()
        const expectedSpan = `${oldestDate} – ${newestDate}`

        expect(service.stats.dateSpan).toBe(expectedSpan)
        expect(results.stats.dateSpan).toBe(expectedSpan)
        expect(progressMessages.some(m => m.includes(`Total date range: ${expectedSpan}`))).toBe(true)
    })

    it('pushes undated bookmarks to the bottom in flat chronological ascending (oldest first) sort', async () => {
        const bookmarks = [
            { title: 'No Date Bookmark', url: 'https://nodate.com' },
            { title: 'Newer Bookmark', url: 'https://newer.com', add_date: '1700000000' },
            { title: 'Older Bookmark', url: 'https://older.com', add_date: '1500000000' }
        ]

        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            true,
            true,
            false,
            true, // flatDateSort
            'asc' // dateSortOrder (oldest first)
        )

        const results = await service.start(bookmarks)
        // Older (1500000000) should be first, then Newer (1700000000), then No Date at bottom
        expect(results.map(b => b.title)).toEqual(['Older Bookmark', 'Newer Bookmark', 'No Date Bookmark'])
    })

    it('pushes undated bookmarks to the bottom inside folders for date-asc schemaSortOrder', async () => {
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: [] }]
        })
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => {
            return batch.map(b => ({ ...b, category: 'Tech', sub_category: 'General' }))
        })

        const bookmarks = [
            { title: 'Undated Tech', url: 'https://tech.com/undated' },
            { title: 'Newest Tech', url: 'https://tech.com/newest', add_date: '1700000000' },
            { title: 'Oldest Tech', url: 'https://tech.com/oldest', add_date: '1500000000' }
        ]

        const service = new OrganizerService(
            'test-key',
            ['Tech'],
            () => {},
            'google/gemini-3.1-flash-lite',
            '5-10',
            false,
            true,
            false,
            false,
            'desc',
            'date-asc'
        )

        const results = await service.start(bookmarks)
        expect(results.map(b => b.title)).toEqual(['Oldest Tech', 'Newest Tech', 'Undated Tech'])
    })
})

describe('Netscape HTML export and timestamp parsing', () => {
    it('includes Date range in the Netscape HTML header comment when dateSpan is present', () => {
        const bookmarks = [
            { title: 'Old Link', url: 'https://old.com', add_date: '1500000000' },
            { title: 'New Link', url: 'https://new.com', add_date: '1700000000' }
        ]
        const html = bookmarksExport.generateNetscapeHTML(bookmarks)
        expect(html).toContain('<!-- This is an automatically generated file.')
        expect(html).toContain('Date range:')
        expect(html).toContain(calculateDateSpan(bookmarks))
    })

    it('getBookmarkTimestamp accurately parses milliseconds, seconds, and ISO strings across all field names', () => {
        expect(getBookmarkTimestamp({ dateAdded: 1609459200000 })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ dateAdded: 1609459200 })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ dateAdded: '1609459200000' })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ date_added: 1609459200000 })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ add_date: 1609459200 })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ ADD_DATE: '1609459200' })).toBe(1609459200000)
        expect(getBookmarkTimestamp({ date: '2021-01-01T00:00:00.000Z' })).toBe(1609459200000)
        expect(getBookmarkTimestamp(null)).toBe(0)
        expect(getBookmarkTimestamp({})).toBe(0)
    })
})
