// Background service worker for AI Bookmark Organizer

function setupSidePanel() {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
            .catch((error) => console.error('Error setting side panel behavior:', error));
    }
}

// Ensure panel opens instantly on action click:
// 1. Run top-level immediately on service worker start/wakeup
setupSidePanel();

// 2. Run on extension install or update
chrome.runtime.onInstalled.addListener(() => {
    setupSidePanel();
});

// 3. Run on browser startup
chrome.runtime.onStartup.addListener(() => {
    setupSidePanel();
});

// 4. Fallback: if openPanelOnActionClick is not intercepted by Chrome, handle action click directly
chrome.action.onClicked.addListener(async (tab) => {
    try {
        if (chrome.sidePanel && chrome.sidePanel.open && tab?.windowId) {
            await chrome.sidePanel.open({ windowId: tab.windowId });
        }
    } catch (error) {
        console.error('Failed to open side panel on action click:', error);
    }
});

