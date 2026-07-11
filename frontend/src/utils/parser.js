// Favicon retention limits. Embedded icons are kept only while they fit the
// budget: small collections keep every icon, huge exports degrade gracefully
// instead of stalling or OOM-ing the panel (the icons exist only to be written
// back into the organized file — the AI never sees them).
export const ICON_MAX_SIZE = 50 * 1024;            // skip any single freak icon
export const ICON_TOTAL_BUDGET = 25 * 1024 * 1024; // cumulative cap across the file

/**
 * Parses the Netscape Bookmark HTML content and extracts links.
 * @param {string} htmlContent - The raw HTML content of the bookmarks file.
 * @returns {Array} - Array of bookmark objects {title, url, add_date, icon?}.
 */
export const parseBookmarks = (htmlContent) => {
    // Filter favicon attributes BEFORE parsing: exports carry a base64 ICON
    // on every <A>, so DOMParser would otherwise build a DOM holding hundreds
    // of MB of icon data. Icons within budget pass through and are read back
    // after parsing; everything else is stripped here.
    let iconBudget = ICON_TOTAL_BUDGET;
    const stripped = htmlContent.replace(/\s(ICON|ICON_URI)="([^"]*)"/gi, (match, attr, value) => {
        if (attr.toUpperCase() !== "ICON") return "";       // ICON_URI is never used
        if (!/^data:image\//i.test(value)) return "";       // embedded data URLs only
        if (value.length > ICON_MAX_SIZE) return "";
        if (value.length > iconBudget) return "";
        iconBudget -= value.length;
        return match;
    });

    const parser = new DOMParser();
    const doc = parser.parseFromString(stripped, "text/html");
    const links = [];

    doc.querySelectorAll("a").forEach(a => {
        const url = a.href;
        // Basic validation. Deduplication is controlled later by the organizer
        // so the user's toggle works consistently for file and browser modes.
        if (url && !url.startsWith("place:")) {
            const entry = {
                title: a.textContent.trim() || "Untitled",
                url: url,
                add_date: a.getAttribute("add_date")
            };
            const icon = a.getAttribute("icon");
            if (icon) entry.icon = icon;
            links.push(entry);
        }
    });

    return links;
};
