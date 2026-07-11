import { describe, expect, it } from 'vitest'
import { removeDuplicateUrls } from './organizer'

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
