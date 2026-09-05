import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupSidePanel, getConnectedPortCount } from './index';
import { jobRunner } from './jobRunner';

describe('Background Service Worker Entry Point', () => {
    beforeEach(() => {
        globalThis.chrome = {
            sidePanel: {
                setPanelBehavior: vi.fn().mockResolvedValue(),
                open: vi.fn().mockResolvedValue()
            },
            windows: {
                getCurrent: vi.fn((cb) => cb && cb({ id: 123 }))
            },
            runtime: {
                onConnect: {
                    addListener: vi.fn()
                },
                onInstalled: {
                    addListener: vi.fn()
                },
                onStartup: {
                    addListener: vi.fn()
                },
                getPlatformInfo: vi.fn((cb) => cb && cb({ os: 'mac' })),
                lastError: null
            },
            notifications: {
                create: vi.fn((id, opts, cb) => cb && cb(id)),
                clear: vi.fn((id, cb) => cb && cb()),
                onClicked: {
                    addListener: vi.fn()
                }
            },
            storage: {
                session: {
                    set: vi.fn(),
                    remove: vi.fn()
                },
                local: {
                    remove: vi.fn()
                }
            }
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.chrome;
    });

    it('sets up side panel behavior on action click', async () => {
        setupSidePanel();
        expect(globalThis.chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({
            openPanelOnActionClick: true
        });
    });

    it('triggers desktop notification when job completes and side panel is closed (no connected ports)', () => {
        expect(getConnectedPortCount()).toBe(0);

        jobRunner.notify('complete', {
            meta: { count: 42 },
            results: [{ id: '1' }]
        });

        expect(globalThis.chrome.notifications.create).toHaveBeenCalledWith(
            'organizer-job-complete',
            expect.objectContaining({
                title: 'AI Bookmark Organizer',
                message: expect.stringContaining('42 bookmarks ready to review and download')
            }),
            expect.any(Function)
        );
    });

    it('opens side panel when organizer notification is clicked', () => {
        // Re-trigger notification click handler logic
        if (typeof globalThis.chrome.notifications.onClicked.addListener === 'function') {
            const clickHandler = (notificationId) => {
                if (notificationId.startsWith('organizer-job')) {
                    if (globalThis.chrome.sidePanel?.open && globalThis.chrome.windows?.getCurrent) {
                        globalThis.chrome.windows.getCurrent((win) => {
                            if (win?.id) {
                                globalThis.chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
                            }
                        });
                    }
                    globalThis.chrome.notifications.clear(notificationId, () => {});
                }
            };

            clickHandler('organizer-job-complete');
            expect(globalThis.chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 123 });
            expect(globalThis.chrome.notifications.clear).toHaveBeenCalledWith('organizer-job-complete', expect.any(Function));
        }
    });
});
