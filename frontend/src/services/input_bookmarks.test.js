import { describe, it, expect, vi, afterEach } from 'vitest'
import { saveInputBookmarkFile, getInputBookmarkFile, removeInputBookmarkFile, INPUT_MAX_BYTES } from './input_bookmarks'

const htmlOf = (n) => `<!DOCTYPE NETSCAPE-Bookmark-file-1>${'<DT><A HREF="https://x.com">x</A>'.repeat(n)}`

describe('input bookmarks cache', () => {
    afterEach(() => { delete global.chrome })

    it('saves the raw HTML byte-for-byte with metadata', async () => {
        const setSpy = vi.fn((payload, cb) => cb())
        global.chrome = { runtime: {}, storage: { local: { set: setSpy, get: vi.fn((k, cb) => cb({})) , remove: vi.fn() } } }
        const html = htmlOf(3)
        const res = await saveInputBookmarkFile({ filename: 'bookmarks.html', html, count: 3, dateSpan: '1/1/2020 – 2/2/2026' })
        expect(res.saved).toBe(true)
        expect(setSpy).toHaveBeenCalledTimes(1)
        const entry = setSpy.mock.calls[0][0].inputBookmarks
        expect(entry.html).toBe(html)
        expect(entry.filename).toBe('bookmarks.html')
        expect(entry.count).toBe(3)
        expect(typeof entry.savedAt).toBe('number')
    })

    it('refuses entries above INPUT_MAX_BYTES without throwing', async () => {
        global.chrome = { runtime: {}, storage: { local: { set: vi.fn(), get: vi.fn((k, cb) => cb({})), remove: vi.fn() } } }
        const res = await saveInputBookmarkFile({ filename: 'huge.html', html: 'x'.repeat(INPUT_MAX_BYTES + 1), count: 1, dateSpan: null })
        expect(res.saved).toBe(false)
        expect(res.reason).toBe('too-large')
    })

    it('round-trips through storage', async () => {
        const entry = { filename: 'b.html', html: '<x/>', size: 4, savedAt: 123, count: 1, dateSpan: null }
        global.chrome = { runtime: {}, storage: { local: {
            set: vi.fn((p, cb) => cb()),
            get: vi.fn((k, cb) => cb({ inputBookmarks: entry })),
            remove: vi.fn((k, cb) => cb())
        } } }
        await expect(getInputBookmarkFile()).resolves.toEqual(entry)
        await removeInputBookmarkFile()
        expect(global.chrome.storage.local.remove).toHaveBeenCalledWith(['inputBookmarks'], expect.any(Function))
    })
})
