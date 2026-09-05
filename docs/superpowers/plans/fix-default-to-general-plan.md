# Fix: Bookmarks Collapsing Into "General" — Subcategory Reliability, Hybrid Classification & Export Alignment

**Branch**: `fix/default_to_general`
**Status**: Implemented — all 9 tasks complete, 153 tests passing (baseline was 90)
**Last Updated**: 2026-09-05

## Implementation status

| Task | Status | Landed in |
|------|--------|-----------|
| 1. Schema validation + corrective retry | Done | `services/ai.js` |
| 2. Token budget + truncation salvage | Done | `services/ai.js` |
| 3. Phase-1 prompt rework | Done | `services/ai.js` |
| 4. Hybrid subcategory proposals | Done | `services/ai.js` |
| 5. Reconciliation pass | Done | `services/reconcile.js`, `services/organizer.js` |
| 6. Curated fallback schema | Done | `services/defaultSchema.js`, `services/organizer.js` |
| 7. Export alignment | Done | `services/bookmarks_export.js`, deleted `utils/generator.js` |
| 8. Observability | Done | `services/organizer.js` |
| 9. Fixtures + regression tests | Done | `__fixtures__/finance-heavy-bookmarks.json` + 4 test files |

### Deviations from the plan as written

- **Task 2 salvage needed a real repair, not a wider slice.** `extractJson`
  slices from the first `{` to the last `}`, which cannot parse a response with
  unbalanced brackets. Added `salvagePartialJson()`, which walks the text
  tracking string state and bracket depth, rewinds to the last completed value,
  and closes the open brackets. It also has to *undo* a cut point set by a
  closed **key** string, or the repair yields `{"name"}`.
- **Task 6 leaves unknown custom categories with `[]`, not `["General"]`.**
  Both produce the same output (the classifier falls back to `General`, which
  Task 7 files at the category root), but seeding the schema with a name the
  Phase-1 prompt explicitly bans is self-contradictory. The plan's real
  invariant — never a schema where *every* category is empty — holds.
- **Task 9 fixture is 137 bookmarks, not ~200.** Enough for 3 batches at the
  adaptive batch size, which is what exercises the concurrency and
  reconciliation paths. The first draft had 1–2 bookmark tail subcategories,
  which reconciliation correctly folded into `General` (22% share); the fixture
  was fattened so every subcategory carries ≥ 4, as a real collection would.
- **Task 4 prompt efficacy is unverified.** Unit tests cover the parsing and
  tagging against mocked responses; whether the model actually proposes good
  subcategories needs a real API run (see *Remaining manual verification*).

### Remaining manual verification

Run the extension against a real Gemini key on a large collection and confirm:
subcategories are topical rather than `General`; the `Subcategories: +X
AI-created, ~Y merged, Z folded` log line reads sensibly; and the `General`
share stays under 20%. Tune `minCount` / `max` in `reconcile.js` if proposals
sprawl or over-fold.

## Executive Summary

A full run placed bookmarks in the correct top-level categories (`Finance & Crypto`,
`Tech & Development`, `Work & Career`, … the `DEFAULT_CATEGORIES` set) but **every
bookmark landed in a nested `General` subfolder** — `Category → General → [all
bookmarks]`, with no AI-generated subcategories.

There are **two independent root causes**, both must be fixed:

1. **Content — schema degradation & classification trap.** When Phase-1 schema
   generation fails or returns empty `sub_categories`, the pipeline silently
   substitutes a subcategory-less schema, forcing Phase-2 classification Rule 3
   to assign `sub_category = "General"` to every bookmark.
2. **Structure — export vs. browser-write mismatch.** `shouldCreateSubFolder()`
   (`services/bookmarks.js:71`) treats `"general"`/`""`/`"none"` as *not a
   folder*, so **browser mode** files those bookmarks directly under the
   category. But `services/bookmarks_export.js:79` uses `if (sub)` and emits a
   literal `<DT><H3>General</H3>`, so **File mode** (and export→reimport) creates
   a real `General` folder under every category. `utils/generator.js` has the
   same bug but is dead code (imported nowhere).

## Failure Mode

```
Phase 1: generateSchema() (services/ai.js)
  200 sampled bookmarks → model
        │  fails (token cut-off / rate limit / network) OR returns empty sub_categories
        ▼
organizer.js:499-504  — SILENT FALLBACK
  schema = categories.map(c => ({ name: c, sub_categories: [] }))
        │
        ▼
Phase 2: classifyBatch() (services/ai.js)
  Rule 2: MUST use exact schema subcategories (none exist)
  Rule 3: no subcategory match → "General"
  → 100% of bookmarks get sub_category = "General"
        │
        ▼
Write:
  Browser  → shouldCreateSubFolder("general") = false → flat under category
  File/HTML→ bookmarks_export.js `if (sub)` → <H3>General</H3> under every category
```

