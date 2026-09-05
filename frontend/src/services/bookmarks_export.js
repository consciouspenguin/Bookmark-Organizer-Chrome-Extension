import { calculateDateSpan } from '../utils/dates';

// HTML escape function to prevent XSS
function escapeHtml(text) {
    if (!text) return '';
    if (typeof document !== 'undefined' && document.createElement) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Embed a favicon only when it is a pure base64 image data URL: the strict
// charset (no quotes, angle brackets or ampersands) guarantees the value
// cannot break out of the quoted attribute.
function iconAttribute(icon) {
    if (typeof icon === 'string' && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*$/i.test(icon)) {
        return ` ICON="${icon}"`;
    }
    return '';
}

// URL sanitization - only allow http/https protocols
function sanitizeUrl(url) {
    if (!url) return '';
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return escapeHtml(url);
        }
        return '';
    } catch {
        return '';
    }
}

export function generateNetscapeHTML(bookmarks) {
    const now = Math.floor(Date.now() / 1000);
    const dateSpan = bookmarks?.stats?.dateSpan || bookmarks?.dateSpan || calculateDateSpan(bookmarks);
    let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
${dateSpan ? `     Date range: ${dateSpan}\n` : ''}     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

    const isFlat = Boolean(bookmarks?.isFlat) || (Array.isArray(bookmarks) && bookmarks.length > 0 && bookmarks.every(b => !b.category));

    if (isFlat) {
        bookmarks.forEach(item => {
            const safeTitle = escapeHtml(item.title);
            const safeUrl = sanitizeUrl(item.url);
            const itemAddDate = item.add_date || (item.dateAdded ? Math.floor(item.dateAdded / 1000) : now);
            if (safeUrl) {
                html += `    <DT><A HREF="${safeUrl}" ADD_DATE="${itemAddDate}"${iconAttribute(item.icon)}>${safeTitle}</A>\n`;
            }
        });
        html += `</DL><p>`;
        return html;
    }

    // Group by category and subcategory
    const structured = {};

    bookmarks.forEach(b => {
        const cat = b.category || "Uncategorized";
        const sub = b.sub_category || null;

        if (!structured[cat]) structured[cat] = {};
        if (sub) {
            if (!structured[cat][sub]) structured[cat][sub] = [];
            structured[cat][sub].push(b);
        } else {
            if (!structured[cat]['_root']) structured[cat]['_root'] = [];
            structured[cat]['_root'].push(b);
        }
    });

    for (const [category, content] of Object.entries(structured)) {
        const safeCategory = escapeHtml(category);
        html += `    <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">${safeCategory}</H3>\n`;
        html += `    <DL><p>\n`;

        // Subcategories
        for (const [sub, items] of Object.entries(content)) {
            if (sub !== '_root') {
                const safeSub = escapeHtml(sub);
                html += `        <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}">${safeSub}</H3>\n`;
                html += `        <DL><p>\n`;
                items.forEach(item => {
                    const safeTitle = escapeHtml(item.title);
                    const safeUrl = sanitizeUrl(item.url);
                    const itemAddDate = item.add_date || (item.dateAdded ? Math.floor(item.dateAdded / 1000) : now);
                    if (safeUrl) {
                        html += `            <DT><A HREF="${safeUrl}" ADD_DATE="${itemAddDate}"${iconAttribute(item.icon)}>${safeTitle}</A>\n`;
                    }
                });
                html += `        </DL><p>\n`;
            }
        }

        // Root items in category
        if (content['_root']) {
            content['_root'].forEach(item => {
                const safeTitle = escapeHtml(item.title);
                const safeUrl = sanitizeUrl(item.url);
                const itemAddDate = item.add_date || (item.dateAdded ? Math.floor(item.dateAdded / 1000) : now);
                if (safeUrl) {
                    html += `        <DT><A HREF="${safeUrl}" ADD_DATE="${itemAddDate}"${iconAttribute(item.icon)}>${safeTitle}</A>\n`;
                }
            });
        }

        html += `    </DL><p>\n`;
    }

    html += `</DL><p>`;
    return html;
}

export function downloadBookmarks(bookmarks, filename = "organized_bookmarks.html") {
    const defaultName = bookmarks?.isFlat ? "chronological_bookmarks.html" : "organized_bookmarks.html";
    const actualFilename = filename === "organized_bookmarks.html" ? defaultName : filename;
    const html = generateNetscapeHTML(bookmarks);

    let url;
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        try {
            const blob = new Blob([html], { type: "text/html" });
            url = URL.createObjectURL(blob);
        } catch {
            url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
        }
    } else {
        url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    }

    if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
        chrome.downloads.download({
            url: url,
            filename: actualFilename,
            saveAs: true
        });
    } else if (typeof document !== 'undefined' && document.createElement) {
        const a = document.createElement('a');
        a.href = url;
        a.download = actualFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
}
