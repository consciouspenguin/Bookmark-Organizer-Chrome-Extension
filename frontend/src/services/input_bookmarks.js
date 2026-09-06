// File-mode input preservation (spec §12): the pristine dropped-in HTML is the date
// source of truth for file mode. Cached raw, never mutated by organize runs.
export const INPUT_MAX_BYTES = 25 * 1024 * 1024;
const STORAGE_KEY = 'inputBookmarks';

const local = () => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) throw new Error('chrome.storage.local unavailable');
    return chrome.storage.local;
};

export async function saveInputBookmarkFile({ filename, html, count, dateSpan }) {
    if (html.length > INPUT_MAX_BYTES) return { saved: false, reason: 'too-large' };
    const entry = { filename, html, size: html.length, savedAt: Date.now(), count, dateSpan };
    await new Promise((resolve, reject) => {
        local().set({ [STORAGE_KEY]: entry }, () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
        });
    });
    return { saved: true, entry };
}

export async function getInputBookmarkFile() {
    return new Promise((resolve, reject) => {
        local().get([STORAGE_KEY], (res) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(res?.[STORAGE_KEY] || null);
        });
    });
}

export async function removeInputBookmarkFile() {
    return new Promise((resolve, reject) => {
        local().remove([STORAGE_KEY], () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
        });
    });
}

export function downloadInputBookmarkFile(entry) {
    const name = entry.filename || 'input_bookmarks.html';
    const blob = new Blob([entry.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
        chrome.downloads.download({ url, filename: name, saveAs: true });
    } else if (typeof document !== 'undefined' && document.createElement) {
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
