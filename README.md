# AI Bookmark Organizer (Chrome Extension)

Turn years of messy, unsorted bookmarks into a clean, browsable folder structure in one click — powered by Google Gemini via OpenRouter. Runs entirely in your browser's side panel: no account, no server, no data collection.

<img src="assets/feature_showcase.png" alt="AI Bookmark Organizer Features - Your Digital Knowledge Hub" width="100%">

## 🚀 Features

- **One-Click Organization** — Reads your browser bookmarks and sorts hundreds of links into intuitive categories and subfolders automatically.
- **Two-Phase AI Pipeline** — First generates a single global folder schema from your *entire* collection, then classifies every bookmark against that fixed schema. This eliminates the redundant near-duplicate folders ("Tech News" vs. "Tech Articles") that naive batch-by-batch classification produces.
- **Adjustable Folder Granularity** — Choose how detailed the structure should be:
  - **Compact (0–5)** subfolders per category — minimal, broad folders
  - **Balanced (5–10)** — the recommended default
  - **Detailed (10+)** — fine-grained, topic-specific folders
- **Custom Categories** — Start from 10 sensible defaults (Technology & Coding, News & Research, Finance & Business, …) and add or remove top-level categories to fit your collection.
- **Model Selection** — Pick the Gemini model that fits your needs: 3.5 Flash (best accuracy), 2.5 Pro, 2.5 Flash, or 3.1 Flash Lite (lightweight).
- **Two Input Modes**
  - **Browser mode**: organizes your live Chrome bookmarks into a new dated folder (e.g. `AI Organized Bookmarks-2026-06-10`) under *Other Bookmarks*.
  - **File mode**: drag & drop any exported `bookmarks.html`, get back a cleaned-up, importable HTML file — works with bookmarks from any browser. Embedded favicons are preserved in the output, though for very large bookmark files some or all icons may be skipped to keep memory usage in check (oversized icons and anything beyond a 25 MB total budget). Browsers re-fetch favicons automatically as you visit pages, so skipped icons reappear over time.
- **Non-Destructive** — Your original bookmarks are never moved or deleted. Organized copies are created alongside them, so you can review before committing.
- **Fast** — Bookmarks are classified in concurrent batches, so even large collections finish quickly.
- **Live Progress Log** — A terminal-style output shows the generated schema, batch progress, and timestamps as the run unfolds.
- **Light / Dark / System Themes** — A slate-blue palette derived from the app icon, with a one-click theme toggle.

## ⚙️ How It Works

1. **Read** — Collects bookmarks from your browser (or an uploaded HTML file). Only titles and URLs are used.
2. **Design** — Gemini analyzes the full collection and proposes a non-redundant two-level folder schema, guided by your category and granularity preferences.
3. **Classify** — Bookmarks are classified in parallel batches against that fixed schema, so every link lands in exactly one folder.
4. **Write** — Results are saved as new bookmark folders in Chrome, or downloaded as a standard importable HTML file.

## 📥 Installation

You can install this extension manually (no Store required) by downloading the latest release.

**➡️ [Download the latest release](https://github.com/n1ecC/Bookmark-Organizer-Chrome-Extension/releases/latest)** — or grab the zip directly: **[bookmark-organizer-v1.1.2.zip](https://github.com/n1ecC/Bookmark-Organizer-Chrome-Extension/releases/download/v1.1.2/bookmark-organizer-v1.1.2.zip)**

### Method 1: Download & Install (Easiest)
1.  **Download**: Grab **[bookmark-organizer-v1.1.2.zip](https://github.com/n1ecC/Bookmark-Organizer-Chrome-Extension/releases/download/v1.1.2/bookmark-organizer-v1.1.2.zip)** from the [Releases page](https://github.com/n1ecC/Bookmark-Organizer-Chrome-Extension/releases/latest).
2.  **Unzip**: Extract the zip file to a folder on your computer.
3.  **Open Chrome Extensions**:
    - Type `chrome://extensions` in your address bar.
    - Enable **Developer mode** (top right switch).
4.  **Load**:
    - Click **Load unpacked**.
    - Select the folder inside the unzipped location (it should contain `manifest.json`).
5.  **Done!** The extension icon should appear in your toolbar.

> Requires Chrome 114 or newer (uses the Side Panel API).

### Method 2: Build from Source
If you are a developer and want to modify the code:
```bash
git clone https://github.com/consciouspenguin/Bookmark-Organizer-Chrome-Extension.git
cd Bookmark-Organizer-Chrome-Extension/frontend
npm install
npm run build
# Then load the 'dist' folder in chrome://extensions
```

## 🔑 Getting Started

1. Create a free API key at [openrouter.ai](https://openrouter.ai/) (`sk-or-...`).
2. Click the extension icon to open the side panel and paste your key — it is stored locally in your browser and never leaves it except to authenticate with OpenRouter.
3. Pick a model, tune your categories and subfolder granularity (optional), and hit **Organize My Bookmarks**.

## 🔒 Privacy

We do not collect data. Your API key is stored locally in your browser. Bookmark titles and URLs are sent directly to the OpenRouter API for categorization and immediately discarded — there is no middleman server.
[Read our Privacy Policy](docs/privacy.html)

## 🛠️ Tech Stack

- **Frontend**: React 19 + Vite, rendered in Chrome's Side Panel
- **AI**: Google Gemini models via the OpenRouter API
- **Extension**: Manifest V3 (`storage`, `bookmarks`, `downloads`, `sidePanel` permissions)

## License

This project is licensed under the **GNU General Public License v3.0** — see the [LICENSE](LICENSE) file for the full text.

Copyright (C) 2026 Amado Evert