## Confirmed code references

- Silent flat fallback: `frontend/src/services/organizer.js:499-504`
- No schema validation: `frontend/src/services/ai.js:424-487` (`generateSchema`)
- Schema `maxTokens: 8000`: `frontend/src/services/ai.js:481`
- Rigid classify rules 2–4: `frontend/src/services/ai.js:504-509`
- Export mismatch: `frontend/src/services/bookmarks_export.js:74-86`
- Dead duplicate: `frontend/src/utils/generator.js` (no importers)
- `shouldCreateSubFolder`: `frontend/src/services/bookmarks.js:71-76`

## Goals

- Phase 1 **always** delivers a real two-level schema, or the run fails loudly
  with an actionable message — never a silent flat structure.
- **Hybrid classification**: the fixed schema is the backbone; Phase 2 may add a
  bounded number of new subcategories per category when a clear cluster of
  bookmarks does not fit any schema subcategory.
- A post-classification **reconciliation pass** normalizes near-duplicate
  subcategory names, folds orphan subcategories, and enforces per-category caps
  tied to the user's granularity setting.
- `"General"` / `"Other"` become genuine last resorts (target < 5% on a healthy
  run), and are **never rendered as a folder** in either write path.
- Regression coverage with a realistic large fixture resembling the failing run.

## Non-Goals

- Rewriting the two-phase architecture (no clustering-first pipeline, no
  schema preview/edit UI). Deferred.
- Changes to `utils/generator.js` beyond deletion (it is unused).

## Global Constraints

- Zero regressions in the existing Vitest suite (`npm test` in `frontend/`).
- No new runtime dependencies.
- All new AI calls go through `withRetry` + cancellation + `onRetry` logging.
- Works for both providers (`gemini` native, `openrouter`) and File + Browser modes.

---

## Task 1: Schema validation + corrective retry `[Medium]`

### Description
Add `validateSchema(schema, { categories, subfolderTarget, bookmarkCount })` in
`services/ai.js` returning `{ ok, issues[] }`. Invalid when:
- `categories` missing/empty, or any entry lacks a non-empty string `name`;
- any non-catch-all category (`name` not `Other`/`Archive`) has fewer than the
  granularity minimum subcategories — `0-5` → ≥ 2, `5-10` → ≥ 3, `10+` → ≥ 5 —
  relaxed only when `bookmarkCount < 40`;
- total subcategories across the schema ≤ number of categories (degenerate/flat).
- Normalizes/trims names and strips `"General"`/`"Other"`/empty from
  `sub_categories` before counting.

In `generateSchema()`, after parsing:
1. `validateSchema` → if `ok`, return.
2. If invalid, make **one** corrective call appending the specific `issues` and:
   "Your previous structure was too flat: every category MUST contain at least N
   distinct subcategories. Never return empty `sub_categories`."
3. Still invalid → throw `err` with `err.schemaInvalid = true` (Task 6 uses this).

### Files
- `frontend/src/services/ai.js`

### Verification
- Unit: flat schema → one retry → valid second response returned.
- Unit: still-flat after retry → throws with `schemaInvalid`.
- Unit: `validateSchema` thresholds per `subfolderTarget` and the tiny-collection relaxation.

---

## Task 2: Schema token budget + truncation salvage `[Simple]`

### Description
- Raise schema-generation `maxTokens` `8000 → 16000`.
- In `parseGeminiResponse` / `parseModelResponse`, when `finishReason` is
  `MAX_TOKENS` / `length`, try `extractJson` on the partial content first; if it
  yields a valid object with ≥ 1 usable category, return it and let Task 1
  decide. Only throw the retryable error when salvage fails.
- No behavior change for classification batches (they keep their subdivision path).

### Files
- `frontend/src/services/ai.js`

### Verification
- Unit: truncated-but-parseable schema → salvaged object returned.
- Unit: truncated-and-unparseable → retryable error as today.
- Existing classify truncation tests still pass.

---

## Task 3: Rework Phase-1 schema prompt `[Medium]`

### Description
Rewrite the `generateSchema` prompt (`services/ai.js:438-476`):
- Lead with: "For EVERY category you MUST define {min}–{max} concrete,
  mutually-exclusive subcategories. A category with no subcategories is invalid."
  `{min}/{max}` derived numerically from `subfolderTarget`.
