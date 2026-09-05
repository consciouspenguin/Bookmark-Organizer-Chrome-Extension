import { OrganizerService } from '../services/organizer';
import { calculateDateSpan } from '../utils/dates';

export class BackgroundJobRunner {
    constructor() {
        this.currentJob = {
            id: null,
            status: 'idle', // 'idle' | 'processing' | 'complete' | 'error'
            progress: 0,
            logs: [],
            activeDateSpan: null,
            backgroundNotice: '',
            errorMsg: '',
            stats: null,
            count: null
        };
        this.organizer = null;
        this.keepAliveTimer = null;
        this.subscribers = new Set();
        this.cachedResults = null;
    }

    getState() {
        return {
            ...this.currentJob,
            logs: [...this.currentJob.logs]
        };
    }

    getResults() {
        return this.cachedResults;
    }

    subscribe(listener) {
        this.subscribers.add(listener);
        return () => this.subscribers.delete(listener);
    }

    notify(event, payload) {
        for (const listener of this.subscribers) {
            try {
                listener(event, payload);
            } catch (err) {
                console.warn('[JobRunner] Listener error:', err);
            }
        }
    }

    startKeepAlive() {
        this.stopKeepAlive();
        if (typeof setInterval !== 'undefined') {
            this.keepAliveTimer = setInterval(() => {
                try {
                    if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
                        chrome.runtime.getPlatformInfo(() => {
                            // keep-alive ping
                        });
                    }
                } catch {
                    // Ignore keep-alive failure
                }
            }, 15000);
        }
    }

    stopKeepAlive() {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    persistSessionSnapshot() {
        if (typeof chrome !== 'undefined' && chrome.storage?.session) {
            try {
                chrome.storage.session.set({
                    activeJobState: {
                        id: this.currentJob.id,
                        status: this.currentJob.status,
                        progress: this.currentJob.progress,
                        logs: this.currentJob.logs.slice(-60),
                        activeDateSpan: this.currentJob.activeDateSpan,
                        backgroundNotice: this.currentJob.backgroundNotice,
                        errorMsg: this.currentJob.errorMsg,
                        stats: this.currentJob.stats,
                        count: this.currentJob.count
                    }
                });
            } catch {
                // Ignore storage session errors
            }
        }
    }

    addLog(message) {
        const entry = { message, timestamp: Date.now() };
        this.currentJob.logs.push(entry);
        if (this.currentJob.logs.length > 150) {
            this.currentJob.logs = this.currentJob.logs.slice(-100);
        }
        this.notify('log', entry);
    }

    async startJob(config, parsedBookmarks = null) {
        const {
            apiKey,
            categories,
            selectedModel,
            subfolderTarget,
            sortAlphabetically,
            removeDuplicates,
            cleanTitles,
            flatDateSort,
            dateSortOrder,
            schemaSortOrder
        } = config;

        const jobId = `job_${Date.now()}`;
        this.cachedResults = null;
        this.currentJob = {
            id: jobId,
            status: 'processing',
            progress: 0,
            logs: [],
            activeDateSpan: null,
            backgroundNotice: '',
            errorMsg: '',
            stats: null,
            count: null
        };

        this.startKeepAlive();
        this.persistSessionSnapshot();
        this.notify('status', this.getState());

        if (flatDateSort) {
            const orderLabel = dateSortOrder === 'desc' ? 'Newest First' : 'Oldest First';
            this.addLog('Starting Chronological Date Sort...');
            this.addLog('Mode: Flat List (No Folders / Schema-free)');
            this.addLog(`Sort Direction: ${orderLabel}`);
            this.addLog(`Remove Duplicate URLs: ${removeDuplicates ? 'On' : 'Off'}`);
            this.addLog(`Clean Bookmark Titles: ${cleanTitles ? 'On' : 'Off'}`);
        } else {
            this.addLog('Starting AI Organization in Background...');
            this.addLog(`Using Model: Google Gemini ${selectedModel || 'Default'}`);
            this.addLog(`Subfolder Organization: ${subfolderTarget || '5-10'}`);
            this.addLog(`Folder Content Sorting: ${schemaSortOrder || 'Alphabetical (A–Z)'}`);
            this.addLog(`Remove Duplicate URLs: ${removeDuplicates ? 'On' : 'Off'}`);
            this.addLog(`Clean Bookmark Titles: ${cleanTitles ? 'On' : 'Off'}`);
        }

        this.organizer = new OrganizerService(
            apiKey,
            categories,
            (data) => {
                if (this.currentJob.id !== jobId) return;

                if (data.dateSpan) {
                    this.currentJob.activeDateSpan = data.dateSpan;
                }
                if (data.status === 'info') {
                    this.addLog(data.message);
                } else if (data.status === 'processing') {
                    if (data.message) this.addLog(data.message);
                    if (typeof data.percent === 'number') this.currentJob.progress = data.percent;
                } else if (data.status === 'progress') {
                    if (data.message) this.addLog(data.message);
                    this.currentJob.progress = data.percent;
                    if (data.clearNotice) {
                        this.currentJob.backgroundNotice = '';
                    }
                } else if (data.status === 'retry') {
                    this.addLog(data.message);
                    this.currentJob.backgroundNotice = data.message;
                } else if (data.status === 'warning') {
                    this.addLog(data.message);
                    if (data.message?.includes('Pausing') || data.message?.includes('Retrying') || data.message?.includes('background')) {
                        this.currentJob.backgroundNotice = data.message;
                    }
                    if (data.message?.includes('cancelled')) {
                        this.currentJob.status = 'idle';
                    }
                } else if (data.status === 'error') {
                    this.currentJob.errorMsg = data.message;
                    this.currentJob.backgroundNotice = '';
                    this.currentJob.status = 'error';
                } else if (data.status === 'success') {
                    this.addLog(data.message);
                    this.currentJob.backgroundNotice = '';
                } else if (data.status === 'done') {
                    this.addLog(data.message);
                    this.currentJob.backgroundNotice = '';
                    this.currentJob.status = 'complete';
                    this.currentJob.progress = 100;
                }

                this.persistSessionSnapshot();
                this.notify('status', this.getState());
            },
            selectedModel,
            subfolderTarget,
            sortAlphabetically,
            removeDuplicates,
            cleanTitles,
            flatDateSort,
            dateSortOrder,
            schemaSortOrder
        );

        try {
            const results = await this.organizer.start(parsedBookmarks);

            if (this.organizer.isCancelled || !results) {
                this.currentJob.status = 'idle';
                this.stopKeepAlive();
                this.persistSessionSnapshot();
                this.notify('status', this.getState());
                this.notify('cancelled', {});
                return null;
            }

            if (results && results.length > 0) {
                this.cachedResults = results;
                const stats = this.organizer?.stats || results.stats || null;
                const finalSpan = stats?.dateSpan || this.currentJob.activeDateSpan || calculateDateSpan(results);
                const enrichedStats = {
                    ...(stats || {}),
                    ...(finalSpan ? { dateSpan: finalSpan } : {})
                };
                const meta = {
                    count: results.length,
                    savedAt: Date.now(),
                    stats: enrichedStats,
                    ...(finalSpan ? { dateSpan: finalSpan } : {})
                };

                this.currentJob.status = 'complete';
                this.currentJob.progress = 100;
                this.currentJob.stats = enrichedStats;
                this.currentJob.count = results.length;
                if (finalSpan) {
                    this.currentJob.activeDateSpan = finalSpan;
                }

                if (typeof chrome !== 'undefined' && chrome.storage) {
                    if (chrome.storage.session) {
                        try {
                            chrome.storage.session.set({ organizedData: results });
                        } catch { /* ignore session set errors */ }
                    }
                    if (chrome.storage.local) {
                        chrome.storage.local.set({ organizedMeta: meta });
                    }
                }

                this.stopKeepAlive();
                this.persistSessionSnapshot();
                this.notify('status', this.getState());
                this.notify('complete', { results, meta, stats: enrichedStats });
                return results;
            }

            return results;
        } catch (err) {
            console.error('[JobRunner] Execution error:', err);
            this.currentJob.status = 'error';
            this.currentJob.errorMsg = err?.message || 'Failed to complete organization.';
            this.stopKeepAlive();
            this.persistSessionSnapshot();
            this.notify('status', this.getState());
            this.notify('error', { message: this.currentJob.errorMsg });
            throw err;
        }
    }

    cancelJob() {
        if (this.organizer) {
            this.organizer.cancel();
        }
        this.currentJob.status = 'idle';
        this.currentJob.progress = 0;
        this.addLog('Cancellation requested — halting operations...');
        this.stopKeepAlive();
        this.persistSessionSnapshot();
        this.notify('status', this.getState());
        this.notify('cancelled', {});
    }

    resetJob() {
        this.cancelJob();
        this.cachedResults = null;
        this.currentJob = {
            id: null,
            status: 'idle',
            progress: 0,
            logs: [],
            activeDateSpan: null,
            backgroundNotice: '',
            errorMsg: '',
            stats: null,
            count: null
        };
        if (typeof chrome !== 'undefined' && chrome.storage?.session) {
            try {
                chrome.storage.session.remove(['activeJobState']);
            } catch {
                // Ignore removal error
            }
        }
        this.notify('status', this.getState());
    }
}

export const jobRunner = new BackgroundJobRunner();
