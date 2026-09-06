# AI Bookmark Organizer (Chrome Extension)

Turn years of messy, unsorted bookmarks into a clean, browsable folder structure in one click — powered by Google Gemini via OpenRouter. Runs entirely in your browser's side panel: no account, no server, no data collection.

## 🚀 Features

- **One-Click Organization** — Reads your browser bookmarks and sorts hundreds of links into intuitive categories and subfolders automatically.
- **Two-Phase AI Pipeline** — First generates a single global folder schema from your *entire* collection, then classifies every bookmark against that fixed schema. This eliminates the redundant near-duplicate folders ("Tech News" vs. "Tech Articles") that naive batch-by-batch classification produces.
- **Adjustable Folder Granularity** — Choose how detailed the structure should be:
  - **Compact (0–5)** subfolders per category — minimal, broad folders
  - **Balanced (5–10)** — the recommended default
  - **Detailed (10+)** — fine-grained, topic-specific folders
- **Custom Categories** — Start from 10 sensible defaults (Technology & Coding, News & Research, Finance & Business, …) and add or remove top-level categories to fit your collection.
- **Model Selection** — Pick the Gemini model that fits your needs: **3.1 Flash Lite** (ultra-fast latency & minimal cost, recommended default), **3.8 Flash** (balanced intelligence for everyday collections), or **3.1 Pro Preview** (complex taxonomies & rich nested structures).
- **Intra-Folder Content Sorting** — Choose how bookmarks are sorted inside each category folder: Alphabetical (A–Z), Date Added (Newest First), Date Added (Oldest First), By Website / Domain (A–Z), or Reverse Alphabetical (Z–A).
- **Flat Chronological Date Sorting (0 AI Tokens)** — Optional offline mode to compile all bookmarks strictly by timestamp without folders or AI schema design.
- **Clean Titles with AI** — Optional smart title rewriting to shorten bloated URL titles and strip boilerplate tracking tags.
- **Two Input Modes**
  - **Browser mode**: organizes your live Chrome bookmarks into a new dated folder (e.g. `AI Organized Bookmarks-2026-06-10`) under *Other Bookmarks*.
  - **File mode**: drag & drop any exported `bookmarks.html`, get back a cleaned-up, importable HTML file — works with bookmarks from any browser. Embedded favicons are preserved in the output, though for very large bookmark files some or all icons may be skipped to keep memory usage in check (oversized icons and anything beyond a 25 MB total budget). Browsers re-fetch favicons automatically as you visit pages, so skipped icons reappear over time.
- **Non-Destructive** — Your original bookmarks are never moved or deleted. Organized copies are created alongside them, so you can review before committing.
- **Persistent Background Execution** — Organization runs reliably in the Chrome background service worker even if the side panel is closed or reopened. Reopening the side panel seamlessly reconnects to live progress and logs, and a native desktop notification alerts you when organization finishes.
- **Fast & Resilient** — Bookmarks are classified in concurrent batches with automatic rate-limit backoff, sub-batch size adaptation, and a live Cancel button.
- **Live Progress Log** — A terminal-style output shows the generated schema, batch progress, and timestamps as the run unfolds.
- **Light / Dark / System Themes** — A slate-blue palette derived from the app icon, with a one-click theme toggle.

## ⚙️ How It Works

1. **Read** — Collects bookmarks from your browser (or an uploaded HTML file). Only titles and URLs are used.
2. **Design** — Gemini analyzes the full collection and proposes a non-redundant two-level folder schema, guided by your category and granularity preferences.
3. **Classify** — Bookmarks are classified in parallel batches against that fixed schema, so every link lands in exactly one folder.
4. **Write** — Results are saved as new bookmark folders in Chrome, or downloaded as a standard importable HTML file.

## 📥 Installation

You can install this extension manually (no Store required) by downloading the latest release.

