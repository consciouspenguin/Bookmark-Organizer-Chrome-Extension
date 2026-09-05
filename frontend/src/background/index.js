// Background service worker for AI Bookmark Organizer
import { jobRunner } from './jobRunner';

export function setupSidePanel() {
    if (typeof chrome !== 'undefined' && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
            .catch((error) => console.error('Error setting side panel behavior:', error));
    }
}

// Track active side panel connection ports
const connectedPorts = new Set();

export function getConnectedPortCount() {
    return connectedPorts.size;
}

// Listen for connections from the side panel UI
if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) {
    chrome.runtime.onConnect.addListener((port) => {
        if (port.name !== 'organizer-channel') return;

        connectedPorts.add(port);

        // Immediately send current state on connection
        try {
            port.postMessage({ type: 'STATUS_UPDATE', payload: jobRunner.getState() });
        } catch (err) {
            console.warn('[Background] Failed to send initial state:', err);
        }

        port.onMessage.addListener(async (msg) => {
            if (!msg || !msg.type) return;

            switch (msg.type) {
                case 'GET_STATUS':
                    try {
                        port.postMessage({ type: 'STATUS_UPDATE', payload: jobRunner.getState() });
                    } catch {}
                    break;

                case 'START_JOB':
                    try {
                        const { config, parsedBookmarks } = msg.payload || {};
                        await jobRunner.startJob(config, parsedBookmarks);
                    } catch (err) {
                        console.error('[Background] Job start error:', err);
                    }
                    break;

                case 'CANCEL_JOB':
                    jobRunner.cancelJob();
                    break;

                case 'RESET_JOB':
                    jobRunner.resetJob();
                    break;

                default:
                    console.warn('[Background] Unknown port message type:', msg.type);
            }
        });

        port.onDisconnect.addListener(() => {
            connectedPorts.delete(port);
            console.log(`[Background] Side panel disconnected. Active ports remaining: ${connectedPorts.size}`);
        });
    });
}

// Broadcast job events to connected ports and handle background notifications
jobRunner.subscribe((event, payload) => {
    // 1. Broadcast to any open side panel ports
    for (const port of connectedPorts) {
        try {
            if (event === 'status' || event === 'log') {
                port.postMessage({ type: 'STATUS_UPDATE', payload: jobRunner.getState() });
            } else if (event === 'complete') {
                port.postMessage({ type: 'JOB_COMPLETE', payload });
            } else if (event === 'error') {
                port.postMessage({ type: 'JOB_ERROR', payload });
            } else if (event === 'cancelled') {
                port.postMessage({ type: 'JOB_CANCELLED', payload });
            }
        } catch (err) {
            console.warn('[Background] Port postMessage failed:', err);
        }
    }

    // 2. If the side panel is CLOSED when organization completes, trigger desktop notification
    if (connectedPorts.size === 0 && typeof chrome !== 'undefined' && chrome.notifications?.create) {
        if (event === 'complete') {
            const count = payload?.meta?.count || payload?.results?.length || 0;
            const countLabel = count > 0 ? `${count.toLocaleString()} bookmarks` : 'Bookmarks';
            chrome.notifications.create('organizer-job-complete', {
                type: 'basic',
                iconUrl: 'icon128.png',
                title: 'AI Bookmark Organizer',
                message: `Organization complete! ${countLabel} ready to review and download.`,
                priority: 2
            }, () => {
                if (chrome.runtime.lastError) {
                    console.warn('[Background] Notification error:', chrome.runtime.lastError.message);
                }
            });
        } else if (event === 'error') {
            chrome.notifications.create('organizer-job-error', {
                type: 'basic',
                iconUrl: 'icon128.png',
                title: 'AI Bookmark Organizer',
                message: `Organization halted: ${payload?.message || 'Unexpected error'}.`,
                priority: 2
            }, () => {});
        }
    }
});

// Handle clicking on desktop notifications -> open side panel
if (typeof chrome !== 'undefined' && chrome.notifications?.onClicked) {
    chrome.notifications.onClicked.addListener((notificationId) => {
        if (notificationId.startsWith('organizer-job')) {
            if (chrome.sidePanel?.open && chrome.windows?.getCurrent) {
                chrome.windows.getCurrent((win) => {
                    if (win?.id) {
                        chrome.sidePanel.open({ windowId: win.id }).catch((err) => {
                            console.warn('[Background] Failed to open side panel on notification click:', err);
                        });
                    }
                });
            }
            chrome.notifications.clear(notificationId, () => {});
        }
    });
}

// 1. Run on extension install or update
if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
    chrome.runtime.onInstalled.addListener(() => {
        console.log('AI Bookmark Organizer extension installed/updated.');
        setupSidePanel();
        if (chrome.storage?.local) {
            chrome.storage.local.remove(['organizedData', 'flatDateSort'], () => {
                if (chrome.runtime?.lastError) {
                    console.warn('Legacy storage cleanup failed:', chrome.runtime.lastError.message);
                }
            });
        }
    });
}

// 2. Run on browser startup
if (typeof chrome !== 'undefined' && chrome.runtime?.onStartup) {
    chrome.runtime.onStartup.addListener(() => {
        setupSidePanel();
    });
}

// 3. Initial execution on service worker startup
try {
    setupSidePanel();
} catch (e) {
    console.warn('Initial side panel setup deferred:', e);
}