- Keep the existing non-redundancy / intent-grouping / naming rules beneath that.
- Demote current rule 10: `"General"` is permitted only as a single optional
  catch-all subcategory, only when unavoidable — never the default; remove the
  encouragement to route outliers to `"General"` / `"Other"`.
- Echo `subfolderTarget` numerically (currently only prose in `subfolderRules`).
- JSON output contract unchanged.

### Files
- `frontend/src/services/ai.js`

### Verification
- Snapshot test on the composed prompt per `subfolderTarget` (`0-5`, `5-10`,
  `10+`) asserting numeric min/max and the anti-"General" clause are present.
- Manual run against a real Gemini key (notes only, not committed as a test).

---

## Task 4: Hybrid subcategory proposals in Phase 2 `[Complex]`

### Description
Prompt changes (`services/ai.js:498-515`):
- Rule 2 → "Prefer an existing schema subcategory. If ≥ 3 bookmarks in THIS batch
  share a clear, specific theme no schema subcategory captures, you MAY introduce
  ONE new `sub_category` under the correct existing `category` (Title Case, 1–3
  words, not a synonym of an existing one)."
- Rule 3 → "Use `"General"` only when a bookmark genuinely fits the category but
  no subcategory — existing or newly proposed — applies. This should be rare."
- Output contract unchanged; a proposed subcategory is just a `sub_category`
  string absent from the schema.

Post-parse (per batch): tag results whose `(category, sub_category)` pair is not
in the schema and not `General`/`Other` with `proposed: true`. `category` stays
strictly schema-bound — a novel `category` still coerces to `Other`.

### Files
- `frontend/src/services/ai.js`

### Verification
- Unit: novel `sub_category` under a valid category → `proposed: true`, value preserved.
- Unit: novel `category` → coerced to `Other`.
- Unit: `cleanTitles` path unaffected.

---

## Task 5: Reconciliation pass `[Complex]`

### Description
New module `frontend/src/services/reconcile.js` exporting
`reconcileSubcategories(classified, schema, { subfolderTarget })`, invoked in
`organizer.js` after `classifiedActive = results.flat()` and before sort/write.

1. **Normalize & merge**: canonical key per subcategory (`trim`, collapse
   whitespace, lowercase, singularize trailing `s`); merge variants to the most
   frequent original spelling. Never merge across different top-level categories.
2. **Fold orphans**: any subcategory (proposed or schema) below `minCount`
   (`2` for `10+`, else `3`) is dissolved — bookmarks move to the closest
   remaining subcategory in the same category by token overlap, else `"General"`.
3. **Cap per category**: keep at most `max` subcategories (`5` / `10` / `16` by
   `subfolderTarget`), ranked by count; overflow folds into `"General"`.
4. Return `{ classified, summary }` with
   `summary = { proposedKept, proposedFolded, merged, orphansFolded, cappedFolded }`.

Deterministic; no AI call.

### Files
- `frontend/src/services/reconcile.js` (new)
- `frontend/src/services/organizer.js` (invoke + log summary)

### Verification
- Unit: case/plural/whitespace variants merge, highest-frequency spelling wins.
- Unit: 2-bookmark subcategory folds into nearest sibling; none → `General`.
- Unit: 20 proposed subcategories, cap 10 → 10 kept, rest → `General`.
- Unit: cross-category identical names stay separate.
- Unit: empty/degenerate input is a no-op.

---

## Task 6: Replace the silent flat fallback `[Medium]`

### Description
`services/organizer.js:494-504`:
- On `generateSchema` failure, first retry once with a **reduced sample**
  (`SCHEMA_SAMPLE_LIMIT / 2`) and default `subfolderTarget`.
- If that also fails:
  - Categories in `DEFAULT_CATEGORIES` → **curated two-level default schema** from
    new `frontend/src/services/defaultSchema.js` (~5–8 subcategories each, e.g.
    `Finance & Crypto → ["Trading & Markets", "Banking & Payments", "Crypto &
    Blockchain", "Investing & Wealth", "Tax & Economics"]`).
  - Unknown/custom categories → minimal `["General"]`.
  - Emit a `warning` **and** an `error`-styled banner log: "AI schema generation
    failed — used built-in default folders. Re-run for a tailored structure."
- Never write a schema where every category has `sub_categories: []`.

### Files
- `frontend/src/services/defaultSchema.js` (new)
- `frontend/src/services/organizer.js`

### Verification
- Unit: `generateSchema` always throws → curated schema used, `Finance & Crypto`
  gets multiple subfolders, loud log present.
- Unit: custom category `"My Stuff"` → `["General"]`, not empty.

---

## Task 7: Align HTML export with browser-write behavior `[Simple]`