**➡️ [Download the latest release (v1.2.0)](https://github.com/ne1cc/Bookmark-Organizer-Chrome-Extension/releases/latest)** — or grab the zip directly: **[bookmark-organizer-extension.zip](https://github.com/ne1cc/Bookmark-Organizer-Chrome-Extension/releases/download/v1.2.0/bookmark-organizer-extension.zip)**

### Method 1: Download & Install (Easiest)
1. **Download**: Grab **[bookmark-organizer-extension.zip](https://github.com/ne1cc/Bookmark-Organizer-Chrome-Extension/releases/download/v1.2.0/bookmark-organizer-extension.zip)** from the [Releases page](https://github.com/ne1cc/Bookmark-Organizer-Chrome-Extension/releases/latest).
2. **Unzip**: Extract the zip file to a folder on your computer.
3. **Open Chrome Extensions**:
   - Type `chrome://extensions` in your address bar.
   - Enable **Developer mode** (top right switch).
4. **Load**:
   - Click **Load unpacked**.
   - Select the unzipped folder (containing `manifest.json`).
5. **Done!** The extension icon should appear in your toolbar.

> Requires Chrome 114 or newer (uses the Side Panel API).

### Method 2: Build from Source
If you are a developer and want to modify the code:
```bash
git clone https://github.com/ne1cc/Bookmark-Organizer-Chrome-Extension.git
cd Bookmark-Organizer-Chrome-Extension/frontend
npm install

# Chrome:
npm run build:chrome
# Load the 'dist' folder in chrome://extensions

# Firefox:
npm run build:firefox
# Load 'dist/manifest.json' in about:debugging -> This Firefox -> Load Temporary Add-on

# Package for Firefox AMO:
npm run package:firefox
```

## 🔑 Getting Started

1. Create a free API key at [Google AI Studio](https://aistudio.google.com/app/apikey) (`AIza...`) or [OpenRouter](https://openrouter.ai/keys) (`sk-or-...`). Direct minimal links are provided right below the input field in the extension.
2. Click the extension icon to open the side panel and paste your key. The extension detects its provider automatically; it is stored locally in your browser and only sent to that provider for authentication.
3. Pick a model, tune your categories and folder sorting (optional), and hit **Organize My Bookmarks**.

## 📋 Changelog

### v1.2.0 (Latest Release) — Major Feature & Reliability Release

#### 🌟 New Features & Enhancements
- **Intra-Folder Content Sorting**: Added 5 folder sorting schemas (`Alphabetical A–Z`, `Date Added Newest First`, `Date Added Oldest First`, `By Website / Domain A–Z`, and `Reverse Alphabetical Z–A`).
- **Sort by Date Added (Flat List)**: Added an independent chronological ordering mode that bypasses folder generation and uses **0 AI tokens** (100% offline & free), styled with a refined slate neutral border. Toggled off by default on every extension open.
- **Clean Titles with AI**: Added an optional setting to intelligently clean and shorten truncated or messy web titles.
- **Gemini Model Lineup Update**: Upgraded default model to `Gemini 3.1 Flash Lite` for near-instant latency and lowest token consumption, alongside `Gemini 3.8 Flash` and `Gemini 3.1 Pro Preview`.
- **Quick API Key Links**: Added minimal direct links below the API key input to jump straight to Google AI Studio and OpenRouter key generation pages in a new tab.
- **Suggested Categories & Clear All**: Added a curated suggested category pool (Health & Wellness, AI & ML, Recipes, Gaming, etc.) with quick-add buttons and a 1-click "Clear All Categories" button.
- **Instant Schema Copy**: Added a button to copy the generated category distribution breakdown directly to the clipboard.

#### 🛡️ Reliability & Performance Fixes
- **Sub-Second Instant Startup (<200ms)**: Added synchronous in-process memory bootstrap (`localStorage` fast-path), deferred LevelDB disk cleanup, and an inline CSS pre-render skeleton in `index.html`, eliminating cold-start disk contention and cutting side panel launch latency from >10s to under 200ms.
- **Side Panel Startup Fix**: Fixed toolbar click conflicts by properly managing `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` without duplicate action listeners.
- **Storage Optimization & Instant Boot**: Moved ephemeral bookmark tree caching from disk LevelDB to memory-based session storage (`chrome.storage.session`), keeping persistent storage tiny (<5 KB) and eliminating cold-start delays.
- **Adaptive Sub-Batch Subdivision**: Automatically splits batches if payload limits or context boundaries are exceeded, preventing `413 Payload Too Large` errors on massive collections.
- **Resilient Retry Backoff**: Enhanced exponential backoff with server-directed cooldowns and rate-limit handling.
- **Safe CSP Compliance**: Disabled external link prefetch probing that previously triggered strict Manifest V3 Content Security Policy warnings.

---

### v1.1.4
- Added duplicate URL detection and removal toggle.
- Added support for large HTML bookmark imports with memory-bounded favicon handling.
- Improved live progress logging terminal.

## 🔒 Privacy

We do not collect data. Your API key is stored locally in your browser. Bookmark titles and URLs are sent directly to Google AI Studio or OpenRouter for categorization and immediately discarded — there is no middleman server.
[Read our Privacy Policy](docs/privacy.html)

## 🛠️ Tech Stack

- **Frontend**: React 19 + Vite, rendered in Chrome's Side Panel
- **AI**: Google Gemini models via Google AI Studio or the OpenRouter API
- **Extension**: Manifest V3 (`storage`, `bookmarks`, `downloads`, `sidePanel` permissions)

## License

This project is licensed under the **GNU General Public License v3.0** — see the [LICENSE](LICENSE) file for the full text.

Copyright (C) 2026 Amado Evert
