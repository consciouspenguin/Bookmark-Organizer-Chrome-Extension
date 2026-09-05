# Plan: Resilient Retries, Sub-batch Subdivision, Model Selection & Cancel Button

## Overview
Enhance the AI Bookmark Organizer Chrome Extension with a never-fail resilient retry engine, rate-limit cooldown handling, divide-and-conquer sub-batch subdivision, 3-tier model selection defaulting to Gemini 3.1 Flash Lite, and an interactive Cancel button.

## Global Constraints
1. **Never Fall Back to Other → General for Transient Errors**: Instead of dumping bookmarks into Other → General on batch error, wait for 429 rate limit cooldowns and subdivide failing batches into smaller chunks (50 → 25 → 12).
2. **Cancellation Responsiveness**: When cancelled by user, halt all active workers and sleep loops within 200ms, prevent writes to Chrome bookmarks, and reset UI state to idle.
3. **Model Selection**: 3 models only: 3.1 Flash Lite (Fast & Cheap) (Default), 3.8 Flash (High Accuracy), and 2.5 Pro (Deep Reasoning).
4. **Zero Test Regressions**: All 11 existing unit tests must continue passing (with updated default model expectations where applicable), and new unit tests must verify resilient retry, subdivision, and cancellation.

---

## Task 1: Core AI Resilient Retry Client

### Description
In frontend/src/services/ai.js:
- Enhance withRetry:
  - Increase retry attempts for 429 (Rate Limit) errors up to 8 attempts with progressive backoff (e.g., 5s, 10s, 20s, 30s, capped at 60s) or respecting server Retry-After.
  - Support an optional isCancelled function argument to break out of backoff sleep loops immediately in 200ms increments.
  - Support an optional onRetry({ attempt, delayMs, error, isRateLimit }) callback to notify the caller of cooldown delays.
- Update generateSchema and classifyBatch default models to "google/gemini-3.1-flash-lite".
- Forward isCancelled and onRetry from classifyBatch into withRetry.
- Add unit tests in frontend/src/services/organizer.test.js verifying rate limit retry backoff and cancellation abortion.

### Files Modified
- frontend/src/services/ai.js
- frontend/src/services/organizer.test.js

### Verification
- cd frontend && npm test

---

## Task 2: Resilient Batch Processing & Sub-batch Subdivision

### Description
In frontend/src/services/organizer.js:
- Update OrganizerService constructor default model parameter to "google/gemini-3.1-flash-lite".
- Implement resilient retry with automatic divide-and-conquer sub-batch splitting (classifyWithSubdivision):
  - On retry pass, instead of catching errors and immediately dumping all bookmarks into Other → General, if a batch encounters an error (like model truncation or JSON formatting issues), subdivide the batch in half (e.g., 50 → 25 → 12) and retry the smaller sub-batches.
  - Log helpful progress messages to terminal: Splitting batch ... into smaller chunks of 25 to classify cleanly...
  - Pass () => this.isCancelled and onRetry callback into classifyBatch.
- Add cancellation checks (if (this.isCancelled) return null;):
  - Immediately after schema generation.
  - Inside worker loop (processNext) after classifyBatch returns.
  - Before writing bookmarks to Chrome / downloading file.
- Update unit tests in frontend/src/services/organizer.test.js covering default model "google/gemini-3.1-flash-lite", batch subdivision on error, and rate-limit retry handling.

### Files Modified
- frontend/src/services/organizer.js
- frontend/src/services/organizer.test.js

### Verification
- cd frontend && npm test

---

## Task 3: Streamlined Model Selector & Cancel Button UI

### Description
In frontend/src/components/Organizer.jsx:
- Streamline models list to the 3 exact tiers:
  1. google/gemini-3.1-flash-lite: 3.1 Flash Lite, badge: Fast & Cheap, description: 3.1 Flash Lite: Recommended default — ultra-fast latency and minimal token cost.
  2. google/gemini-3.8-flash: 3.8 Flash, badge: High Accuracy, description: 3.8 Flash: Highest taxonomy accuracy with fast response times.
  3. google/gemini-2.5-pro: 2.5 Pro, badge: Deep Reasoning, description: 2.5 Pro: Deepest reasoning model for intricate or ambiguous bookmark hierarchies.
- Set default selectedModel state to 'google/gemini-3.1-flash-lite'.
- Add isCancelling state (useState(false)) and handleCancel callback (useCallback):
  - Calls organizerRef.current.cancel().
  - Sets isCancelling(true).
  - Adds log Cancellation requested — halting operations....
- In startProcess:
  - Reset isCancelling(false).
  - If organizerRef.current?.isCancelled or !results, set status('idle').
  - In finally, ensure isCancelling(false).
- In the UI action section:
  - When status === 'processing', render:
    - Disabled progress indicator button: Processing... {progress}%.
    - Active Cancel button: <Square size={16} fill="currentColor" /> {isCancelling ? 'Cancelling...' : 'Cancel'} with error theme styling.
- Verify that status returns cleanly to 'idle' upon cancellation and start button can be clicked again.

### Files Modified
- frontend/src/components/Organizer.jsx

### Verification
- cd frontend && npm test
- cd frontend && npm run build
- Rebuild zip: cd frontend/dist && zip -FSr ../../bookmark-organizer-extension.zip .
