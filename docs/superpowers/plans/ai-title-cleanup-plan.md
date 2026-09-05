# AI Title Cleanup Implementation Plan

## Overview
Introduce an optional "Clean Bookmark Titles with AI" feature. When enabled, messy, truncated, or raw-URL bookmark titles (such as "Login | GitHub", "10 Best Practices... - FreeCodeCamp", or "https://domain.com/article-slug") are rewritten into clean, concise, human-readable titles during the classification pass with zero extra API overhead.

## Global Constraints
- Zero extra API calls: Title cleanup must be integrated directly into the classifyBatch prompt/payload rather than a separate API step.
- Opt-in / Non-destructive: When cleanTitles is false (or omitted), original titles must be preserved verbatim.
- Graceful Fallback: If the model omits clean_title or returns an empty string, always fall back to the bookmark's original title.
- Offline / Dead Link Safety: Dead links quarantined under Archive -> Broken Links bypass the AI and keep their original titles.

## Task 1: AI Prompt and Service Layer for Title Cleanup

### Description
Extend classifyBatch in frontend/src/services/ai.js to accept cleanTitles = false.
When cleanTitles is true:
- Include title cleanup instructions in the prompt.
- Tell the model: if cleanTitles is active, return { "classified": [ { "i": 0, "category": "...", "sub_category": "...", "clean_title": "..." } ] }.
- In the map function that reconstructs the bookmark objects, if cleanTitles is true and entry.clean_title is a non-empty string, set title: entry.clean_title.trim(), otherwise retain b.title.

### Files Modified
- frontend/src/services/ai.js
- frontend/src/services/organizer.test.js

### Verification
- Run: cd frontend && npm test

## Task 2: Organizer Service Integration

### Description
Update OrganizerService in frontend/src/services/organizer.js to support the cleanTitles parameter.
- Add cleanTitles = false to the constructor signature:
  constructor(apiKey, categories, onProgress, model = "google/gemini-3.1-flash-lite", subfolderTarget = "5-10", sortAlphabetically = true, removeDuplicates = true, cleanTitles = false)
- Store this.cleanTitles = cleanTitles.
- Pass this.cleanTitles into classifyBatch(batchData, this.apiKey, schema, this.model, this.cleanTitles) across both the initial pass and the retry pass.
- In organizer.test.js, add tests verifying cleanTitles is stored on the instance and passed through.

### Files Modified
- frontend/src/services/organizer.js
- frontend/src/services/organizer.test.js

### Verification
- Run: cd frontend && npm test

## Task 3: UI Settings Toggle and Persistence

### Description
Expose the "Clean Bookmark Titles" feature in the user interface in frontend/src/components/Organizer.jsx.
- Add cleanTitles state: const [cleanTitles, setCleanTitles] = useState(false)
- In the useEffect loading block, read cleanTitles from chrome.storage.local.
- Add handleCleanTitlesToggle callback using updateSetting('cleanTitles', enabled).
- Render a toggle control under the Organization Settings section:
  Clean Titles with AI (rewrites messy or truncated titles)
- Add cleanTitles to the start log: Clean Bookmark Titles: On/Off.
- Pass cleanTitles as the 8th argument to new OrganizerService(...).
- Include cleanTitles in Organizer.jsx dependency arrays.

### Files Modified
- frontend/src/components/Organizer.jsx

### Verification
- Run: cd frontend && npm test
- Run: cd frontend && npm run build
