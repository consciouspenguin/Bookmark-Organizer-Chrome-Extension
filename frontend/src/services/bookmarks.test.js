import { describe, it, expect } from 'vitest';
import {
    detectOtherBookmarksFolderId,
    getOtherBookmarksRootId,
    shouldCreateSubFolder,
    flattenBookmarks
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
