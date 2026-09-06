# Bookmark Date Provenance — Move-Based Browser Write + Input Preservation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browser-mode organize relocates existing bookmark nodes with `chrome.bookmarks.move()` so `dateAdded` survives, duplicates collapse, and a pre-write snapshot always exists; file mode caches the dropped-in HTML as an "Input Bookmarks" card so users never need a manual copy.

**Architecture:** The read → classify → sort pipeline is untouched. A URL index built from the full browser tree decides survivors (oldest `dateAdded` wins, numeric-id tie-break); the write phase moves survivor nodes into target folders, deletes doomed duplicates, then runs a per-folder reorder pass. A snapshot provider seam fulfills the pre-write backup in panel (file download) and service-worker (storage) contexts. File mode gains a byte-for-byte input cache in `chrome.storage.local`.

**Tech Stack:** Chrome MV3, React 19, Vite 7, Vitest 4 + @testing-library/react, no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-bookmark-date-provenance-design.md` (the plan argues from the spec; executors read both)

**Branch base:** `origin/main` at `ec1108b` (post PR #45). Work happens on `feat/show-date-range-of-total-organized`.

## Global Constraints

- Tests: `cd frontend && npm test` — must pass before every commit. Lint: `cd frontend && npm run lint` — 0 errors (4 pre-existing warnings in Organizer.jsx are acceptable).
- No new runtime dependencies.
- Dedup keys are exact URL strings (spec §7). No URL normalization.
- `chrome.bookmarks.create` must never receive a `dateAdded` property — the API rejects the call outright (spec §2, probe T1).
- Snapshot bound (SW context): 8 MB. Input cache bound: 25 MB (spec §5, §12).
- Tests that set `global.chrome` must `delete global.chrome` in `afterEach` (house rule in Organizer.test.jsx).
- Conventional Commits. Never push with force; verify delta with `git log --oneline origin/main..HEAD` before pushing.
- The AI classification path is never exercised in tests: browser-mode service tests use `flatDateSort = true` with `cleanTitles = false`, which reaches the write phase without any network call (organizer.js:343-373).

## Interface contracts (defined by these tasks, consumed by later ones)

```js
// bookmarks.js
moveBookmark(id, destination)        // destination: {parentId: string, index?: number}
removeBookmark(id)
getBookmarkChildren(parentId)        // resolves children array

// organizer.js (pure, exported)
buildUrlIndex(links)                 // Map<url, Array<{id, dateAdded}>> groups sorted asc by dateAdded, then numeric id
dedupeFromIndex(links, urlIndex)     // {survivors, doomed, duplicatesRemoved}; survivor = group head

// OrganizerService instance
this.failedMoves                     // Array<{title: string, reason: string}>
this.snapshotProvider                // async (survivors, doomedDuplicates) => void; null = lazily-installed panel default
prepareSnapshot(survivors, doomed)   // returns true to proceed, false to abort

// background/snapshotProvider.js
createStorageSnapshotProvider(log)   // returns a snapshotProvider persisting to chrome.storage.local.preWriteBackup

// services/input_bookmarks.js
saveInputBookmarkFile({filename, html, count, dateSpan})  // {saved: true, entry} | {saved: false, reason: 'too-large'}
getInputBookmarkFile()               // Promise<entry|null>; entry: {filename, html, size, savedAt, count, dateSpan}
removeInputBookmarkFile()            // Promise<void>
downloadInputBookmarkFile(entry)     // pristine original download

// storage keys
inputBookmarks                        // cached file-mode input (entry object)
preWriteBackup                        // SW-context pre-write snapshot {savedAt, count, items}
```

---

### Task 1: bookmarks.js write wrappers

**Files:**
- Modify: `frontend/src/services/bookmarks.js:53-63` (moveBookmark), append removeBookmark/getBookmarkChildren, delete `organizeBookmarksResult` (:103-128)
- Test: `frontend/src/services/bookmarks.test.js` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `moveBookmark(id, destination)`, `removeBookmark(id)`, `getBookmarkChildren(parentId)` per the contract above. Later tasks import all three in organizer.js.

Note: `organizeBookmarksResult` has zero callers (verified by grep) and is a copy-based write path — the spec's open question resolves to "delete it."

- [ ] **Step 1: Write the failing test**

Create `frontend/src/services/bookmarks.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/services/bookmarks.test.js`
Expected: FAIL — `moveBookmark` exists but takes `(id, parentId)`; `removeBookmark`/`getBookmarkChildren` are not exported.

- [ ] **Step 3: Implement**

In `frontend/src/services/bookmarks.js`, replace the existing `moveBookmark` (lines 53-63) and add the two wrappers:

```js
export async function moveBookmark(id, destination) {
    return new Promise((resolve, reject) => {
        chrome.bookmarks.move(id, destination, (result) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(result);
            }
        });
    });
}

export async function removeBookmark(id) {
    return new Promise((resolve, reject) => {
        chrome.bookmarks.remove(id, () => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve();
            }
        });
    });
}

export async function getBookmarkChildren(parentId) {
    return new Promise((resolve, reject) => {
        chrome.bookmarks.getChildren(parentId, (children) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(children || []);
            }
        });
    });
}
```

Delete the entire `organizeBookmarksResult` function (lines 103-128).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/services/bookmarks.test.js && npm test`
Expected: PASS (new file green; full suite still green — nothing imported the deleted function).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/bookmarks.js frontend/src/services/bookmarks.test.js
git commit -m "feat(bookmarks): move/remove/children wrappers; drop dead copy-based organizeBookmarksResult"
```

---

### Task 2: URL index and index-based dedup (pure functions)

**Files:**
- Modify: `frontend/src/services/organizer.js` (add exports near `removeDuplicateUrls`, :71-78)
- Test: `frontend/src/services/organizer.test.js` (add a describe block at top level)

**Interfaces:**
- Consumes: nothing.
- Produces: `buildUrlIndex(links)`, `dedupeFromIndex(links, urlIndex)` per the contract above. Task 3/4 consume them.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/services/organizer.test.js` (import `buildUrlIndex, dedupeFromIndex` in the existing import at line 2):

```js
describe('buildUrlIndex and dedupeFromIndex', () => {
    const links = [
        { id: '10', url: 'https://a.com', title: 'A old',  dateAdded: 1500000000000 },
        { id: '11', url: 'https://a.com', title: 'A new',  dateAdded: 1700000000000 },
        { id: '9',  url: 'https://a.com', title: 'A tie',  dateAdded: 1500000000000 },
        { id: '20', url: 'https://b.com', title: 'B',      dateAdded: 1600000000000 }
    ]

    it('groups nodes by exact URL sorted oldest-first with numeric-id tie-break', () => {
        const index = buildUrlIndex(links)
        expect(index.get('https://a.com').map(g => g.id)).toEqual(['9', '10', '11'])
        expect(index.get('https://b.com').map(g => g.id)).toEqual(['20'])
    })

    it('keeps the group head as survivor and dooms the rest', () => {
        const { survivors, doomed, duplicatesRemoved } = dedupeFromIndex(links, buildUrlIndex(links))
        expect(survivors.map(l => l.id)).toEqual(['9', '20'])
        expect(doomed.map(l => l.id).sort()).toEqual(['10', '11'])
        expect(duplicatesRemoved).toBe(2)
    })

    it('keeps id-less entries as survivors (defensive: non-browser input)', () => {
        const idless = [{ url: 'https://a.com', title: 'no id', dateAdded: 1 }]
        const { survivors, doomed } = dedupeFromIndex(idless, buildUrlIndex(idless))
        expect(survivors).toHaveLength(1)
        expect(doomed).toHaveLength(0)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/services/organizer.test.js -t "buildUrlIndex"`
Expected: FAIL — `buildUrlIndex is not exported`.

- [ ] **Step 3: Implement**

Add after `removeDuplicateUrls` in `frontend/src/services/organizer.js`:

