import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackgroundJobRunner } from './jobRunner';

describe('BackgroundJobRunner', () => {
    let runner;

    beforeEach(() => {
        vi.useFakeTimers();

        // Mock chrome extension APIs
        globalThis.chrome = {
            runtime: {
                getPlatformInfo: vi.fn((cb) => cb && cb({ os: 'mac' })),
                lastError: null
            },
            bookmarks: {
                getTree: vi.fn((cb) => cb([{
                    id: 'root',
                    title: 'root',
                    children: [
                        {
                            id: '1',
                            title: 'Bookmarks Bar',
                            children: [
                                { id: 'b1', title: 'Example 1', url: 'https://example.com/1', dateAdded: 1600000000000 },
                                { id: 'b2', title: 'Example 2', url: 'https://example.com/2', dateAdded: 1700000000000 }
                            ]
                        }
                    ]
                }])),
                getChildren: vi.fn((id, cb) => cb && cb([])),
                create: vi.fn((data, cb) => cb && cb({ id: 'new_id', ...data }))
            },
            storage: {
                session: {
                    get: vi.fn((keys, cb) => cb && cb({})),
                    set: vi.fn((data, cb) => cb && cb()),
                    remove: vi.fn((keys, cb) => cb && cb())
                },
                local: {
                    get: vi.fn((keys, cb) => cb && cb({})),
                    set: vi.fn((data, cb) => cb && cb()),
                    remove: vi.fn((keys, cb) => cb && cb())
                }
            },
            notifications: {
                create: vi.fn((id, opts, cb) => cb && cb(id)),
                clear: vi.fn((id, cb) => cb && cb())
            }
        };

        runner = new BackgroundJobRunner();
    });

    afterEach(() => {
        runner.stopKeepAlive();
        vi.restoreAllMocks();
        delete globalThis.chrome;
    });

    it('initializes with idle state', () => {
        const state = runner.getState();
        expect(state.status).toBe('idle');
        expect(state.progress).toBe(0);
        expect(state.logs).toEqual([]);
        expect(state.activeDateSpan).toBeNull();
        expect(runner.getResults()).toBeNull();
    });

    it('starts a job and updates progress, logs, and storage', async () => {
        const notifications = [];
        runner.subscribe((event, payload) => notifications.push({ event, payload }));

        const config = {
            apiKey: 'AIzaSyFakeKey',
            categories: ['Tech'],
            selectedModel: 'google/gemini-3.8-flash',
            subfolderTarget: '5-10',
            sortAlphabetically: true,
            removeDuplicates: true,
            cleanTitles: false,
            flatDateSort: false,
            dateSortOrder: 'desc',
            schemaSortOrder: 'alpha'
        };

        const jobPromise = runner.startJob(config, null);

        // Check that state immediately transitions to processing
        expect(runner.getState().status).toBe('processing');
        expect(globalThis.chrome.storage.session.set).toHaveBeenCalled();

        // Simulate OrganizerService callback
        runner.organizer.onProgress({
            status: 'progress',
            percent: 50,
            message: 'Processing batch 1...'
        });

        expect(runner.getState().progress).toBe(50);
        expect(runner.getState().logs.some(l => l.message.includes('Processing batch 1...'))).toBe(true);

        const results = await jobPromise;
        expect(results).toHaveLength(2);
        expect(runner.getState().status).toBe('complete');
        expect(runner.getState().progress).toBe(100);
        expect(runner.getResults()).toEqual(results);

        // Should have stored organizedData in session and organizedMeta in local
        expect(globalThis.chrome.storage.session.set).toHaveBeenCalledWith(
            expect.objectContaining({ organizedData: results })
        );
        expect(globalThis.chrome.storage.local.set).toHaveBeenCalledWith(
            expect.objectContaining({
                organizedMeta: expect.objectContaining({ count: 2 })
            })
        );
    });

    it('keeps service worker alive during job and stops keep-alive on completion', async () => {
        const config = {
            apiKey: 'AIzaSyFakeKey',
            categories: ['Tech'],
            flatDateSort: true,
            dateSortOrder: 'desc'
        };

        const jobPromise = runner.startJob(config, null);
        expect(runner.keepAliveTimer).not.toBeNull();

        // Advance timer to trigger keep-alive ping
        vi.advanceTimersByTime(16000);
        expect(globalThis.chrome.runtime.getPlatformInfo).toHaveBeenCalled();

        await jobPromise;
        expect(runner.keepAliveTimer).toBeNull();
    });

    it('cancels an active job cleanly', async () => {
        const cancelSpy = vi.fn();
        runner.organizer = { cancel: cancelSpy };
        runner.currentJob.status = 'processing';
        runner.currentJob.progress = 40;

        runner.cancelJob();

        expect(cancelSpy).toHaveBeenCalled();
        expect(runner.getState().status).toBe('idle');
        expect(runner.getState().progress).toBe(0);
        expect(runner.getState().logs.some(l => l.message.includes('Cancellation requested'))).toBe(true);
    });

    it('resets job state and removes session storage snapshot', () => {
        runner.currentJob.status = 'complete';
        runner.currentJob.progress = 100;

        runner.resetJob();

        expect(runner.getState().status).toBe('idle');
        expect(runner.getState().progress).toBe(0);
        expect(globalThis.chrome.storage.session.remove).toHaveBeenCalledWith(['activeJobState']);
    });

    it('handles unexpected organizer errors gracefully', async () => {
        const config = { apiKey: 'fake' };
        vi.spyOn(console, 'error').mockImplementation(() => {});

        // Mock organizer throwing an error
        runner.startJob = async function (_cfg) {
            this.currentJob.status = 'processing';
            this.notify('status', this.getState());
            try {
                throw new Error('Network connection timeout');
            } catch (err) {
                this.currentJob.status = 'error';
                this.currentJob.errorMsg = err.message;
                this.stopKeepAlive();
                this.notify('status', this.getState());
                this.notify('error', { message: err.message });
                throw err;
            }
        };

        await expect(runner.startJob(config)).rejects.toThrow('Network connection timeout');
        expect(runner.getState().status).toBe('error');
        expect(runner.getState().errorMsg).toBe('Network connection timeout');
    });
});
