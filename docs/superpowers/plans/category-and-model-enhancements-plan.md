# Category & Model UI Enhancements Implementation Plan

## Overview
Address UI bugs and feature requests:
1. Fix the AI model selector bug where model button text was not displaying (`model.name` was undefined).
2. Redesign the "Sort by Date Added (Flat List)" card with standout styling, a distinct mode badge, icon container, and informational banner so users immediately recognize this alternative pipeline.
3. Reorder default categories (`Work & Career` first, `Tech & Development` last), add a "Clear All" button, and add a second list of 10 unique but common suggested categories below the active ones with green `+` action buttons that pop them into the chosen categories bin.

## Global Constraints
- Zero regressions in existing 39 Vitest tests.
- Persist category changes (`categories`) to `chrome.storage.local`.
- Clean responsive layout matching the extension design tokens in both dark and light modes.
- Dist build and zip package must be kept in sync.

---

## Task 1: Fix AI Model Selector Display Bug

### Description
In `frontend/src/components/Organizer.jsx`:
- Update `models` to include `name`, `label`, `badge`, `desc`, and `description` for all three models:
  - `3.1 Flash Lite` (Badge: "Default", Desc: "Recommended default — ultra-fast latency and minimal token cost.")
  - `3.8 Flash` (Badge: "Balanced", Desc: "High intelligence and balanced reasoning for everyday bookmark collections.")
  - `3.1 Pro Preview` (Badge: "Deep Reasoning", Desc: "Maximum taxonomy depth and structure for large, complex hierarchies.")
- In the button rendering, use `model.name || model.label`.
- In the model description area, fall back cleanly: `models.find(m => m.id === selectedModel)?.description || models.find(m => m.id === selectedModel)?.desc`.
- Ensure text contrast and layout render properly.

### Files Modified
- `frontend/src/components/Organizer.jsx`

### Verification
- Visual inspection & code review.
- Run `npm test` in `frontend/`.

---

## Task 2: Differentiated Standout Styling for Flat Date Sort Card

### Description
In `frontend/src/components/Organizer.jsx`:
- Elevate the "Sort by Date Added (Flat List)" card container:
  - Add a distinct accent border and subtle background gradient when active (`linear-gradient(135deg, var(--surface-alt), rgba(130, 149, 184, 0.16))`).
  - Add a top mode badge (`⚡ FLAT MODE • ZERO AI TOKENS` when active, `Alternative Mode` when inactive).
  - Wrap the `Clock` icon in an avatar container with glowing accent background when enabled.
  - Add an active-mode explanatory callout: "Flat Chronological Pipeline: Bypasses AI categorization, schema design, and folder hierarchies. Exports a clean sequential list of all bookmarks in chronological order. Fast and 100% offline."
  - Preserve chronological direction toggle ("Newest First" vs "Oldest First").

### Files Modified
- `frontend/src/components/Organizer.jsx`

### Verification
- Run `npm test` in `frontend/`.

---

## Task 3: Category Customization (Reorder, Clear All, and 10-Item Suggested Pool)

### Description
In `frontend/src/components/Organizer.jsx`:
- Re-order `DEFAULT_CATEGORIES`:
  1. `Work & Career` (first)
  2. `Finance & Crypto`
  3. `Design & Media`
  4. `Reading & Knowledge`
  5. `Entertainment & Social`
  6. `Shopping & Tools`
  7. `Travel & Lifestyle`
  8. `Tech & Development` (last)
- Define `SUGGESTED_ADDABLE_CATEGORIES` with 10 brainstormed unique but common categories:
  1. `Health, Fitness & Wellness`
  2. `AI & Machine Learning`
  3. `News & Current Affairs`
  4. `Recipes & Cooking`
  5. `Education & Academia`
  6. `Open Source & Code`
  7. `Home, DIY & Real Estate`
  8. `Podcasts, Audio & Music`
  9. `Gaming & Esports`
  10. `Legal, Docs & Admin`
- Add category handlers that sync to storage:
  - `handleAddCategory(catName)`
  - `handleRemoveCategory(idx)`
  - `handleClearAllCategories()`
  - `handleResetDefaultCategories()`
- In "Customize Categories" header:
  - Display active count badge (`X active`).
  - Add `Clear All` button (or `Reset Defaults` if empty).
- Render second list below chosen categories:
  - "Suggested Categories (Click + to Add)"
  - Displays any of the 10 suggestions not yet in `categories`.
  - Each chip has category title and green plus icon (`Plus` with `color: var(--success)`).
  - Clicking a chip pops it into the chosen categories bin and saves to storage.

### Files Modified
- `frontend/src/components/Organizer.jsx`

### Verification
- Run `npm test` in `frontend/`.

---

## Task 4: Bundle Rebuild & Verification

### Description
- Run `npm test` (all 39 tests passing).
- Run `npm run build` in `frontend/`.
- Re-package `bookmark-organizer-extension.zip` from `frontend/dist/`.
- Commit and push to `origin/feat/ai-title-cleanup`.

### Files Modified
- `bookmark-organizer-extension.zip`
- `frontend/dist/*`

### Verification
- Clean git status, passing tests, clean zip package.
