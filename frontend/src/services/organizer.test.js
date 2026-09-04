import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { removeDuplicateUrls, checkUrlReachable, filterReachableBookmarks, OrganizerService } from './organizer'

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
