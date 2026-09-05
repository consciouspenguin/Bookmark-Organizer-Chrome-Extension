import { describe, it, expect, vi, afterEach } from 'vitest'
import { moveBookmark, removeBookmark, getBookmarkChildren } from './bookmarks'

describe('bookmarks write wrappers', () => {
    afterEach(() => { delete global.chrome })

    it('moveBookmark forwards a destination object with parentId and optional index', async () => {
        global.chrome = { runtime: {}, bookmarks: { move: vi.fn((id, dest, cb) => cb({ id })) } }
        await moveBookmark('7', { parentId: '2', index: 3 })
        expect(global.chrome.bookmarks.move).toHaveBeenCalledWith('7', { parentId: '2', index: 3 }, expect.any(Function))
    })

    it('moveBookmark rejects on runtime lastError', async () => {
        global.chrome = { runtime: { lastError: { message: 'node not found' } }, bookmarks: { move: vi.fn((id, dest, cb) => cb()) } }
        await expect(moveBookmark('7', { parentId: '2' })).rejects.toThrow('node not found')
    })

    it('removeBookmark resolves and rejects correctly', async () => {
        global.chrome = { runtime: {}, bookmarks: { remove: vi.fn((id, cb) => cb()) } }
        await expect(removeBookmark('9')).resolves.toBeUndefined()
        global.chrome.runtime.lastError = { message: 'cannot remove' }
        global.chrome.bookmarks.remove = vi.fn((id, cb) => cb())
        await expect(removeBookmark('9')).rejects.toThrow('cannot remove')
    })

    it('getBookmarkChildren resolves the children array', async () => {
        global.chrome = { runtime: {}, bookmarks: { getChildren: vi.fn((pid, cb) => cb([{ id: '10' }, { id: '11' }])) } }
        await expect(getBookmarkChildren('2')).resolves.toEqual([{ id: '10' }, { id: '11' }])
    })
})