```js
// Browser-mode provenance index (spec §7): exact-URL groups, oldest dateAdded wins,
// numeric id breaks ties. Survivor = group head; everything else is a doomed duplicate.
export function buildUrlIndex(links) {
    const index = new Map();
    for (const link of links) {
        if (!link.url) continue;
        if (!index.has(link.url)) index.set(link.url, []);
        index.get(link.url).push({ id: link.id, dateAdded: link.dateAdded || 0 });
    }
    for (const group of index.values()) {
        group.sort((a, b) => (a.dateAdded - b.dateAdded) || (Number(a.id) - Number(b.id)));
    }
    return index;
}

export function dedupeFromIndex(links, urlIndex) {
    const survivorIds = new Set();
    for (const group of urlIndex.values()) {
        if (group.length > 0 && group[0].id !== undefined) survivorIds.add(String(group[0].id));
    }
    const survivors = [];
    const doomed = [];
    for (const link of links) {
        if (link.id === undefined) { survivors.push(link); continue; }
        if (survivorIds.has(String(link.id))) survivors.push(link);
        else doomed.push(link);
    }
    return { survivors, doomed, duplicatesRemoved: doomed.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/services/organizer.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/organizer.js frontend/src/services/organizer.test.js
git commit -m "feat(organizer): URL provenance index with oldest-survivor dedup"
```

---

### Task 3: FakeBookmarkStore test infrastructure

**Files:**
- Modify: `frontend/src/services/organizer.test.js` (add class + factory near the top, after imports)

**Interfaces:**
- Consumes: nothing.
- Produces: `class FakeBookmarkStore` with `rootTree()`, `node(id)`, `addFolder(parentId, id, title)`, `addUrl(parentId, id, url, title, dateAdded)`, `move(id, destination)`, `remove(id)`, `childrenOf(parentId)`, `ops`. Tasks 3-7's tests delegate the `bookmarksService` spies to it.

- [ ] **Step 1: Add the class (with a canary test)**

```js
class FakeBookmarkStore {
    constructor() {
        this.nodes = new Map();   // id -> {id, parentId, title, url?, dateAdded?, children?: []}
        this.ops = [];
        const root = { id: '0', parentId: null, title: 'root', children: [] };
        const bar = { id: '1', parentId: '0', title: 'Bookmarks Bar', children: [] };
        const other = { id: '2', parentId: '0', title: 'Other Bookmarks', children: [] };
        root.children.push(bar, other);
        for (const n of [root, bar, other]) this.nodes.set(n.id, n);
    }
    rootTree() {
        const root = this.nodes.get('0');
        return [root];
    }
    node(id) { return this.nodes.get(String(id)); }
    addFolder(parentId, id, title) {
        const folder = { id: String(id), parentId: String(parentId), title, children: [] };
        this.nodes.set(folder.id, folder);
        this.node(parentId).children.push(folder);
        return folder;
    }
    addUrl(parentId, id, url, title, dateAdded) {
        const node = { id: String(id), parentId: String(parentId), title, url, dateAdded };
        this.nodes.set(node.id, node);
        this.node(parentId).children.push(node);
        return node;
    }
    move(id, destination) {
        this.ops.push(['move', String(id), destination]);
        const node = this.node(id);
        if (!node) return Promise.reject(new Error(`node ${id} not found`));
        const oldParent = this.node(node.parentId);
        oldParent.children = oldParent.children.filter(c => c.id !== node.id);
        node.parentId = destination.parentId;
        const newParent = this.node(destination.parentId);
        if (!newParent) return Promise.reject(new Error(`parent ${destination.parentId} not found`));
        const index = typeof destination.index === 'number' ? destination.index : newParent.children.length;
        newParent.children.splice(Math.min(index, newParent.children.length), 0, node);
        return Promise.resolve(node);
    }
    remove(id) {
        this.ops.push(['remove', String(id)]);
        const node = this.node(id);
        if (!node) return Promise.reject(new Error(`node ${id} not found`));
        this.node(node.parentId).children = this.node(node.parentId).children.filter(c => c.id !== node.id);
        this.nodes.delete(String(id));
        return Promise.resolve();
    }
    childrenOf(parentId) {
        return Promise.resolve([...(this.node(parentId)?.children || [])]);
    }
}

const wireStore = (store) => {
    vi.spyOn(bookmarksService, 'moveBookmark').mockImplementation((id, dest) => store.move(id, dest));
    vi.spyOn(bookmarksService, 'removeBookmark').mockImplementation((id) => store.remove(id));
    vi.spyOn(bookmarksService, 'getBookmarkChildren').mockImplementation((pid) => store.childrenOf(pid));
};
```

Canary test (inside the existing browser-mode describe or a new one):

```js
it('FakeBookmarkStore move splices children and preserves dateAdded', async () => {
    const store = new FakeBookmarkStore()
    store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
    store.addFolder('2', 'f1', 'Target')
    await store.move('10', { parentId: 'f1' })
    expect(store.node('10').parentId).toBe('f1')
    expect(store.node('10').dateAdded).toBe(1500000000000)
    expect(store.childrenOf('1')).resolves.toHaveLength(0)
})
```

- [ ] **Step 2: Run**

