# Bookmark Date Provenance: Move-Based Browser Write

- **Date:** 2026-09-05
- **Status:** Approved design (sections 1-4 approved in conversation); awaiting spec review
- **Scope:** Approach 1 only — prevention. Date recovery is explicitly out of scope (see Non-goals).
- **Branch base:** `origin/main` at `ec1108b` (includes PR #45, run-in-background)

## 1. Problem

`calculateDateSpan` is correct; its input is degenerate. Every browser-mode organize run
re-creates the entire bookmark library with `dateAdded = now`, so the oldest bookmark in the
written tree is always the day of the run. The displayed range collapses to a single date.

### Root cause

`chrome.bookmarks.create()` accepts only `{parentId, title, url}`. There is no way to set
`dateAdded` through the extension API — verified empirically: passing the property makes the
binding reject the call with `Unexpected property: 'dateAdded'`. Chromium stamps
`creation_time.value_or(Time::Now())` (bookmark_model.cc:1005-1017).

The loss sites in the codebase:

- `organizer.js` categorized write: `itemsWithParents` drops everything but
  `{parentId, title, url}` (:737), then `createBookmark` (:745)
- `organizer.js` flat write: `createBookmark` (:437)
- `bookmarks.js:41-51`: `chrome.bookmarks.create({parentId, title, url})`

Every read/classify/export step preserves dates (parser.js:37-41, organizer.js:272-278,
`removeDuplicateUrls` uses `.filter()` so object references survive, ai.js:533-542 index join,
both result spreads). The write-back is the only loss site.

### Evidence of accumulated damage

The live profile contains 45,521 bookmark nodes dated 9/1 for only 3,176 distinct URLs
(~14x duplication), plus similar clusters on 9/3, 9/4, and 7/17. Each cluster is the
fingerprint of one browser-mode run re-creating the whole library.

## 2. Empirical basis (CDP probe, Chromium 153.0.7987.0)

Ran through the real `chrome.bookmarks` API from a throwaway extension in a scratch profile
(`/tmp/bm_date_probe/`, throwaway, not part of the repo):

| # | Question | Result |
|---|----------|--------|
| T1 | Can `create()` set a date? | Call **rejected** by the binding: no `dateAdded` property exists |
| T2 | Does `move()` preserve `dateAdded`? | **Yes** — byte-identical value across a real parent change 2.6s later |
| T3 | Does `update({title})` preserve it? | **Yes** |
| T4 | Is `move()` repeatable? | **Yes** — second move preserves again |
| T5 | Does Chrome dedupe repeated URLs? | **No** — two nodes, distinct ids, distinct dates |
| T6 | Does removing a duplicate disturb the survivor? | **No** |
| T8 | Copy-then-move? | Copy keeps its own created-at date; move cannot restore an older date |
| T10 | Move of a node dated 2022-03-04 | **Preserved** across a move into a freshly created folder |

Additional finding: hand-editing `date_added` in the profile `Bookmarks` JSON (leaving the
checksum untouched) survives Chrome restart and is served back through the API — dates are
not covered by the profile checksum. This makes personal recovery feasible, but not
shippable (see Non-goals).

Fidelity caveat: branded Chrome 152 ignores `--load-extension` even with
`--enable-unsafe-extension-debugging`, and its DevTools protocol has no `BookmarkManager`
domain; the probe therefore ran on the local Chromium 153 dev build. Same BookmarkModel code.

## 3. Goals

- G1. Browser-mode organize preserves every surviving bookmark's original `dateAdded`.
- G2. The `dateSpan` reported by a browser-mode run reflects true bookmark ages.
- G3. Browser-level duplicate nodes collapse; `duplicatesRemoved` counts real deletions.
- G4. The write is idempotent: a second run with unchanged input performs no moves and no
  removals.
- G5. A pre-write snapshot exists before any mutation, fulfilled per the provider rules of
  Section 5; a run never mutates a bookmark it did not snapshot.

## 4. Non-goals

- **Date recovery for already-reset bookmarks.** Rejected by the owner ("if you can't recover
  that's fine") before it was established that a personal, out-of-product recovery is
  technically feasible (Section 2, checksum finding). Revisit only as an explicit personal
  maintenance script; it must never become extension UI.
- URL normalization for dedup (trailing slash, `www.`, http/https). Out of scope; noted as
  future work. Exact-string matching everywhere, matching the existing
  `removeDuplicateUrls` (organizer.js:71-78).
- A transaction/journal log for the write phase. Idempotent re-runs are the recovery
  mechanism.
- File-mode (upload → export) behavior. Unchanged, including its use of
  `removeDuplicateUrls`.

## 5. Execution contexts (post-PR #45 amendment)

PR #45 made the service worker the primary execution context: the panel delegates via a Port
`START_JOB` message (Organizer.jsx:711-736) and `BackgroundJobRunner` runs
`OrganizerService.start()` in the SW (jobRunner.js:152, :211). The panel in-process path
(Organizer.jsx:738+) is a fallback.

Consequences adopted into the design:

1. **Snapshot provider seam.** DOM downloads do not exist in a service worker. The snapshot
   precondition (Section 8) is fulfilled through an injectable `snapshotProvider`:
   - Panel/in-process context: the default provider calls `downloadBookmarks` and aborts the
     run on failure, as approved.
   - Service worker context: `jobRunner` supplies a provider that persists the pre-write set
     (survivors + doomed duplicates) to `chrome.storage.local` under `preWriteBackup`, with a
     size bound (~8 MB estimated): over the bound it skips persistence, logs a warning into
     the job log, and proceeds. Persistence failure aborts.
2. **SW death mid-write is the mainline process-death scenario**, not an edge case. The
   keep-alive timer mitigates but does not eliminate it. Section 9's no-journal stance holds:
   a half-moved library is safe (every node still exists) and converges on re-run.

## 6. Architecture and data flow

Principle: the read → classify → sort pipeline is untouched. Only the browser write-back
changes, from "create copies" to "relocate the nodes that already exist."

1. **Read.** No change. The tree walk (organizer.js:272-278) already carries `id` (:275),
   `title`, `url`, `dateAdded`, and derived `add_date`.
2. **Index.** New `buildUrlIndex(allLinks)` in `organizer.js`:
   `Map<url, Array<{id, dateAdded}>>`, each list sorted by `dateAdded` ascending, numeric id
   as tie-break. Built from the full tree before any list-level filtering.
3. **Write.** Both browser branches — flat (:424-439) and categorized (:694-747) — resolve
   each classified item's URL through the index and call `moveBookmark(id, {parentId})`
   (bookmarks.js:53-63, exists, currently unused) instead of `createBookmark`. A new
   `removeBookmark(id)` wrapper in `bookmarks.js` handles duplicate deletion.
4. **Snapshot.** Via `snapshotProvider` (Section 5), invoked after classification and before
   the first mutation. This call is new: browser mode never exports today — the existing
   `downloadBookmarks` calls (:426, :693) both sit inside the `if (fileBookmarks)` branches
   and remain file-mode outputs.
5. **Stats.** `dateSpan` computation unchanged; it starts being fed true dates.

Emergent property: idempotency (G4). Today's copy model can only accumulate; the move model
converges.

## 7. URL resolution and duplicate policy

- **Keys are exact URL strings** — the same rule as `removeDuplicateUrls`, so the index and
  the pre-filter can never disagree about what a duplicate is.
- **Dedup unifies.** Today the filter (:308) removes duplicates from the list only; every
  copy stays alive in the browser. Under move mode the index is built before the filter,
  browser-mode dedup is computed from the index
  (`duplicatesRemoved = sum(group size - 1)`), the list handed to classification is the
  survivor set, and `removeDuplicateUrls` is no longer called in browser mode. It remains in
  force for file mode. The pre-filter count and the actual deletions become the same number.
- **Survivor policy.** Oldest `dateAdded` wins; tie-break by numeric id (creation order).
  Consequence: the AI classifies the survivor's title, so where copies carry different
  titles, the oldest one's wins.
- **Duplicates are deleted outright**, not quarantined. The pile is the problem being fixed.
  Deletions happen in the same write phase, after the survivor's move has landed, so the URL
  always exists somewhere until its keeper is in place.
- **Ordering.** Moves do not pass `index` (arrival order within a 15-wide `Promise.all`
  chunk is racy, and there is no bulk-reorder API). A **Phase B reorder pass** runs per
  target folder after all moves: walk children, and
  `move(id, {parentId, index})` only where `children[i].id !== expected[i].id`. On re-runs
  nearly every node is already in place, so idempotency survives.
- **Dead links.** No special case: they already receive `category: 'Archive'`
  (organizer.js:22-66) and flow through the same move path with dates intact.
- **Unresolvable items.** Cannot arise in browser mode (every classified item came from the
  tree). A move that fails because the node vanished mid-run is recorded per Section 9.

## 8. Snapshot semantics

- **Content:** survivors plus doomed duplicates (from the index), so deleting a duplicate
  whose title differs from the survivor's is not an unrecoverable loss.
- **Form:** the existing Netscape exporter output (panel context) or a JSON array persisted
  to `chrome.storage.local.preWriteBackup` (SW context). Keep the existing
  `organized_bookmarks.html` name; the file already doubles as the feature's normal output.
- **Honest limitation, surfaced in UI copy:** the backup restores content and dates, not the
  prior folder layout — Chrome's importer drops everything into an "Imported" folder.

## 9. Failure and cancellation

**Taxonomy.** Systemic failures abort before any mutation: reading the tree, and snapshot
fulfillment (per Section 5's provider rules). Everything else is per-item.

**Per-item failures are recorded, never fatal.** Each `move`/`remove`/reorder call gets its
own catch; failures land in `stats.failedMoves` as `{title, reason}` entries and the
completion banner reports "N moves failed." A category folder that cannot be created fails
only that category's items. This replaces today's behavior where one rejected promise in a
`Promise.all` chunk kills the whole run.

**Cancellation.** Existing check points stay (between chunks, before Phase B). Semantics
change and the message says so: under copy mode cancel left the browser untouched; under
move mode it leaves a **half-moved library** — every node exists, some relocated, some not.
Warning text: "Cancelled — bookmarks partially reorganized. Run again to finish." In-flight
chunks complete; no teardown of completed moves (undoing them would be strictly worse).

**Process death** (SW killed, browser closed mid-run) is the same state as a cancel. No
journal; idempotent re-run is the recovery; the snapshot is already durable (file or
`preWriteBackup`).

## 10. Testing strategy

**Service tests** (`organizer.test.js`, Vitest). Existing house style is spies on
`bookmarksService` exports. For move-mode tests the mock becomes an in-memory
`FakeBookmarkStore` that actually mutates a simulated tree (move splices children, remove
deletes) — reorder and idempotency cannot be tested against call-recording spies. Coverage:

- Browser flat mode moves in sorted order; `createBookmark` never called in browser mode.
- Duplicate URL x3 with distinct dates → oldest moved, two removals,
  `duplicatesRemoved === 2`, survivor keeps the oldest date; `dateAdded` tie → lower
  numeric id wins.
- Index-before-filter regression: a URL existing only as duplicates still gets its survivor
  moved.
- Failure injection: one `moveBookmark` rejection → run completes, `failedMoves` length 1
  with title recorded, everything else moved. Folder-creation failure fails only that
  category.
- Snapshot precondition: provider throws → zero mutations; success → provider received
  survivors plus doomed duplicates.
- SW-context provider: persists to `preWriteBackup`; over the size bound → warning logged,
  run proceeds.
- Cancellation after chunk one → chunk completes, rest skipped, null result, new warning
  text, nothing undone.
- Phase B: misordered folder gets only misplaced nodes re-moved; second full run issues zero
  moves and zero removals (idempotency contract).
- Dead links move into Archive via the same path with dates intact.
- File mode untouched: `removeDuplicateUrls` still used, no `moveBookmark` calls.

**Component tests** (`Organizer.test.jsx`). Banner renders "N moves failed" when
`stats.failedMoves.length > 0`; new cancellation copy. Existing pill/banner tests stay
green — `stats` only gains fields.

**Deliberate contract inversions in existing tests** (they encode the old behavior):
`organizer.test.js` assertions that `downloadBookmarks` is not called in browser mode
(:785, :1240 region) now expect it; the browser flat-mode test (:1190) is rewritten from
create-assertions to move-assertions.

**The honest gate.** jsdom cannot establish that Chromium preserves dates; the probe already
did. No unit test re-asserts date preservation through a mock (a mock echoes the date back —
meaningless). Before the PR opens: run the built extension in the scratch Chromium profile
against a seeded messy tree (duplicates + 2022-dated nodes), then read the profile file and
verify dates survived, duplicates collapsed, folders correct.

## 11. Risks and open questions

- **Behavior change is user-visible:** browser-mode organize becomes destructive-in-place
  instead of additive. Mitigations: mandatory snapshot (Section 8), explicit cancel copy, and
  the change is the point of the feature.
- **Phase B cost on first migration:** large libraries reorder many nodes one call at a
  time. Acceptable for v1; measurable via the existing progress pipeline.
- **`preWriteBackup` growth:** bounded by the Section 5 size rule; consider a follow-up
  retention policy (e.g., keep last N) rather than designing it now.
- **Open question for implementation planning:** whether `organizeBookmarksResult`
  (bookmarks.js:103-128, a second copy-based write path) has live callers and should convert
  to move semantics or be deleted. Resolve during planning; do not silently leave a
  date-destroying path in the codebase.
