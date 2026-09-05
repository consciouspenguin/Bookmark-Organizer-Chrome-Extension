// Background service worker for AI Bookmark Organizer

function setupSidePanel() {
    if (typeof chrome !== 'undefined' && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
            .catch((error) => console.error('Error setting side panel behavior:', error));
    }
}

// 1. Run on extension install or update (recommended official entry point)
chrome.runtime.onInstalled.addListener(() => {
    console.log('AI Bookmark Organizer extension installed/updated.');
    setupSidePanel();
});

// 2. Run on browser startup
chrome.runtime.onStartup.addListener(() => {
    setupSidePanel();
});

// 3. Initial execution on service worker startup
try {
    setupSidePanel();
} catch (e) {
    console.warn('Initial side panel setup deferred:', e);
}