Run: `cd frontend && npx vitest run src/services/organizer.test.js -t "FakeBookmarkStore"`
Expected: PASS (infrastructure only; no production change, no commit on its own — it ships with Task 4's commit if kept separate is awkward, but commit it now as test infra):

- [ ] **Step 3: Commit**

```bash
git add frontend/src/services/organizer.test.js
git commit -m "test(organizer): FakeBookmarkStore in-memory chrome.bookmarks model"
```

---

### Task 4: Browser flat mode writes by moving (and collapses duplicates)

**Files:**
- Modify: `frontend/src/services/organizer.js` — dedup block (:305-326), flat browser write (:428-438), import line (:1)
- Test: `frontend/src/services/organizer.test.js` — rewrite the test at :1190, add duplicate-collapse test

**Interfaces:**
- Consumes: `buildUrlIndex`, `dedupeFromIndex` (Task 2); `moveBookmark`, `removeBookmark` (Task 1); `FakeBookmarkStore` (Task 3).
- Produces: `OrganizerService` browser flat write that moves nodes; `this.doomedDuplicates` (array) set during `start()`; tasks 5/6 build on it.

- [ ] **Step 1: Write the failing tests**

Rewrite the test at organizer.test.js:1190 (`saves directly to a single chronological browser folder when in browser mode`) to:

```js
it('moves existing browser nodes into the chronological folder instead of creating copies', async () => {
    const store = new FakeBookmarkStore()
    store.addFolder('2', 'chron-root-123', 'Chronological Bookmarks-2026-09-05')
    store.addUrl('1', '10', 'https://older.com', 'Older Link', 1500000000000)
    store.addUrl('1', '11', 'https://newer.com', 'Newer Link', 1700000000000)
    vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
    vi.spyOn(bookmarksService, 'findOrCreateFolder').mockResolvedValue({ id: 'chron-root-123', title: 'Chronological Bookmarks' })
    vi.spyOn(bookmarksService, 'createBookmark')
    wireStore(store)

    const service = new OrganizerService(
        'test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite',
        '5-10', true, true, false,
        true,  // flatDateSort
        'desc'
    )
    service.snapshotProvider = async () => {} // replaced by the real seam in Task 7; no-op keeps this test focused

    const results = await service.start(null)

    expect(results.map(b => b.title)).toEqual(['Newer Link', 'Older Link'])
    expect(bookmarksService.createBookmark).not.toHaveBeenCalled()
    expect(store.node('10').parentId).toBe('chron-root-123')
    expect(store.node('11').parentId).toBe('chron-root-123')
    expect(store.node('10').dateAdded).toBe(1500000000000)
})
```

Add alongside it:

```js
it('collapses duplicate URLs by moving the oldest node and removing the rest', async () => {
    const store = new FakeBookmarkStore()
    store.addFolder('2', 'chron-root-123', 'Chronological Bookmarks')
    store.addUrl('1', '10', 'https://dupe.com', 'Dupe original', 1500000000000)
    store.addUrl('2', '12', 'https://dupe.com', 'Dupe mid', 1600000000000)
    store.addUrl('1', '13', 'https://dupe.com', 'Dupe newest', 1700000000000)
    store.addUrl('1', '14', 'https://unique.com', 'Unique', 1650000000000)
    vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
    vi.spyOn(bookmarksService, 'findOrCreateFolder').mockResolvedValue({ id: 'chron-root-123', title: 'Chronological Bookmarks' })
    wireStore(store)

    const service = new OrganizerService(
        'test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite',
        '5-10', true, true, false,
        true, 'desc'
    )
    service.snapshotProvider = async () => {}

    const results = await service.start(null)

    expect(service.stats.duplicatesRemoved).toBe(2)
    expect(store.node('12')).toBeUndefined()
    expect(store.node('13')).toBeUndefined()
    expect(store.node('10')).toBeDefined()
    expect(store.node('10').parentId).toBe('chron-root-123')
    expect(store.node('10').dateAdded).toBe(1500000000000)
    expect(results.map(b => b.url).sort()).toEqual(['https://dupe.com', 'https://unique.com'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/services/organizer.test.js -t "browser nodes"`
Expected: FAIL — the current implementation calls `createBookmark`; `createBookmark` spy is called and no moves happen.

- [ ] **Step 3: Implement**

In `frontend/src/services/organizer.js`:

3a. Update the import at line 1:

```js
import { getBookmarks, createBookmark, findOrCreateFolder, clearFolderCache, shouldCreateSubFolder, moveBookmark, removeBookmark, getBookmarkChildren } from './bookmarks';
```

3a-2. Carry the current parent through the pipeline. In `start()`'s browser tree walk (:272-278), add `parentId` to the pushed object:

```js
                            allLinks.push({
                                title: node.title,
                                url: node.url,
                                id: node.id,
                                parentId: node.parentId,
                                dateAdded: node.dateAdded,
                                add_date: node.dateAdded ? String(Math.floor(node.dateAdded / 1000)) : undefined
                            });
```

This is what makes re-runs no-ops: `chrome.bookmarks.move` without an `index` sends a node to the END of its parent's children, so re-issuing a same-parent move would reshuffle the folder and break idempotency (G4). `safeMove` (3d) skips nodes already in their target parent. File-mode links have no `parentId` and never reach `safeMove`.

3b. Replace the dedup block (:305-326) so browser mode dedups via the index and records doomed nodes:

```js
        let duplicatesRemoved = 0;
        this.doomedDuplicates = [];
        const isBrowserMode = !fileBookmarks;
        if (this.removeDuplicates && isBrowserMode) {
            const urlIndex = buildUrlIndex(allLinks);
            const dedup = dedupeFromIndex(allLinks, urlIndex);
            allLinks = dedup.survivors;
            this.doomedDuplicates = dedup.doomed;
            duplicatesRemoved = dedup.duplicatesRemoved;
            this.onProgress({
                status: 'info',
                message: duplicatesRemoved > 0
                    ? `Removed ${duplicatesRemoved} duplicate URL${duplicatesRemoved === 1 ? '' : 's'} from the organized result.`
                    : 'No duplicate URLs found.'
            });
        } else if (this.removeDuplicates) {
            const originalCount = allLinks.length;
            allLinks = removeDuplicateUrls(allLinks);
            duplicatesRemoved = originalCount - allLinks.length;
            this.onProgress({
                status: 'info',
                message: duplicatesRemoved > 0
                    ? `Removed ${duplicatesRemoved} duplicate URL${duplicatesRemoved === 1 ? '' : 's'} from the organized result.`
                    : 'No duplicate URLs found.'
            });
        }
        if (duplicatesRemoved > 0) {
            const postDupeSpan = calculateDateSpan(allLinks);
            if (postDupeSpan && postDupeSpan !== this.dateSpan) {
                this.dateSpan = postDupeSpan;
                this.stats.dateSpan = postDupeSpan;
                this.onProgress({
                    status: 'info',
                    message: `Date range after deduplication: ${postDupeSpan}`,
                    dateSpan: postDupeSpan
                });
            }
        }
```

(Note: the post-dupe date-range block was previously inside the `if (this.removeDuplicates)` arm; it now runs whenever dedup removed something, in both modes.)

3c. Replace the flat-branch browser write (the `else` at :428-438):

```js
            } else {
                this.onProgress({ status: 'info', message: `Saving ${finalResults.length.toLocaleString()} chronological bookmarks${dateSpan ? ` (${dateSpan})` : ''} to browser...`, dateSpan });
                const rootId = '2';
                const folderTitle = "Chronological Bookmarks-" + new Date().toISOString().slice(0, 10);
                const rootFolder = await findOrCreateFolder(rootId, folderTitle);
                clearFolderCache();

                await this.moveItems(finalResults.map(item => ({ item, parentId: rootFolder.id })));
                await this.removeDoomedDuplicates();
            }
```

3d. Add the two private helpers (place them right after `cancel()` at :176-178):

```js
    async moveItems(pairs) {
        const WRITE_CHUNK_SIZE = 15;
        for (let i = 0; i < pairs.length; i += WRITE_CHUNK_SIZE) {
            if (this.isCancelled) break;
            const chunk = pairs.slice(i, i + WRITE_CHUNK_SIZE);
            await Promise.all(chunk.map(({ item, parentId }) => this.safeMove(item, parentId)));
        }
    }

    async safeMove(item, parentId) {
        if (this.isCancelled) return;
        if (item.id === undefined) {
            this.failedMoves.push({ title: item.title, reason: 'bookmark node id missing' });
            return;
        }
        if (item.parentId === parentId) return; // already home — keeps re-runs idempotent (G4)
        try {
            await moveBookmark(item.id, { parentId });
        } catch (err) {
            this.failedMoves.push({ title: item.title, reason: err?.message || String(err) });
        }
    }

    async removeDoomedDuplicates() {
        for (const node of this.doomedDuplicates || []) {
            if (this.isCancelled) break;
            try {
                await removeBookmark(String(node.id));
            } catch (err) {
                this.failedMoves.push({ title: node.title, reason: `duplicate remove failed: ${err?.message || err}` });
            }
        }
    }
```

3e. Initialize the failure list in the constructor stats (after :173 `dateSpan: null`):

```js
            failedMoves: []
        };
        this.failedMoves = [];
        this.snapshotProvider = null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/services/organizer.test.js`
Expected: PASS — the rewritten test replaces the old create-assertions and the `downloadBookmarks` not-called assertion (:1240) entirely; the file-mode tests (including the :785 cancellation assertion) are untouched and stay green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/organizer.js frontend/src/services/organizer.test.js
git commit -m "feat(organizer): flat browser write moves nodes and collapses duplicates, preserving dateAdded"
```

---

### Task 5: Categorized browser write by moving, with failure isolation

**Files:**
- Modify: `frontend/src/services/organizer.js` — categorized browser write (:694-747)
- Test: `frontend/src/services/organizer.test.js` (add categorized move tests)

**Interfaces:**
- Consumes: `moveItems`, `safeMove`, `removeDoomedDuplicates` (Task 4), `moveBookmark`/`removeBookmark` (Task 1).
- Produces: per-item failure isolation — `findOrCreateFolder` rejection fails only that item; `this.failedMoves` accumulates `{title, reason}`.

- [ ] **Step 1: Write the failing tests**

Categorized mode reaches the AI path, so the tests mock `ai.generateSchema` and `ai.classifyBatch` exactly like the existing categorized file-mode tests do (organizer.test.js:1569-1574): `classifyBatch` spreads its input so `id` and `parentId` survive. No fetch mock is needed — dead-link probing was removed from the main path (organizer.js:450-455). The first `findOrCreateFolder` call is the ROOT folder ("AI Organized Bookmarks-..."), so rejection tests must let it resolve and only reject the category folder.

```js
const arrangeCategorized = (store) => {
    vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
    vi.spyOn(bookmarksService, 'createBookmark')
    vi.spyOn(ai, 'generateSchema').mockResolvedValue({ categories: [{ name: 'Tech', sub_categories: [] }] })
    vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) => batch.map(b => ({ ...b, category: 'Tech', sub_category: 'General' })))
    wireStore(store)
}