### Description
`services/bookmarks_export.js` (`generateNetscapeHTML`):
- Import `shouldCreateSubFolder` from `./bookmarks`.
- Replace the `if (sub)` grouping with:
  ```js
  const cat = b.category || "Uncategorized";
  const sub = b.sub_category;
  if (!structured[cat]) structured[cat] = {};
  if (shouldCreateSubFolder(cat, sub)) {
      (structured[cat][sub] ||= []).push(b);
  } else {
      (structured[cat]['_root'] ||= []).push(b);
  }
  ```
- Result: `General` / `none` / `""` bookmarks render as direct children of the
  category `<DL>`, matching browser mode. No stray `<H3>General</H3>`.
- Delete `frontend/src/utils/generator.js` (unused; carries the same bug) and any
  now-dead exports referencing it.

### Files
- `frontend/src/services/bookmarks_export.js`
- `frontend/src/utils/generator.js` (delete)

### Verification
- Unit: bookmarks with `sub_category` of `'General'` / `'none'` / `''` → no
  `<H3>General</H3>`; links sit directly under the category `<DL><p>`.
- Unit: real subcategory still nests correctly.
- Unit: mixed (some real sub, some `General`) → real ones nested, `General` ones at category root.
- `grep -r generator.js src/` returns nothing after deletion.

---

## Task 8: Observability `[Simple]`

### Description
Stream to the progress terminal (`onProgress` `info`):
- Post-validation: `Schema: N categories, M subcategories (avg K per category).`
- Post-reconciliation: `Subcategories: +X AI-created, ~Y merged, Z folded into General.`
- Final breakdown: add a `General %` line; warn if `> 20%`.

### Files
- `frontend/src/services/organizer.js`

### Verification
- Unit: progress messages contain the schema + reconciliation summaries.
- Existing `organizer.test.js` progress-message assertions updated.

---

## Task 9: Fixtures + regression tests `[Medium]`

### Description
- `frontend/src/services/__fixtures__/finance-heavy-bookmarks.json`: ~200
  synthetic bookmarks skewed to finance/trading/crypto plus a spread of tech,
  media, shopping, travel — modeled on the failing run, no real personal data.
- `frontend/src/services/subcategory-pipeline.test.js` (new):
  1. Fixture + mocked AI returning a healthy schema + classifications → final
     result has ≥ 3 subfolders in the dominant category, `General` share < 15%,
     every bookmark placed exactly once.
  2. Mocked AI returns a flat schema on first call, healthy on the corrective
     retry → assert recovery (no all-General output).
  3. `generateSchema` always throws → assert curated fallback output.
- Export-alignment tests added to `organizer.test.js` (or a new
  `bookmarks_export.test.js`).

### Files
- `frontend/src/services/__fixtures__/finance-heavy-bookmarks.json` (new)
- `frontend/src/services/subcategory-pipeline.test.js` (new)
- `frontend/src/services/organizer.test.js` (export cases)

### Verification
- `npm test` green with the new suites.

---

## Suggested order

1 → 2 → 3   (Phase-1 reliability — independently shippable)
7           (export alignment — independent, low-risk, fixes the visible symptom fast)
4 → 5       (hybrid + reconciliation — coupled)
6           (fallback — depends on Task 1's `schemaInvalid` tag)
8 → 9       (observability + regression lock-in)

## Files to touch

- `frontend/src/services/ai.js`               (Tasks 1, 2, 3, 4)
- `frontend/src/services/organizer.js`        (Tasks 5, 6, 8)
- `frontend/src/services/reconcile.js`        (Task 5, new)
- `frontend/src/services/defaultSchema.js`    (Task 6, new)
- `frontend/src/services/bookmarks_export.js` (Task 7)
- `frontend/src/utils/generator.js`           (Task 7, delete)
- `frontend/src/services/__fixtures__/finance-heavy-bookmarks.json` (Task 9, new)
- `frontend/src/services/subcategory-pipeline.test.js`  (Task 9, new)
- `frontend/src/services/organizer.test.js`   (Tasks 8, 9)

## Risk notes

- **Folder sprawl** from Task 4 is contained by Task 5 caps; tune `minCount` /
  `max` against a real run before merge.
- Concurrent batches inventing divergent names is expected — Task 5's merge step
  is the reconciliation point; no cross-batch coordination mid-run.
- Prompt changes are model-sensitive; keep the default `gemini-3.1-flash-lite`
  in the manual test loop — cheapest and most failure-prone.
- Task 7 changes exported HTML structure for existing `General` bookmarks; call
  it out in the changelog (imported structure will differ from prior versions).
