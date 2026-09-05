# How to Test the Chrome Extension

## Automated Unit & Integration Tests
Run the test suite to verify that organization works, never stalls on network issues or rate limits, bounds retries cleanly, and actually progresses to completion:
```bash
cd frontend
npm test
```

To run ESLint:
```bash
npm run lint
```

## Prerequisites for Manual Chrome Testing
1.  **Build the Project**:
    - Ensure you have Node.js and npm installed.
    - Run the build command in the `frontend` directory:
      ```bash
      cd frontend
      npm install
      npm run build
      ```
    - This creates a `dist` folder containing the compiled extension assets.

## Loading the Extension in Chrome
1.  Open Google Chrome and navigate to `chrome://extensions/`.
2.  Toggle **Developer mode** in the top-right corner.
3.  Click the **Load unpacked** button (top-left).
4.  Select the `frontend/dist` folder in the project directory.
    - **Note**: Do not select the `public` or `src` folder; it must be the `dist` folder.

## Verification Steps

### 1. Functional Testing
- **Extension Side Panel**: Click the extension icon in the toolbar. Verify that the side panel UI opens smoothly and displays: *Powered by Google Gemini*.
- **API Key Configuration**: Enter your Google AI Studio key (`AIza...`) or OpenRouter key (`sk-or-...`). Verify that it is saved locally (it stays populated when you close and reopen the side panel). Direct links are provided below the input field.
- **Model & Sorting Selection**:
  - Select from the 3 Gemini tiers (**3.1 Flash Lite**, **3.8 Flash**, or **3.1 Pro Preview**).
  - Choose an intra-folder sorting option (Alphabetical A–Z, Date Added Newest/Oldest First, Website / Domain A–Z, Reverse Alphabetical).
- **Organization Modes**:
  - **Browser Mode**: Without uploading a file, click the **Organize My Bookmarks** button. Verify that it scans your browser bookmarks, shows real-time batch progression in the terminal, and creates an `AI Organized Bookmarks-[Date]` folder under *Other Bookmarks*.
  - **File Mode**: Drag and drop a bookmarks HTML file (or browse to select one), and click **Organize File & Download**. Verify that an organized bookmarks file download is initiated with all links preserved.
  - **Flat Chronological Date Sort (0 AI Tokens)**: Toggle "Sort by Date Added (Flat List)". Verify that the API key requirement is removed, and bookmarks are sorted purely by timestamp without folders or AI token usage.
- **Network Resilience & Progress**:
  - If rate limits (429) occur, a warning banner informs you of the cooldown pause before retrying.
  - If network drops occur, batches retry cleanly without infinite loops or recursive explosion, and preserved bookmarks are filed under `Other → General` so 0 bookmarks are lost.
  - Real-time progress percentages and log updates actively move from 0% to 100% until "Organization complete!".
- **Interactive Cancellation**:
  - During an active run, click the **Cancel** button. Verify that operations halt within 200ms and the UI returns to the idle state.

### 2. Developer Console & Security Checks
- **Console Errors**:
    - Right-click inside the extension side panel and choose **Inspect** to open DevTools.
    - Navigate to the **Console** tab.
    - Run the organization process and verify that there are no JavaScript or Content Security Policy (CSP) errors.
    - Try to execute `eval('alert(1)')` in the console. It **should fail** under Manifest V3 default CSP.
