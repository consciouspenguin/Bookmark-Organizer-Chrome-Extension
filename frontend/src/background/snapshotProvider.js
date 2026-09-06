const MAX_BACKUP_BYTES = 8 * 1024 * 1024; // spec §5: over the bound, warn and proceed

export function createStorageSnapshotProvider(log = () => {}) {
    return async (survivors, doomedDuplicates) => {
        const items = [...survivors, ...doomedDuplicates].map((b) => ({
            title: b.title,
            url: b.url,
            add_date: b.add_date || (b.dateAdded ? String(Math.floor(b.dateAdded / 1000)) : undefined)
        }));
        const json = JSON.stringify(items);
        if (json.length > MAX_BACKUP_BYTES) {
            log(`Pre-write backup skipped: ${items.length} bookmarks exceed the ${Math.round(MAX_BACKUP_BYTES / (1024 * 1024))} MB storage bound. Recovery relies on an idempotent re-run.`);
            return;
        }
        await new Promise((resolve, reject) => {
            chrome.storage.local.set(
                { preWriteBackup: { savedAt: Date.now(), count: items.length, items } },
                () => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve();
                }
            );
        });
    };
}
