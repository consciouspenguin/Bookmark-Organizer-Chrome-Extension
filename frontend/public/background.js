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
    // Purge v1.1.x-era storage bloat at upgrade time so the panel never has to.
    // organizedData from that era can hold hundreds of MB of base64 icons; the
    // panel-side cleanup only runs if the panel stays open for 3s.
    if (chrome.storage?.local) {
        chrome.storage.local.remove(['organizedData', 'flatDateSort'], () => {
            if (chrome.runtime.lastError) {
                console.warn('Legacy storage cleanup failed:', chrome.runtime.lastError.message);
            }
        });
    }
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