it('categorized browser mode moves nodes into category folders, keeping dates', async () => {
    const store = new FakeBookmarkStore()
    store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
    arrangeCategorized(store)
    vi.spyOn(bookmarksService, 'findOrCreateFolder').mockImplementation(async (parentId, title) => {
        const found = [...store.nodes.values()].find(n => n.parentId === parentId && n.title === title && !n.url)
        if (found) return found
        const id = `folder-${title}`
        return store.addFolder(parentId, id, title)
    })

    const service = new OrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', false, true, false, false, 'desc', 'alpha')
    service.snapshotProvider = async () => {}
    const results = await service.start(null)

    expect(results).not.toBeNull()
    expect(bookmarksService.createBookmark).not.toHaveBeenCalled()
    expect(store.node('10').parentId).toBe('folder-Tech')
    expect(store.node('10').dateAdded).toBe(1500000000000)
})

it('a category-folder failure fails only that item and records it', async () => {
    const store = new FakeBookmarkStore()
    store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
    arrangeCategorized(store)
    // First call creates the root; the category folder then fails.
    vi.spyOn(bookmarksService, 'findOrCreateFolder')
        .mockResolvedValueOnce(store.addFolder('2', 'org-root-1', 'AI Organized Bookmarks-2026-09-05'))
        .mockRejectedValue(new Error('quota exceeded'))

    const service = new OrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', false, true, false, false, 'desc', 'alpha')
    service.snapshotProvider = async () => {}
    const results = await service.start(null)

    expect(results).not.toBeNull()
    expect(service.failedMoves).toEqual([{ title: 'A', reason: 'quota exceeded' }])
    expect(store.node('10').parentId).toBe('1') // untouched
})

