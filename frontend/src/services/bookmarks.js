export async function getBookmarks() {
    return new Promise((resolve) => {
        chrome.bookmarks.getTree((tree) => {
            resolve(tree);
        });
    });
}

export function flattenBookmarks(tree) {
    const flattened = [];
    const traverse = (node) => {
        if (node.url) {
            flattened.push({
                id: node.id,
                title: node.title,
                url: node.url,
                parentId: node.parentId,
                dateAdded: node.dateAdded
            });
        }
        if (node.children) {
            node.children.forEach(traverse);
        }
    };
    tree.forEach(traverse);
    return flattened;
}

export async function createFolder(parentId, title) {
    return new Promise((resolve, reject) => {
        chrome.bookmarks.create({ parentId: parentId, title: title }, (result) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(result);
            }
        });
    });
}

export async function createBookmark(parentId, title, url) {
    return new Promise((resolve, reject) => {
        chrome.bookmarks.create({ parentId: parentId, title: title, url: url }, (result) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(result);
            }
        });
    });
}

export async function moveBookmark(id, parentId) {
    return new Promise((resolve, reject) => {
        chrome.bookmarks.move(id, { parentId: parentId }, (result) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(result);
            }
        });
    });
}

let folderCache = {};

export function clearFolderCache() {
    folderCache = {};
}

export function shouldCreateSubFolder(category, subCategory) {
    if (!subCategory) return false;
    const sub = subCategory.trim().toLowerCase();
    const cat = category.trim().toLowerCase();
    return sub !== '' && sub !== 'general' && sub !== 'none' && sub !== 'uncategorized' && sub !== cat;
}

export async function findOrCreateFolder(parentId, title) {
    const key = `${parentId}_${title}`;
    if (folderCache[key]) {
        return folderCache[key];
    }

    const promise = new Promise((resolve, reject) => {
        chrome.bookmarks.getChildren(parentId, (children) => {
            if (chrome.runtime.lastError) {
                createFolder(parentId, title).then(resolve).catch(reject);
                return;
            }
            const existing = children?.find(c => c.title === title && !c.url);
            if (existing) {
                resolve(existing);
            } else {
                createFolder(parentId, title).then(resolve).catch(reject);
            }
        });
    });

    folderCache[key] = promise;
    return promise;
}

