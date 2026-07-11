// HTML escape function to prevent XSS
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
    let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

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
                    if (safeUrl) {
                        html += `            <DT><A HREF="${safeUrl}" ADD_DATE="${now}"${iconAttribute(item.icon)}>${safeTitle}</A>\n`;
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
                if (safeUrl) {
                    html += `        <DT><A HREF="${safeUrl}" ADD_DATE="${now}"${iconAttribute(item.icon)}>${safeTitle}</A>\n`;
                }
            });
        }

        html += `    </DL><p>\n`;
    }

    html += `</DL><p>`;
    return html;
}

export function downloadBookmarks(bookmarks, filename = "organized_bookmarks.html") {
    const html = generateNetscapeHTML(bookmarks);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);

    if (typeof chrome !== 'undefined' && chrome.downloads) {
        chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: true
        });
    } else {
        // Fallback for non-extension environment or if permission missing
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
}
