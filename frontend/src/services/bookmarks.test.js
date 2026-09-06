import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    detectOtherBookmarksFolderId,
    getOtherBookmarksRootId,
    shouldCreateSubFolder,
    flattenBookmarks,
    moveBookmark,
    removeBookmark,
    getBookmarkChildren
} from './bookmarks';

describe('bookmarks service', () => {
    describe('detectOtherBookmarksFolderId', () => {
        it('detects Chrome bookmarks root ID 2', () => {
            const chromeTree = [
                {
                    id: '0',
                    title: 'root',
                    children: [
                        { id: '1', title: 'Bookmarks bar' },
                        { id: '2', title: 'Other bookmarks' },
                        { id: '3', title: 'Mobile bookmarks' }
                    ]
                }
            ];
            expect(detectOtherBookmarksFolderId(chromeTree)).toBe('2');
        });

        it('detects Firefox unfiled bookmarks root ID unfiled_____', () => {
            const firefoxTree = [
                {
                    id: 'root________',
                    title: '',
                    children: [
                        { id: 'menu________', title: 'Bookmarks Menu' },
                        { id: 'toolbar_____', title: 'Bookmarks Toolbar' },
                        { id: 'unfiled_____', title: 'Other Bookmarks' },
                        { id: 'mobile______', title: 'Mobile Bookmarks' }
                    ]
                }
            ];
            expect(detectOtherBookmarksFolderId(firefoxTree)).toBe('unfiled_____');
        });

        it('detects unfiled folder when tree is passed as children array directly', () => {
            const children = [
                { id: 'menu________', title: 'Bookmarks Menu' },
                { id: 'toolbar_____', title: 'Bookmarks Toolbar' },
                { id: 'unfiled_____', title: 'Unfiled Bookmarks' }
            ];
            expect(detectOtherBookmarksFolderId(children)).toBe('unfiled_____');
        });

        it('matches by title containing unfiled or other bookmarks if IDs differ', () => {
            const customTree = [
                {
                    id: 'root',
                    children: [
                        { id: 'favs', title: 'My Favorites' },
                        { id: 'custom-unfiled', title: 'Other Bookmarks' }
                    ]
                }
            ];
            expect(detectOtherBookmarksFolderId(customTree)).toBe('custom-unfiled');
        });

        it('falls back to 2 when tree is empty or invalid', () => {
            expect(detectOtherBookmarksFolderId([])).toBe('2');
            expect(detectOtherBookmarksFolderId(null)).toBe('2');
            expect(detectOtherBookmarksFolderId(undefined)).toBe('2');
            expect(detectOtherBookmarksFolderId([{ id: 'root', children: [] }])).toBe('2');
        });
    });

    describe('getOtherBookmarksRootId', () => {
        it('resolves root ID cleanly in mock environment', async () => {
            const rootId = await getOtherBookmarksRootId();
            expect(typeof rootId).toBe('string');
            expect(rootId).toBeTruthy();
        });
    });

    describe('shouldCreateSubFolder', () => {
        it('returns false for empty or general/uncategorized', () => {
            expect(shouldCreateSubFolder('Tech', '')).toBe(false);
            expect(shouldCreateSubFolder('Tech', 'General')).toBe(false);
            expect(shouldCreateSubFolder('Tech', 'None')).toBe(false);
            expect(shouldCreateSubFolder('Tech', 'Uncategorized')).toBe(false);
            expect(shouldCreateSubFolder('Tech', 'Tech')).toBe(false);
        });

        it('returns true for distinct subcategories', () => {
            expect(shouldCreateSubFolder('Technology', 'JavaScript')).toBe(true);
            expect(shouldCreateSubFolder('News', 'Politics')).toBe(true);
        });
    });

    describe('flattenBookmarks', () => {
        it('flattens nested bookmark tree into array of links', () => {
            const tree = [
                {
                    id: '1',
                    title: 'Folder 1',
                    children: [
                        { id: '2', title: 'Google', url: 'https://google.com', parentId: '1', dateAdded: 100 },
                        {
                            id: '3',
                            title: 'Subfolder',
                            children: [
                                { id: '4', title: 'GitHub', url: 'https://github.com', parentId: '3', dateAdded: 200 }
                            ]
                        }
                    ]
                }
            ];
            const flattened = flattenBookmarks(tree);
            expect(flattened).toHaveLength(2);
            expect(flattened[0].url).toBe('https://google.com');
            expect(flattened[1].url).toBe('https://github.com');
        });
    });
});

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
