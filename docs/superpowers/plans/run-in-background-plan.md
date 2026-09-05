# Run in Background Implementation Plan

## Overview
Decouple bookmark organization execution from the React side panel lifecycle by delegating execution to the Chrome Manifest V3 background service worker (`background.js`). When a user starts organization, the background service worker executes `OrganizerService` persistently. If the side panel is closed or reopened at any point, execution continues uninterrupted, progress is mirrored to `chrome.storage.session`, real-time updates stream back to the panel upon reconnection, and a native Chrome desktop notification is displayed upon completion if the panel is closed.

## Global Constraints
- Zero regressions in existing 79 Vitest tests.
- Manifest V3 compliant: Background service worker bundled as an ES module (`"type": "module"`).
- Keep-alive heartbeat: Prevent Chrome from suspending the service worker during rate-limit backoffs or reachability checks.
- Zero data loss: Progress, date span, and organized bookmark output saved to `chrome.storage.session` and `chrome.storage.local`.
- Graceful test environment fallback: If `chrome.runtime.connect` is absent (jsdom/Vitest), fall back smoothly to direct in-process execution.

---

## Task 1: Multi-Entry Vite Bundling & Manifest V3 Configuration

### Description
Configure Vite to compile both `index.html` (side panel React app) and `src/background/index.js` (service worker) as ES modules into `dist/`.
1. Update `frontend/public/manifest.json`:
   - Add `"notifications"` to `permissions`.
   - Update `background`:
     ```json
     "background": {
         "service_worker": "background.js",
         "type": "module"
     }
     ```
2. Remove static `frontend/public/background.js` (to avoid conflicting with Vite's bundled output).
3. Update `frontend/vite.config.js`:
   - Add multi-entry rollup inputs for `index` (`index.html`) and `background` (`src/background/index.js`).
   - Configure output `entryFileNames` so the service worker is emitted as `background.js` in the root of `dist/`.

### Files Modified
- `frontend/public/manifest.json`
- `frontend/vite.config.js`
- `frontend/public/background.js` (removed / migrated)
- `frontend/src/background/index.js` (created)

### Verification
- `npm run build` succeeds and produces `dist/background.js` and `dist/index.html`.
- `npm test` runs without configuration errors.

---

## Task 2: Background Job Manager & Keep-Alive Service

### Description
Create `frontend/src/background/jobRunner.js` to manage the background organization lifecycle:
1. **Singleton Job State**:
   - Holds active job state: `id`, `status` (`'idle' | 'processing' | 'complete' | 'error'`), `progress` (0–100), `logs` array, `activeDateSpan`, `backgroundNotice`, `errorMsg`, and `results`.
2. **MV3 Service Worker Keep-Alive**:
   - While `status === 'processing'`, run a 20-second heartbeat interval (e.g. `chrome.runtime.getPlatformInfo()`) to prevent service worker termination during rate-limit backoffs or link-probing waits.
   - Clean up heartbeat when the job finishes, errors, or cancels.
3. **Session Persistence**:
   - On progress updates and milestone events, mirror `activeJobState` to `chrome.storage.session`.
   - On completion, write `organizedData` to `chrome.storage.session` and `organizedMeta` to `chrome.storage.local`.
4. **Port Connection Hub (`src/background/index.js`)**:
   - Listen for `chrome.runtime.onConnect` with channel name `'organizer-channel'`.
   - Handle incoming messages:
     - `START_JOB`: Parse configuration, instantiate `OrganizerService`, and launch pipeline.
     - `CANCEL_JOB`: Cancel active `OrganizerService` and update state.
     - `GET_STATUS`: Respond with current job snapshot.
   - Stream `STATUS_UPDATE`, `JOB_COMPLETE`, `JOB_ERROR`, and `JOB_CANCELLED` events to connected port(s).
   - On `port.onDisconnect`: clear port reference without interrupting running job.

### Files Modified / Created
- `frontend/src/background/jobRunner.js`
- `frontend/src/background/index.js`
- `frontend/src/background/jobRunner.test.js`

### Verification
- Unit test coverage for job runner states, progress callbacks, cancellation, and session storage writes.

---

## Task 3: Side Panel UI Reconnection & Background Client

### Description
Update `frontend/src/components/Organizer.jsx` to interface with the background runner:
1. **Port Connection & Hydration**:
   - Establish `chrome.runtime.connect({ name: 'organizer-channel' })` when available.
   - In `useEffect` on mount, read `chrome.storage.session.get('activeJobState')`.
   - If a background job is already `processing`, automatically restore progress bar, logs, date range pill, and cancellation button.
   - If `complete`, restore completion view and load results for download.
2. **Job Dispatching**:
   - In `startProcess()`, dispatch `START_JOB` to the port if connected.
   - Subscribe to port messages to update React state (`progress`, `logs`, `activeDateSpan`, `backgroundNotice`, `status`).
   - If running outside of extension environment (tests), fall back transparently to direct `OrganizerService` instantiation.
3. **Cancellation**:
   - Send `CANCEL_JOB` to port.

### Files Modified
- `frontend/src/components/Organizer.jsx`
- `frontend/src/components/Organizer.test.jsx`

### Verification
- `npm test` passes all tests.
- Add test cases simulating background job reconnection and message handling.

---

## Task 4: Desktop Notifications & Click-to-Open

### Description
Implement desktop notifications when organization finishes in the background:
1. In `src/background/index.js` / `jobRunner.js`:
   - When a job completes or errors, check if any port is currently connected.
   - If no port is connected (side panel is closed):
     - Trigger `chrome.notifications.create('organizer-job-complete', ...)` with title "AI Bookmark Organizer" and bookmark count summary.
2. Notification Click Handling:
   - Add listener `chrome.notifications.onClicked.addListener`.
   - Open the side panel using `chrome.sidePanel.open` or focus Chrome window.
   - Clear notification on click.

### Files Modified
- `frontend/src/background/index.js`

### Verification
- Verify notification creation logic when port is disconnected.
- End-to-end extension build verification.

---

## Task 5: Full Regression Testing & Release Build

### Description
Run the full test suite and verify build artifacts:
1. Run `npm test` across all frontend tests (ensure 100% pass rate).
2. Run `npm run build` and inspect `dist/`:
   - Verify `dist/manifest.json` contains `"notifications"` and `"type": "module"`.
   - Verify `dist/background.js` exists and bundles required service code.
   - Verify `dist/index.html` loads bundled scripts properly.
3. Verify git diff and commit using Conventional Commits.