it('a failed move records failedMoves but does not abort the run', async () => {
    const store = new FakeBookmarkStore()
    store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
    store.addUrl('1', '11', 'https://b.com', 'B', 1600000000000)
    arrangeCategorized(store)
    vi.spyOn(bookmarksService, 'findOrCreateFolder').mockImplementation(async (parentId, title) => {
        const found = [...store.nodes.values()].find(n => n.parentId === parentId && n.title === title && !n.url)
        if (found) return found
        const id = `folder-${title}`
        return store.addFolder(parentId, id, title)
    })
    bookmarksService.moveBookmark.mockImplementation(async (id, dest) => {
        if (id === '10') throw new Error('node not found')
        return store.move(id, dest)
    })

    const service = new OrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', false, true, false, false, 'desc', 'alpha')
    service.snapshotProvider = async () => {}
    const results = await service.start(null)

    expect(results).not.toBeNull()
    expect(service.failedMoves).toEqual([{ title: 'A', reason: 'node not found' }])
    expect(store.node('11').parentId).toBe('folder-Tech') // the healthy sibling still moved
    expect(store.node('10').parentId).toBe('1')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/services/organizer.test.js -t "categorized browser mode moves"`
Expected: FAIL — current code calls `createBookmark` with `{parentId, title, url}` and drops `id`; a `findOrCreateFolder` rejection also rejects the whole run.

- [ ] **Step 3: Implement**

Replace the categorized browser write (:694-747) with:

```js
        } else {
            // Browser mode: relocate existing bookmarks (spec §6)
            this.onProgress({ status: 'info', message: `Reorganizing ${finalResults.length.toLocaleString()} bookmarks${dateSpan ? ` (${dateSpan})` : ''} in the browser...`, dateSpan });
            const rootId = '2'; // 'Other Bookmarks' usually
            const rootFolder = await findOrCreateFolder(rootId, "AI Organized Bookmarks-" + new Date().toISOString().slice(0, 10));
            clearFolderCache();

            const createdFolders = {}; // path key -> folder Object
            const itemsWithParents = [];

            for (const item of finalResults) {
                if (this.isCancelled) break;

                const category = item.category || "Uncategorized";
                let targetParentId;
                try {
                    let catFolder;
                    if (createdFolders[category]) {
                        catFolder = createdFolders[category];
                    } else {
                        catFolder = await findOrCreateFolder(rootFolder.id, category);
                        createdFolders[category] = catFolder;
                    }

                    targetParentId = catFolder.id;

                    const subCategory = item.sub_category;
                    if (shouldCreateSubFolder(category, subCategory)) {
                        const subPath = `${category}/${subCategory}`;
                        let subFolder;
                        if (createdFolders[subPath]) {
                            subFolder = createdFolders[subPath];
                        } else {
                            subFolder = await findOrCreateFolder(catFolder.id, subCategory);
                            createdFolders[subPath] = subFolder;
                        }
                        targetParentId = subFolder.id;
                    }
                } catch (err) {
                    this.failedMoves.push({ title: item.title, reason: err?.message || String(err) });
                    continue;
                }

                itemsWithParents.push({ item, parentId: targetParentId });
            }

            await this.moveItems(itemsWithParents);
            await this.removeDoomedDuplicates();
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/services/organizer.test.js`
Expected: PASS (full suite)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/organizer.js frontend/src/services/organizer.test.js
git commit -m "feat(organizer): categorized browser write moves nodes with per-item failure isolation"
```

---

### Task 6: Phase B reorder pass + idempotency

**Files:**
- Modify: `frontend/src/services/organizer.js` — add `reorderFolder`, call it at the end of both browser branches
- Test: `frontend/src/services/organizer.test.js`

**Interfaces:**
- Consumes: `getBookmarkChildren` (Task 1), `moveBookmark` with `index` (Task 1).
- Produces: `async reorderFolder(parentId, expectedIds)` — moves only misplaced nodes; the idempotency contract (spec G4): a second identical run issues zero moves and zero removes.

- [ ] **Step 1: Write the failing tests**

```js
it('reorders only misplaced nodes in a folder', async () => {
    const store = new FakeBookmarkStore()
    // children in wrong order: 12, 10, 11; expected: 10, 11, 12
    store.addFolder('2', 'f1', 'Folder')
    store.addUrl('f1', '12', 'https://c.com', 'C', 1700000000000)
    store.addUrl('f1', '10', 'https://a.com', 'A', 1500000000000)
    store.addUrl('f1', '11', 'https://b.com', 'B', 1600000000000)
    wireStore(store)

    const service = new OrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite')
    await service.reorderFolder('f1', ['10', '11', '12'])

    const childIds = (await store.childrenOf('f1')).map(c => c.id)
    expect(childIds).toEqual(['10', '11', '12'])
    expect(store.ops.filter(([op]) => op === 'move')).toHaveLength(2) // 10 and 11 moved; 12 already home
})

it('a second identical organize run issues zero moves and zero removes (idempotency)', async () => {
    // Same arrangement as Task 4's move test, run twice:
    const store = new FakeBookmarkStore()
    store.addFolder('2', 'chron-root-123', 'Chronological Bookmarks')
    store.addUrl('1', '10', 'https://older.com', 'Older Link', 1500000000000)
    store.addUrl('1', '11', 'https://newer.com', 'Newer Link', 1700000000000)
    // rootTree() wraps the LIVE root node, so run 2 reads run 1's mutations
    // through this same mock — no fixture rebuild, and never re-add the folder.
    vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
    vi.spyOn(bookmarksService, 'findOrCreateFolder').mockResolvedValue({ id: 'chron-root-123', title: 'Chronological Bookmarks' })
    wireStore(store)
    const service = new OrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', true, true, false, true, 'desc')
    service.snapshotProvider = async () => {} // installed for real in Task 7

    await service.start(null)
    const opsAfterFirst = store.ops.length
    expect(opsAfterFirst).toBeGreaterThan(0)

    const service2 = new OrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', true, true, false, true, 'desc')
    service2.snapshotProvider = async () => {}
    await service2.start(null)

    expect(store.ops.slice(opsAfterFirst)).toEqual([]) // zero ops on the second run
})
```

Why the second run is zero-ops: every node's `parentId` now equals the target folder, so `safeMove` skips them; the index finds no duplicates so `doomedDuplicates` is empty; and Phase B finds every child already in its expected position.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/services/organizer.test.js -t "reorder"`
Expected: FAIL — `reorderFolder` is not a function.

- [ ] **Step 3: Implement**

Add to OrganizerService (after `removeDoomedDuplicates` from Task 4):

```js
    async reorderFolder(parentId, expectedIds) {
        if (this.isCancelled || expectedIds.length === 0) return;
        let children;
        try {
            children = await getBookmarkChildren(parentId);
        } catch {
            return;
        }
        const order = children.map(c => String(c.id));
        for (let i = 0; i < expectedIds.length; i++) {
            const want = String(expectedIds[i]);
            if (order[i] === want) continue;
            const pos = order.indexOf(want);
            if (pos === -1) continue;
            try {
                await moveBookmark(want, { parentId, index: i });
                order.splice(pos, 1);
                order.splice(i, 0, want);
            } catch (err) {
                this.failedMoves.push({ title: want, reason: `reorder failed: ${err?.message || err}` });
            }
        }
    }
```

Call it at the end of both browser branches. Flat branch (Task 4, after `removeDoomedDuplicates()`):

```js
                await this.reorderFolder(rootFolder.id, finalResults.map(r => r.id));
```

Categorized branch (Task 5, after `removeDoomedDuplicates()`):

```js
                const byFolder = new Map();
                for (const { item, parentId } of itemsWithParents) {
                    if (!byFolder.has(parentId)) byFolder.set(parentId, []);
                    byFolder.get(parentId).push(item.id);
                }
                for (const [parentId, expectedIds] of byFolder) {
                    await this.reorderFolder(parentId, expectedIds);
                }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/services/organizer.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/organizer.js frontend/src/services/organizer.test.js
git commit -m "feat(organizer): Phase B reorder pass; browser write is idempotent"
```

---

### Task 7: Snapshot provider seam (precondition)

**Files:**
- Modify: `frontend/src/services/organizer.js` — add `prepareSnapshot`, call at top of both browser branches
- Modify: `frontend/src/services/bookmarks_export.js:130-133` — `saveAs` option
- Test: `frontend/src/services/organizer.test.js`

**Interfaces:**
- Consumes: `downloadBookmarks` (existing), `bookmarks_export` dynamic import.
- Produces: `prepareSnapshot(survivors, doomed)` returning `true`/`false`; `this.snapshotProvider` injectable (jobRunner uses this in Task 9). `downloadBookmarks(bookmarks, filename?, {saveAs})` — default unchanged (`saveAs: true`).

- [ ] **Step 1: Write the failing tests**

```js
it('browser mode snapshots survivors plus doomed duplicates before any mutation', async () => {
    const store = new FakeBookmarkStore()
    store.addFolder('2', 'chron-root-123', 'Chronological Bookmarks')
    store.addUrl('1', '10', 'https://dupe.com', 'Dupe original', 1500000000000)
    store.addUrl('2', '12', 'https://dupe.com', 'Dupe mid', 1600000000000)
    vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
    vi.spyOn(bookmarksService, 'findOrCreateFolder').mockResolvedValue({ id: 'chron-root-123', title: 'Chronological Bookmarks' })
    wireStore(store)
    const downloadSpy = vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation(() => {})

    const service = new OrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', true, true, false, true, 'desc')
    await service.start(null)

    expect(downloadSpy).toHaveBeenCalledTimes(1)
    const [exported, filename] = downloadSpy.mock.calls[0]
    expect(exported.map(b => b.id).sort()).toEqual(['10', '12']) // survivor + doomed, both present
    expect(filename).toBeUndefined() // exporter default: organized_bookmarks.html (spec §8)
})

it('refuses to mutate when the snapshot provider throws', async () => {
    const store = new FakeBookmarkStore()
    store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
    vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
    wireStore(store)

    const service = new OrganizerService('test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite', '5-10', true, true, false, true, 'desc')
    service.snapshotProvider = async () => { throw new Error('disk full') }
    const results = await service.start(null)

    expect(results).toBeNull()
    expect(store.ops).toEqual([]) // zero mutations
})
```

Note: every browser-branch test from Tasks 4-6 and 8-9 already sets `service.snapshotProvider = async () => {}`, so this task's change does not push the real panel download path under them. The only tests exercising the default provider are the two above (which spy `downloadBookmarks`). The file-mode cancellation test asserting `downloadBookmarks` not called (organizer.test.js:785) is file mode and stays as-is — the only browser-mode inversion was inside the :1190 test, rewritten in Task 4.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/services/organizer.test.js -t "snapshot"`
Expected: FAIL — browser mode never calls downloadBookmarks today; `prepareSnapshot` does not exist.

- [ ] **Step 3: Implement**

In `frontend/src/services/bookmarks_export.js`, change the signature and the download call (:130-152):

```js
export function downloadBookmarks(bookmarks, filename = "organized_bookmarks.html", options = {}) {
    const { saveAs = true } = options;
```

and pass it through: `chrome.downloads.download({ url: url, filename: actualFilename, saveAs: saveAs });` (the document-anchor fallback is unchanged — anchor downloads never prompt).

In OrganizerService (after `reorderFolder`):

```js
    async prepareSnapshot(survivors, doomedDuplicates) {
        if (!this.snapshotProvider) {
            const { downloadBookmarks } = await import('./bookmarks_export');
            this.snapshotProvider = async (surv, doomed) => {
                // No filename: the exporter keeps its organized_bookmarks.html default (spec §8).
                // saveAs: false — a Save-As dialog on every organize run would be hostile.
                downloadBookmarks([...surv, ...doomed], undefined, { saveAs: false });
            };
        }
        this.onProgress({ status: 'info', message: 'Saving a backup before touching your bookmarks (restores content and dates, not the previous folder layout)...' });
        try {
            await this.snapshotProvider(survivors, doomedDuplicates);
            return true;
        } catch (err) {
            this.onProgress({ status: 'error', message: `Backup failed — organize cancelled before touching your bookmarks. (${err?.message || err})` });
            return false;
        }
    }
```

Call it as the first statement of BOTH browser branches (flat Task 4 branch and categorized Task 5 branch), before folder creation:

```js
            if (!await this.prepareSnapshot(finalResults, this.doomedDuplicates || [])) return null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/services/organizer.test.js && npm run lint`
Expected: PASS. Note: tests whose OrganizerService never reaches a browser branch are unaffected; the in-process panel tests in Organizer.test.jsx that run file-mode are unaffected.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/organizer.js frontend/src/services/bookmarks_export.js frontend/src/services/organizer.test.js
git commit -m "feat(organizer): mandatory pre-write snapshot with injectable provider"
```

---

### Task 8: failedMoves surfaced in stats, log, and idle banner

**Files:**
- Modify: `frontend/src/services/organizer.js` — stats assignments (:412-421 flat, :767-776 categorized) gain `failedMoves`; completion log line
- Modify: `frontend/src/components/Organizer.jsx:1633-1641` — idle banner line
- Test: `frontend/src/services/organizer.test.js`, `frontend/src/components/Organizer.test.jsx`

**Interfaces:**
- Consumes: `this.failedMoves` (Task 4).
- Produces: `stats.failedMoves` array; banner renders "N moves failed".

- [ ] **Step 1: Write the failing tests**

Service test (after Task 5's failure tests, same `arrangeCategorized` helper; the first `findOrCreateFolder` call is the root, so it resolves and the category folder rejects):

```js
it('reports failedMoves in stats and logs the count', async () => {
    const logs = []
    const store = new FakeBookmarkStore()
    store.addUrl('1', '10', 'https://a.com', 'A', 1500000000000)
    arrangeCategorized(store)
    vi.spyOn(bookmarksService, 'findOrCreateFolder')
        .mockResolvedValueOnce(store.addFolder('2', 'org-root-1', 'AI Organized Bookmarks-2026-09-05'))
        .mockRejectedValue(new Error('quota exceeded'))

    const service = new OrganizerService('test-key', ['Tech'], (d) => logs.push(d.message), 'google/gemini-3.1-flash-lite', '5-10', false, true, false, false, 'desc', 'alpha')
    service.snapshotProvider = async () => {}
    await service.start(null)

    expect(service.stats.failedMoves).toEqual([{ title: 'A', reason: 'quota exceeded' }])
    expect(logs.some(m => m.includes('1 move failed'))).toBe(true)
})
```

Component test in Organizer.test.jsx — add it INSIDE the existing `describe('Last run banner date reporting')` block, because that describe owns the scoped `bannerText(stats)` helper (Organizer.test.jsx:223) which mocks chrome storage and renders the banner:

```js
it('shows failed moves in the last-run banner', () => {
    const text = bannerText({
        total: 3, isFlat: false, duplicatesRemoved: 0, deadLinksArchived: 0,
        categoriesCount: 1, categoryBreakdown: {},
        failedMoves: [{ title: 'X', reason: 'gone' }]
    })
    expect(text).toContain('1 move failed')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/services/organizer.test.js -t "failedMoves" && npx vitest run src/components/Organizer.test.jsx -t "failed moves"`
Expected: FAIL — `stats.failedMoves` is undefined; banner never renders it.

- [ ] **Step 3: Implement**

In both stats assignments (flat :412-421 and categorized :767-776) add:

```js
            failedMoves: this.failedMoves
```

After the final stats assignment in each branch, log the count:

```js
        if (this.failedMoves.length > 0) {
            const n = this.failedMoves.length;
            this.onProgress({ status: 'warning', message: `${n} move${n === 1 ? '' : 's'} failed and need${n === 1 ? 's' : ''} another run: ${this.failedMoves.map(f => f.title).slice(0, 5).join(', ')}${n > 5 ? '…' : ''}` });
        }
```

In Organizer.jsx idle banner (after the `deadLinksArchived` fragment at :1641):

```jsx
{lastOrganized.stats?.failedMoves?.length > 0 && ` · ${lastOrganized.stats.failedMoves.length} move${lastOrganized.stats.failedMoves.length === 1 ? '' : 's'} failed`}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/organizer.js frontend/src/components/Organizer.jsx frontend/src/services/organizer.test.js frontend/src/components/Organizer.test.jsx
git commit -m "feat(ui): surface failed moves in stats, run log, and last-run banner"
```

---

### Task 9: Cancellation copy

**Files:**
- Modify: `frontend/src/services/organizer.js` — the two post-write cancel messages (flat branch after its write loop, categorized branch :749-752)
- Test: `frontend/src/services/organizer.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: post-write cancellation message: `Cancelled — bookmarks partially reorganized. Run again to finish.` Pre-write cancels (during classification/clean-titles) keep the generic `Process cancelled.` text.

- [ ] **Step 1: Write the failing test**

```js
it('post-write cancellation reports a partially reorganized state', async () => {
    const store = new FakeBookmarkStore()
    store.addFolder('2', 'chron-root-123', 'Chronological Bookmarks')
    for (let i = 0; i < 40; i++) {
        store.addUrl('1', String(100 + i), `https://site-${i}.com`, `Site ${i}`, 1500000000000 + i * 1000)
    }
    vi.spyOn(bookmarksService, 'getBookmarks').mockResolvedValue(store.rootTree())
    vi.spyOn(bookmarksService, 'findOrCreateFolder').mockResolvedValue({ id: 'chron-root-123', title: 'Chronological Bookmarks' })
    wireStore(store)
    // Throttle moves so cancel lands mid-write:
    let moves = 0
    bookmarksService.moveBookmark.mockImplementation(async (id, dest) => {
        if (++moves === 20) service.cancel()
        return store.move(id, dest)
    })

    const messages = []
    const service = new OrganizerService('test-key', ['Tech'], (d) => messages.push(d.message), 'google/gemini-3.1-flash-lite', '5-10', true, true, false, true, 'desc')
    service.snapshotProvider = async () => {}
    const results = await service.start(null)

    expect(results).toBeNull()
    expect(messages.some(m => m.includes('partially reorganized'))).toBe(true)
    expect(messages.some(m => m.includes('Run again to finish'))).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/services/organizer.test.js -t "partially reorganized"`
Expected: FAIL — current message is `Process cancelled.`

- [ ] **Step 3: Implement**

Replace BOTH post-write cancel messages (flat branch and categorized :749-752) with:

```js
        if (this.isCancelled) {
            this.onProgress({ status: 'warning', message: 'Cancelled — bookmarks partially reorganized. Run again to finish.' });
            return null;
        }
```

Do NOT change the pre-write cancels (clean-titles at :368-371, classification at :679-682) — nothing has been mutated there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/services/organizer.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/organizer.js frontend/src/services/organizer.test.js
git commit -m "feat(organizer): post-write cancellation reports partially reorganized state"
```

---

### Task 10: SW-context snapshot provider

**Files:**
- Create: `frontend/src/background/snapshotProvider.js`
- Modify: `frontend/src/background/jobRunner.js:208` (after `new OrganizerService(...)`)
- Test: `frontend/src/background/snapshotProvider.test.js` (create)

**Interfaces:**
- Consumes: the `snapshotProvider` seam (Task 7).
- Produces: `createStorageSnapshotProvider(log)` per the contract above; persists `preWriteBackup` = `{savedAt, count, items}` where items are `{title, url, add_date}`. Over the 8 MB bound: logs a warning and proceeds (spec §5).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/background/snapshotProvider.test.js`:

```js
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createStorageSnapshotProvider } from './snapshotProvider'

describe('createStorageSnapshotProvider', () => {
    afterEach(() => { delete global.chrome })

    it('persists survivors plus doomed duplicates as add_date entries', async () => {
        const setSpy = vi.fn((payload, cb) => cb())
        global.chrome = { storage: { local: { set: setSpy } } }
        const provider = createStorageSnapshotProvider()
        await provider(
            [{ title: 'A', url: 'https://a.com', dateAdded: 1500000000000, id: '10' }],
            [{ title: 'A mid', url: 'https://a.com', dateAdded: 1600000000000, id: '12' }]
        )
        expect(setSpy).toHaveBeenCalledTimes(1)
        const [payload] = setSpy.mock.calls[0]
        expect(payload.preWriteBackup.count).toBe(2)
        expect(payload.preWriteBackup.items).toEqual([
            { title: 'A', url: 'https://a.com', add_date: '1500000000' },
            { title: 'A mid', url: 'https://a.com', add_date: '1600000000' }
        ])
    })

    it('skips persistence above the 8 MB bound and logs instead', async () => {
        const setSpy = vi.fn((payload, cb) => cb())
        global.chrome = { storage: { local: { set: setSpy } } }
        const logs = []
        const provider = createStorageSnapshotProvider((m) => logs.push(m))
        const big = { title: 'x', url: `https://big.com/${'a'.repeat(3 * 1024 * 1024)}`, dateAdded: 1 }
        await provider([big, big, big], [])
        expect(setSpy).not.toHaveBeenCalled()
        expect(logs.some(m => m.includes('backup skipped'))).toBe(true)
    })

    it('rejects when storage.local.set fails', async () => {
        global.chrome = { storage: { local: { set: vi.fn((p, cb) => { global.chrome.runtime.lastError = { message: 'quota' }; cb(); }) } } }
        const provider = createStorageSnapshotProvider()
        await expect(provider([], [])).rejects.toThrow('quota')
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/background/snapshotProvider.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `frontend/src/background/snapshotProvider.js`:

```js
const MAX_BACKUP_BYTES = 8 * 1024 * 1024; // spec §5: over the bound, warn and proceed

export function createStorageSnapshotProvider(log = () => {}) {
    return async (survivors, doomedDuplicates) => {
        const items = [...survivors, ...doomedDuplicates].map((b) => ({
            title: b.title,
            url: b.url,
            add_date: b.add_date || (b.dateAdded ? String(Math.floor(b.dateAdded / 1000)) : undefined)
        }));
        const json = JSON.stringify(items);
        if (json.length > MAX_BACKUP_BYTES) {
            log(`Pre-write backup skipped: ${items.length} bookmarks exceed the ${Math.round(MAX_BACKUP_BYTES / (1024 * 1024))} MB storage bound. Recovery relies on an idempotent re-run.`);
            return;
        }
        await new Promise((resolve, reject) => {
            chrome.storage.local.set(
                { preWriteBackup: { savedAt: Date.now(), count: items.length, items } },
                () => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve();
                }
            );
        });
    };
}
```

In `frontend/src/background/jobRunner.js`, immediately after the `new OrganizerService(...)` closing paren (:208):

```js
        this.organizer.snapshotProvider = createStorageSnapshotProvider((msg) => this.addLog(msg));
```

with the import at the top of the file:

```js
import { createStorageSnapshotProvider } from './snapshotProvider';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/background/ && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/background/snapshotProvider.js frontend/src/background/snapshotProvider.test.js frontend/src/background/jobRunner.js
git commit -m "feat(background): storage-backed pre-write snapshot provider for SW runs"
```

---

### Task 11: Input Bookmarks cache service + manifest permission

**Files:**
- Create: `frontend/src/services/input_bookmarks.js`
- Modify: `frontend/public/manifest.json:6-12` — add `"unlimitedStorage"`
- Test: `frontend/src/services/input_bookmarks.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `saveInputBookmarkFile({filename, html, count, dateSpan})`, `getInputBookmarkFile()`, `removeInputBookmarkFile()`, `downloadInputBookmarkFile(entry)`, `INPUT_MAX_BYTES` per the contract above. Task 12 consumes all of them from Organizer.jsx.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/services/input_bookmarks.test.js`:

```js
import { describe, it, expect, vi, afterEach } from 'vitest'
import { saveInputBookmarkFile, getInputBookmarkFile, removeInputBookmarkFile, INPUT_MAX_BYTES } from './input_bookmarks'

const htmlOf = (n) => `<!DOCTYPE NETSCAPE-Bookmark-file-1>${'<DT><A HREF="https://x.com">x</A>'.repeat(n)}`

describe('input bookmarks cache', () => {
    afterEach(() => { delete global.chrome })

    it('saves the raw HTML byte-for-byte with metadata', async () => {
        const setSpy = vi.fn((payload, cb) => cb())
        global.chrome = { storage: { local: { set: setSpy, get: vi.fn((k, cb) => cb({})) , remove: vi.fn() } } }
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
        global.chrome = { storage: { local: { set: vi.fn(), get: vi.fn((k, cb) => cb({})), remove: vi.fn() } } }
        const res = await saveInputBookmarkFile({ filename: 'huge.html', html: 'x'.repeat(INPUT_MAX_BYTES + 1), count: 1, dateSpan: null })
        expect(res.saved).toBe(false)
        expect(res.reason).toBe('too-large')
    })

    it('round-trips through storage', async () => {
        const entry = { filename: 'b.html', html: '<x/>', size: 4, savedAt: 123, count: 1, dateSpan: null }
        global.chrome = { storage: { local: {
            set: vi.fn((p, cb) => cb()),
            get: vi.fn((k, cb) => cb({ inputBookmarks: entry })),
            remove: vi.fn((k, cb) => cb())
        } } }
        await expect(getInputBookmarkFile()).resolves.toEqual(entry)
        await removeInputBookmarkFile()
        expect(global.chrome.storage.local.remove).toHaveBeenCalledWith('inputBookmarks', expect.any(Function))
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/services/input_bookmarks.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `frontend/src/services/input_bookmarks.js`:

```js
// File-mode input preservation (spec §12): the pristine dropped-in HTML is the date
// source of truth for file mode. Cached raw, never mutated by organize runs.
export const INPUT_MAX_BYTES = 25 * 1024 * 1024;
const STORAGE_KEY = 'inputBookmarks';

const local = () => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) throw new Error('chrome.storage.local unavailable');
    return chrome.storage.local;
};

export async function saveInputBookmarkFile({ filename, html, count, dateSpan }) {
    if (html.length > INPUT_MAX_BYTES) return { saved: false, reason: 'too-large' };
    const entry = { filename, html, size: html.length, savedAt: Date.now(), count, dateSpan };
    await new Promise((resolve, reject) => {
        local().set({ [STORAGE_KEY]: entry }, () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
        });
    });
    return { saved: true, entry };
}

export async function getInputBookmarkFile() {
    return new Promise((resolve, reject) => {
        local().get([STORAGE_KEY], (res) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(res?.[STORAGE_KEY] || null);
        });
    });
}

export async function removeInputBookmarkFile() {
    return new Promise((resolve, reject) => {
        local().remove([STORAGE_KEY], () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
        });
    });
}

export function downloadInputBookmarkFile(entry) {
    const name = entry.filename || 'input_bookmarks.html';
    const blob = new Blob([entry.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
        chrome.downloads.download({ url, filename: name, saveAs: true });
    } else if (typeof document !== 'undefined' && document.createElement) {
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
```

In `frontend/public/manifest.json`, add to `permissions`:

```json
    "permissions": [
        "storage",
        "unlimitedStorage",
        "bookmarks",
        "downloads",
        "sidePanel",
        "notifications"
    ],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/services/input_bookmarks.test.js && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/input_bookmarks.js frontend/src/services/input_bookmarks.test.js frontend/public/manifest.json
git commit -m "feat(storage): cache raw dropped-in bookmarks HTML with unlimitedStorage"
```

---

### Task 12: Input Bookmarks card in the panel

**Files:**
- Modify: `frontend/src/components/Organizer.jsx` — state + wiring near `processFile` (:522-545), card in idle section (before the last-run banner at :1633)
- Test: `frontend/src/components/Organizer.test.jsx`

**Interfaces:**
- Consumes: `saveInputBookmarkFile`, `getInputBookmarkFile`, `removeInputBookmarkFile`, `downloadInputBookmarkFile` (Task 11); `parseBookmarks`, `calculateDateSpan` (existing imports).
- Produces: `.input-bookmarks-card` in the idle DOM; `processFile` caches every successful drop; a new drop replaces the cache.

- [ ] **Step 1: Write the failing tests**

Add to Organizer.test.jsx (house chrome-mock shape; `vi.mock` the input service so tests control it — the component reads the cache through the service, not raw storage):

```js
import { fireEvent, waitFor } from '@testing-library/react' // only if not already imported (fireEvent/waitFor already are)

// at module scope of the test file:
vi.mock('../services/input_bookmarks', () => ({
    INPUT_MAX_BYTES: 25 * 1024 * 1024,
    saveInputBookmarkFile: vi.fn(async (input) => ({ saved: true, entry: { ...input, size: input.html.length, savedAt: 1757000000000 } })),
    getInputBookmarkFile: vi.fn(async () => null),
    removeInputBookmarkFile: vi.fn(async () => {}),
    downloadInputBookmarkFile: vi.fn()
}))

import * as inputService from '../services/input_bookmarks'

describe('Input Bookmarks card', () => {
    const cachedEntry = { filename: 'b.html', html: '<x/>', size: 4, savedAt: 1757000000000, count: 3462, dateSpan: null }

    beforeEach(() => { inputService.getInputBookmarkFile.mockResolvedValue(null) })
    afterEach(() => { vi.clearAllMocks(); delete global.chrome })

    const chromeWith = (local = {}) => {
        global.chrome = {
            storage: {
                local: { get: vi.fn((keys, cb) => cb(local)), set: vi.fn(), remove: vi.fn() },
                session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
            }
        }
    }

    it('caches a dropped file and shows the card', async () => {
        chromeWith({})
        const { container } = render(<Organizer />)
        const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p></DL><p>'
        const file = new File([html], 'bookmarks_mpro13.html', { type: 'text/html' })
        const zone = container.querySelector('[data-testid="dropzone"]')
        fireEvent.drop(zone, { dataTransfer: { files: [file] } })
        await waitFor(() => expect(inputService.saveInputBookmarkFile).toHaveBeenCalled())
        const call = inputService.saveInputBookmarkFile.mock.calls[0][0]
        expect(call.filename).toBe('bookmarks_mpro13.html')
        expect(call.html).toBe(html) // raw, byte-for-byte
        await waitFor(() => expect(container.querySelector('.input-bookmarks-card')).not.toBeNull())
    })

    it('renders the cached input as a card with Download, Re-organize, Remove', async () => {
        chromeWith({})
        inputService.getInputBookmarkFile.mockResolvedValue(cachedEntry)
        const { container, getByText } = render(<Organizer />)
        await waitFor(() => expect(container.querySelector('.input-bookmarks-card')).not.toBeNull())
        expect(container.querySelector('.input-bookmarks-card').textContent).toContain('b.html')
        expect(container.querySelector('.input-bookmarks-card').textContent).toContain('3,462')
        expect(getByText('Download')).toBeTruthy()
        expect(getByText('Re-organize')).toBeTruthy()
        expect(getByText('Remove')).toBeTruthy()
    })

    it('Remove clears the card and calls the service', async () => {
        chromeWith({})
        inputService.getInputBookmarkFile.mockResolvedValue(cachedEntry)
        const { container, getByText } = render(<Organizer />)
        await waitFor(() => expect(container.querySelector('.input-bookmarks-card')).not.toBeNull())
        fireEvent.click(getByText('Remove'))
        await waitFor(() => expect(inputService.removeInputBookmarkFile).toHaveBeenCalled())
        expect(container.querySelector('.input-bookmarks-card')).toBeNull()
    })

    it('Download emits the pristine original', async () => {
        chromeWith({})
        inputService.getInputBookmarkFile.mockResolvedValue(cachedEntry)
        const { container, getByText } = render(<Organizer />)
        await waitFor(() => expect(container.querySelector('.input-bookmarks-card')).not.toBeNull())
        fireEvent.click(getByText('Download'))
        expect(inputService.downloadInputBookmarkFile).toHaveBeenCalledWith(
            expect.objectContaining({ html: '<x/>', filename: 'b.html' })
        )
    })
})
```

Note: if the dropzone element has no `data-testid`, add `data-testid="dropzone"` to the existing drop-target div at Organizer.jsx:1576 as part of this task (a test-only attribute, no behavior change).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/Organizer.test.jsx -t "Input Bookmarks"`
Expected: FAIL — no card, no caching, `data-testid` missing.

- [ ] **Step 3: Implement**

In Organizer.jsx:

3a. Import at the top with the other service imports:

```js
import { saveInputBookmarkFile, getInputBookmarkFile, removeInputBookmarkFile, downloadInputBookmarkFile } from '../services/input_bookmarks'
```

3b. State next to `parsedBookmarks` (:515):

```js
    const [inputFile, setInputFile] = useState(null)
```

3c. Load on mount through the service (new effect near the auto-scroll effect at :563):

```js
    useEffect(() => {
        getInputBookmarkFile()
            .then((entry) => { if (entry) setInputFile(entry) })
            .catch(() => {})
    }, [])
```

3d. Cache on successful parse — inside `processFile`'s `reader.onload` after `setParsedBookmarks(links)` (:535):

```js
                saveInputBookmarkFile({ filename: file.name, html: content, count: links.length, dateSpan: span })
                    .then((res) => { if (res.saved) setInputFile(res.entry); else addLog('Input file too large to cache (25 MB limit) — organize continues; keep your own copy of the original.'); })
                    .catch(() => addLog('Could not cache the input file locally.'))
```

3e. Handlers (after `handleDragOver` at :560):

```js
    const handleDownloadInput = useCallback(() => {
        if (inputFile) downloadInputBookmarkFile(inputFile)
    }, [inputFile])

    const handleReorganizeInput = useCallback(() => {
        if (!inputFile) return
        try {
            const links = parseBookmarks(inputFile.html)
            const span = calculateDateSpan(links)
            setParsedBookmarks(links)
            if (span) setActiveDateSpan(span)
            setErrorMsg('')
            addLog(`Re-loaded ${inputFile.filename} from cached input (${links.length.toLocaleString()} bookmarks)`)
        } catch (err) {
            console.error(err)
            setErrorMsg('Cached input file could not be parsed.')
        }
    }, [inputFile, addLog])

    const handleRemoveInput = useCallback(async () => {
        try { await removeInputBookmarkFile() } catch {}
        setInputFile(null)
    }, [])
```

3f. Card JSX — insert immediately BEFORE the last-run banner block (`{status === 'idle' && lastOrganized && (` at :1633):

```jsx
            {status === 'idle' && inputFile && (
                <div className="input-bookmarks-card section-block">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>Input Bookmarks</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                {inputFile.filename} · {(inputFile.count || 0).toLocaleString()} bookmarks
                                {inputFile.dateSpan ? ` · Dates ${inputFile.dateSpan}` : ''}
                                {' '}· saved {new Date(inputFile.savedAt).toLocaleString()}
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button type="button" onClick={handleDownloadInput} title="Download the original file">Download</button>
                            <button type="button" onClick={handleReorganizeInput} title="Organize from the cached original again">Re-organize</button>
                            <button type="button" onClick={handleRemoveInput} title="Forget the cached input">Remove</button>
                        </div>
                    </div>
                </div>
            )}
```

3g. Add `data-testid="dropzone"` to the drop-target div at :1576.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm test && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Organizer.jsx frontend/src/components/Organizer.test.jsx
git commit -m "feat(ui): Input Bookmarks card caches the dropped-in file with download/reorganize/remove"
```

---

### Task 13: Full verification gate and PR

**Files:**
- No source changes (verification + release mechanics only)

**Interfaces:**
- Consumes: everything above.
- Produces: green suite, built dist, verified E2E behavior, PR URL.

- [ ] **Step 1: Full suite + lint + build**

```bash
cd frontend && npm test && npm run lint && npm run build
```
Expected: all pass; build emits `frontend/dist`.

- [ ] **Step 2: Sync check with origin/main**

```bash
git fetch origin main && git log HEAD..origin/main --oneline
```
If non-empty: `git rebase origin/main`, re-run the full suite, resolve per the repo conflict rules, then continue.

- [ ] **Step 3: E2E gate in the scratch Chromium profile**

Reuse the harness from the design spike (`/tmp/bm_date_probe/` + `/tmp/bm-date-probe-profile/`). Concretely:

1. Build a fresh scratch profile; seed `/tmp/bm-date-probe-profile/Default/Bookmarks` (Chrome stopped) with several nodes carrying 2022 `date_added` values plus two same-URL duplicates.
2. Launch: `"/Applications/Chromium.app/Contents/MacOS/Chromium" --headless=new --remote-debugging-port=9333 --remote-allow-origins='*' --user-data-dir=/tmp/bm-date-probe-profile --load-extension=<abs path to frontend/dist> --no-first-run`
3. Open `chrome-extension://<id>/index.html` via CDP `Target.createTarget`; seed config through `chrome.storage.local.set` (apiKey dummy, flatDateSort true, cleanTitles false, removeDuplicates true) and trigger the organize control via `Runtime.evaluate` (flat chronological sort performs NO AI calls, so no network/key is needed).
4. After completion, kill Chromium and read the profile `Bookmarks` JSON: assert every surviving node kept its seeded 2022 `date_added`, duplicates collapsed to one, and nodes live under the chronological folder.
5. If UI selectors have changed, adapt the trigger script at run time — the assertions in step 4 are the contract, not the click path.

- [ ] **Step 4: Push and open the PR**

```bash
git log --oneline origin/main..HEAD   # verify delta
git push -u origin feat/show-date-range-of-total-organized
gh pr create --title "feat: preserve bookmark dates via move-based browser write" --body "$(cat <<'EOF'
## Summary
- Browser-mode organize now relocates existing bookmark nodes (chrome.bookmarks.move) instead of copy-recreating them, so dateAdded — and therefore the reported date range — is real.
- Duplicate URL nodes collapse to the oldest survivor; duplicatesRemoved counts real deletions. A Phase B reorder pass keeps folders ordered; the write is idempotent.
- A pre-write snapshot is mandatory: panel runs download a backup HTML; service-worker runs persist preWriteBackup to storage (8 MB bound).
- New Input Bookmarks card caches the dropped-in HTML byte-for-byte (Download / Re-organize / Remove) with unlimitedStorage.

## Test plan
- [ ] cd frontend && npm test (unit: move/dedup/reorder/idempotency/snapshot/cancel/copy)
- [ ] npm run lint (0 errors)
- [ ] E2E gate in scratch Chromium profile: seeded 2022 dates survive a run; duplicates collapse
- [ ] Manual: drop a bookmarks.html in the panel -> Input Bookmarks card appears; Download returns the identical file; Re-organize runs without re-upload
EOF
)"
```

- [ ] **Step 5: Report the PR URL**

Per repo policy: the owner merges, then runs `wmr` and `git worktree prune` themselves.
