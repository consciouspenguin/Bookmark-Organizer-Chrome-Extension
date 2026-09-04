import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { removeDuplicateUrls, checkUrlReachable, filterReachableBookmarks, OrganizerService } from './organizer'
import { classifyBatch } from './ai'

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
