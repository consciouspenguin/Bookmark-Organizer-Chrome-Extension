/**
 * Utility functions for extracting bookmark timestamps and calculating date ranges.
 */

// Normalizes Chrome API dateAdded (milliseconds), Netscape add_date (seconds), and ISO date strings to epoch milliseconds.
export function getBookmarkTimestamp(bookmark) {
    if (!bookmark) return 0;

    const dateVal = bookmark.dateAdded ?? bookmark.date_added ?? bookmark.date;
    // Chrome API dateAdded is epoch milliseconds
    if (typeof dateVal === 'number' && !isNaN(dateVal) && dateVal > 0) {
        return dateVal < 1e11 ? dateVal * 1000 : dateVal;
    }
    if (typeof dateVal === 'string') {
        const trimmed = dateVal.trim();
        if (/^\d+$/.test(trimmed)) {
            const num = Number(trimmed);
            return num > 0 ? (num < 1e11 ? num * 1000 : num) : 0;
        }
        const parsed = Date.parse(trimmed);
        if (!isNaN(parsed) && parsed > 0) return parsed;
    }

    // Netscape HTML add_date is epoch seconds
    const addDateVal = bookmark.add_date ?? bookmark.ADD_DATE;
    if (addDateVal) {
        if (typeof addDateVal === 'number' && !isNaN(addDateVal) && addDateVal > 0) {
            return addDateVal < 1e11 ? addDateVal * 1000 : addDateVal;
        }
        if (typeof addDateVal === 'string') {
            const trimmed = addDateVal.trim();
            if (/^\d+$/.test(trimmed)) {
                const num = Number(trimmed);
                return num > 0 ? (num < 1e11 ? num * 1000 : num) : 0;
            }
            const parsed = Date.parse(trimmed);
            if (!isNaN(parsed) && parsed > 0) return parsed;
        }
    }

    return 0;
}

/**
 * Calculates the formatted date range (oldest date to newest date) from an array of bookmarks.
 * Returns null if no valid timestamps exist.
 * If oldest and newest dates are on the same day, returns the single date.
 * Otherwise returns `${oldestDate} – ${newestDate}`.
 */
export function calculateDateSpan(bookmarks) {
    if (!bookmarks) return null;
    if (bookmarks.stats?.dateSpan) return bookmarks.stats.dateSpan;
    if (bookmarks.dateSpan) return bookmarks.dateSpan;

    const list = Array.isArray(bookmarks)
        ? bookmarks
        : (Array.isArray(bookmarks.bookmarks) ? bookmarks.bookmarks : null);

    if (!list || list.length === 0) return null;

    let minTime = Infinity;
    let maxTime = -Infinity;

    for (let i = 0; i < list.length; i++) {
        const t = getBookmarkTimestamp(list[i]);
        if (t > 0) {
            if (t < minTime) minTime = t;
            if (t > maxTime) maxTime = t;
        }
    }

    if (minTime === Infinity || maxTime === -Infinity) return null;

    const minDate = new Date(minTime).toLocaleDateString();
    const maxDate = new Date(maxTime).toLocaleDateString();
    return minDate === maxDate ? minDate : `${minDate} – ${maxDate}`;
}
