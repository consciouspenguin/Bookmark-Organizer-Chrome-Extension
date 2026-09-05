import { getBookmarks, createBookmark, findOrCreateFolder, clearFolderCache, shouldCreateSubFolder } from './bookmarks';
import { generateSchema, classifyBatch, SCHEMA_SAMPLE_LIMIT, isNetworkError, isRateLimitError } from './ai';
import { downloadBookmarks } from './bookmarks_export';

// Fast reachability probe for URLs using no-cors and an aggressive timeout.
// Resolves true for reachable or indeterminate hosts; returns false only on DNS/network failure or timeout.
export async function checkUrlReachable(url, timeoutMs = 2500) {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("check timeout")), timeoutMs);
    try {
        await fetch(url, { method: 'HEAD', mode: 'no-cors', signal: controller.signal });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

// Concurrently probes bookmark URLs in parallel chunks so verification completes in seconds.
// Dead/unreachable links are segregated to Archive -> Broken Links to bypass AI classification.
export async function filterReachableBookmarks(bookmarks, onProgress, isCancelled) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return { activeLinks: bookmarks, deadLinks: [] };
    }

    const activeLinks = [];
    const deadLinks = [];
    const total = bookmarks.length;
    let completed = 0;

    const concurrency = 15;
    let currentIndex = 0;

    const worker = async () => {
        while (currentIndex < total && !isCancelled()) {
            const idx = currentIndex++;
            const item = bookmarks[idx];
            const isReachable = await checkUrlReachable(item.url);
            if (isReachable) {
                activeLinks.push(item);
            } else {
                deadLinks.push({
                    ...item,
                    category: 'Archive',
                    sub_category: 'Broken Links'
                });
            }
            completed++;
            if (completed % 25 === 0 || completed === total) {
                onProgress({
                    status: 'info',
                    message: `Checking link reachability: ${completed}/${total}...`
                });
            }
        }
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, total); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    return { activeLinks, deadLinks };
}

// Preserve the first occurrence so the output stays deterministic and never
// writes more than one bookmark for an exact duplicate URL.
export function removeDuplicateUrls(bookmarks) {
    const seenUrls = new Set();
    return bookmarks.filter((bookmark) => {
        if (seenUrls.has(bookmark.url)) return false;
        seenUrls.add(bookmark.url);
        return true;
    });
}

// Normalizes both Chrome API dateAdded (milliseconds) and Netscape add_date (seconds) to milliseconds
export function getBookmarkTimestamp(bookmark) {
    if (!bookmark) return 0;
    // Chrome API dateAdded is epoch milliseconds
    if (typeof bookmark.dateAdded === 'number' && !isNaN(bookmark.dateAdded) && bookmark.dateAdded > 0) {
        return bookmark.dateAdded < 1e11 ? bookmark.dateAdded * 1000 : bookmark.dateAdded;
    }
    if (typeof bookmark.dateAdded === 'string') {
        const trimmed = bookmark.dateAdded.trim();
        if (/^\d+$/.test(trimmed)) {
            const num = Number(trimmed);
            return num > 0 ? (num < 1e11 ? num * 1000 : num) : 0;
        }
        const parsed = Date.parse(trimmed);
        if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    // Netscape HTML add_date is epoch seconds
    if (bookmark.add_date) {
        if (typeof bookmark.add_date === 'number' && !isNaN(bookmark.add_date) && bookmark.add_date > 0) {
            return bookmark.add_date < 1e11 ? bookmark.add_date * 1000 : bookmark.add_date;
        }
        if (typeof bookmark.add_date === 'string') {
            const trimmed = bookmark.add_date.trim();
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
    if (!Array.isArray(bookmarks) || bookmarks.length === 0) return null;
    let minTime = Infinity;
    let maxTime = -Infinity;

    for (let i = 0; i < bookmarks.length; i++) {
        const t = getBookmarkTimestamp(bookmarks[i]);
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

// Normalizes and extracts hostname/domain from bookmark URL
export function getBookmarkDomain(bookmark) {
    if (!bookmark || !bookmark.url) return '';
    try {
        const hostname = new URL(bookmark.url).hostname.toLowerCase();
        return hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

export class OrganizerService {
    constructor(apiKey, categories, onProgress, model = "google/gemini-3.1-flash-lite", subfolderTarget = "5-10", sortAlphabetically = true, removeDuplicates = true, cleanTitles = false, flatDateSort = false, dateSortOrder = "desc", schemaSortOrder = undefined) {
        this.apiKey = apiKey;
        this.categories = categories;
        this.onProgress = onProgress || (() => { });
        this.model = model;
        this.subfolderTarget = subfolderTarget;
        this.removeDuplicates = removeDuplicates;
        this.cleanTitles = cleanTitles;
        this.flatDateSort = flatDateSort;
        this.dateSortOrder = dateSortOrder; // 'desc' (newest first) or 'asc' (oldest first)

        // schemaSortOrder can be 'alpha', 'date-desc', 'date-asc', 'domain', 'alpha-desc', or 'none'
        if (schemaSortOrder !== undefined) {
            this.schemaSortOrder = schemaSortOrder;
            this.sortAlphabetically = schemaSortOrder === 'alpha';
        } else {
            this.sortAlphabetically = sortAlphabetically;
            this.schemaSortOrder = sortAlphabetically ? 'alpha' : 'none';
        }

        this.batchSize = 50;
        this.isCancelled = false;
        this.stats = {
            total: 0,
            duplicatesRemoved: 0,
            deadLinksArchived: 0,
            categoriesCount: 0,
            categoryBreakdown: {},
            isFlat: flatDateSort,
            dateSortOrder,
            schemaSortOrder: this.schemaSortOrder,
            dateSpan: null
        };
    }

    cancel() {
        this.isCancelled = true;
    }

    async classifyWithSubdivision(batchData, schema, label = '') {
        if (this.isCancelled) return [];

        try {
            return await classifyBatch(
                batchData,
                this.apiKey,
                schema,
                this.model,
                this.cleanTitles,
                () => this.isCancelled,
                ({ delayMs, isRateLimit }) => {
                    const sec = Math.ceil(delayMs / 1000);
                    this.onProgress({
                        status: 'warning',
                        message: isRateLimit
                            ? `Rate limit reached (429). Pausing for ${sec}s before retrying batch ${label}...`
                            : `Network issue on batch ${label}. Retrying in ${sec}s...`
                    });
                }
            );
        } catch (err) {
            if (this.isCancelled || err?.isCancelled) {
                return [];
            }

            // Permanent errors (400-404), network dropouts/timeouts, rate limits (429),
            // and server gateway errors (500/502/503/504) cannot be resolved by splitting the batch.
            // Avoid pointless recursive subdivision that stalls organization with exponential retries.
            const isPermanentApiError = [400, 401, 403, 404].includes(err?.statusCode);
            const isNetwork = isNetworkError(err);
            const isRateLimit = isRateLimitError(err);
            const isServerUnavailable = [500, 502, 503, 504].includes(err?.statusCode);

            const canSubdivide = batchData.length > 5 &&
                                 !isPermanentApiError &&
                                 !isNetwork &&
                                 !isRateLimit &&
                                 !isServerUnavailable;

            if (canSubdivide) {
                const mid = Math.ceil(batchData.length / 2);
                this.onProgress({
                    status: 'info',
                    message: `Splitting batch ${label} (${batchData.length} items) into smaller chunks of ${mid} to ensure 100% classification...`
                });
                const left = await this.classifyWithSubdivision(batchData.slice(0, mid), schema, `${label}.1`);
                const right = await this.classifyWithSubdivision(batchData.slice(mid), schema, `${label}.2`);
                return [...left, ...right];
            }

            console.error(`Batch ${label} failed on second pass:`, err);
            this.onProgress({
                status: 'warning',
                message: isNetwork
                    ? `Batch ${label} could not be classified due to network issues (${err.message}). Its ${batchData.length} bookmarks were filed under Other → General so none are lost.`
                    : `Batch ${label} could not be classified (${err.message}). Its ${batchData.length} bookmarks were filed under Other → General so none are lost.`
            });
            return batchData.map(b => ({
                ...b,
                category: 'Other',
                sub_category: 'General'
            }));
        }
    }

    calculateAdaptiveBatchSize(totalBookmarks) {
        const isProModel = this.model.includes('pro');

        if (totalBookmarks < 50) {
            return isProModel ? 20 : 30;
        } else if (totalBookmarks < 200) {
            return isProModel ? 30 : 45;
        } else {
            return isProModel ? 40 : 50;
        }
    }

    async start(fileBookmarks = null) {
        let allLinks = [];

        if (fileBookmarks) {
            this.onProgress({ status: 'info', message: 'Processing uploaded file...' });
            allLinks = fileBookmarks;
        } else {
            this.onProgress({ status: 'info', message: 'Reading bookmarks (Browser)...' });
            const tree = await getBookmarks();

            const traverse = (nodes) => {
                for (const node of nodes) {
                    if (node.url) {
                        if (node.url.startsWith('http')) {
                            allLinks.push({
                                title: node.title,
                                url: node.url,
                                id: node.id,
                                dateAdded: node.dateAdded,
                                add_date: node.dateAdded ? String(Math.floor(node.dateAdded / 1000)) : undefined
                            });
                        }
                    }
                    if (node.children) {
                        traverse(node.children);
                    }
                }
            };
            traverse(tree);
        }

        this.onProgress({ status: 'info', message: `Found ${allLinks.length} bookmarks.` });

        let duplicatesRemoved = 0;
        if (this.removeDuplicates) {
            const originalCount = allLinks.length;
            allLinks = removeDuplicateUrls(allLinks);
            duplicatesRemoved = originalCount - allLinks.length;
            this.onProgress({
                status: 'info',
                message: duplicatesRemoved > 0
                    ? `Removed ${duplicatesRemoved} duplicate URL${duplicatesRemoved === 1 ? '' : 's'} from the organized result.`
                    : 'No duplicate URLs found.'
            });
        }

        if (allLinks.length === 0) {
            this.onProgress({ status: 'done', message: 'No bookmarks to organize.' });
            return null;
        }

        if (!this.flatDateSort || this.cleanTitles) {
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                this.onProgress({
                    status: 'error',
                    message: 'No internet connection detected. Please check your network and try again.'
                });
                return null;
            }
        }

        if (this.flatDateSort) {
            let processedLinks = allLinks;

            if (this.cleanTitles && this.apiKey) {
                this.onProgress({ status: 'info', message: 'Cleaning bookmark titles with AI...' });
                const dummySchema = { categories: [{ name: 'Bookmarks', sub_categories: [] }] };
                const batchSize = this.calculateAdaptiveBatchSize(processedLinks.length);
                const batches = [];
                for (let i = 0; i < processedLinks.length; i += batchSize) {
                    batches.push({
                        index: batches.length,
                        batchData: processedLinks.slice(i, i + batchSize)
                    });
                }

                const cleanedBatches = new Array(batches.length);
                for (let i = 0; i < batches.length; i++) {
                    if (this.isCancelled) break;
                    this.onProgress({
                        status: 'processing',
                        message: `Cleaning titles (batch ${i + 1}/${batches.length})...`,
                        percent: Math.round((i / batches.length) * 100)
                    });
                    cleanedBatches[i] = await this.classifyWithSubdivision(batches[i].batchData, dummySchema, `${i + 1}`);
                }
                if (this.isCancelled) {
                    this.onProgress({ status: 'warning', message: 'Process cancelled.' });
                    return null;
                }
                processedLinks = cleanedBatches.flat().filter(Boolean);
            }

            // Ensure no categories/folders are attached
            const finalResults = processedLinks.map(b => ({
                ...b,
                category: null,
                sub_category: null
            }));

            // Chronological sort
            const isDesc = this.dateSortOrder !== 'asc'; // default 'desc' (newest first)
            this.onProgress({
                status: 'info',
                message: `Sorting ${finalResults.length} bookmarks chronologically (${isDesc ? 'Newest First' : 'Oldest First'})...`
            });

            finalResults.sort((a, b) => {
                const timeA = getBookmarkTimestamp(a);
                const timeB = getBookmarkTimestamp(b);
                if (timeA > 0 && timeB > 0) {
                    if (timeA !== timeB) {
                        return isDesc ? timeB - timeA : timeA - timeB;
                    }
                } else if (timeA > 0) {
                    return -1; // Valid timestamp comes before missing timestamp
                } else if (timeB > 0) {
                    return 1;  // Missing timestamp goes to bottom
                }
                return (a.title || '').localeCompare(b.title || '');
            });

            finalResults.isFlat = true;

            const dateSpan = calculateDateSpan(finalResults);
            if (dateSpan) {
                this.onProgress({ status: 'info', message: `Date range: ${dateSpan}` });
            }

            this.stats = {
                total: finalResults.length,
                duplicatesRemoved,
                deadLinksArchived: 0,
                categoriesCount: 0,
                categoryBreakdown: {},
                isFlat: true,
                dateSortOrder: this.dateSortOrder,
                dateSpan
            };
            finalResults.stats = this.stats;

            if (fileBookmarks) {
                this.onProgress({ status: 'info', message: 'Generating chronological file...' });
                downloadBookmarks(finalResults);
            } else {
                this.onProgress({ status: 'info', message: `Saving ${finalResults.length} chronological bookmarks to browser...` });
                const rootId = '2';
                const folderTitle = "Chronological Bookmarks-" + new Date().toISOString().slice(0, 10);
                const rootFolder = await findOrCreateFolder(rootId, folderTitle);

                const WRITE_CHUNK_SIZE = 15;
                for (let i = 0; i < finalResults.length; i += WRITE_CHUNK_SIZE) {
                    if (this.isCancelled) break;
                    const chunk = finalResults.slice(i, i + WRITE_CHUNK_SIZE);
                    await Promise.all(chunk.map(b => createBookmark(rootFolder.id, b.title, b.url)));
                }
            }

            if (this.isCancelled) {
                this.onProgress({ status: 'warning', message: 'Process cancelled.' });
                return null;
            }

            this.onProgress({ status: 'done', message: 'Organization complete!' });
            return finalResults;
        }

        // Bypassing network reachability probe on arbitrary bookmark URLs in Chrome extension context:
        // External websites returning HTTP 'Link: ... rel="modulepreload"' or 'rel="preload"' response headers
        // cause the browser to attempt preloading scripts into the extension's index.html context,
        // violating Manifest V3 Content Security Policy (script-src 'self'). All bookmarks are classified directly.
        const activeLinks = allLinks;
        const deadLinks = [];

        let classifiedActive = [];

        if (activeLinks.length > 0) {
            // --- Phase 1: Generate Schema ---
            this.onProgress({ status: 'info', message: 'Analyzing bookmarks to generate a clean, non-redundant folder structure...' });
            if (activeLinks.length > SCHEMA_SAMPLE_LIMIT) {
                this.onProgress({ status: 'info', message: `Large collection: designing the folder structure from a sample of ${SCHEMA_SAMPLE_LIMIT.toLocaleString()} of ${activeLinks.length.toLocaleString()} bookmarks. All bookmarks will still be classified.` });
            }

            let schema;
            try {
                schema = await generateSchema(
                    activeLinks,
                    this.apiKey,
                    this.categories,
                    this.model,
                    this.subfolderTarget,
                    () => this.isCancelled,
                    ({ delayMs, isRateLimit }) => {
                        const sec = Math.ceil(delayMs / 1000);
                        this.onProgress({
                            status: 'warning',
                            message: isRateLimit
                                ? `Rate limit reached (429). Pausing for ${sec}s before retrying schema generation...`
                                : `Network issue during schema generation. Retrying in ${sec}s...`
                        });
                    }
                );
                this.onProgress({ status: 'info', message: 'Generated category schema:' });
                if (schema && schema.categories) {
                    schema.categories.forEach(cat => {
                        const subCats = cat.sub_categories && cat.sub_categories.length > 0 
                            ? ` (${cat.sub_categories.join(', ')})` 
                            : '';
                        this.onProgress({ status: 'info', message: `  • ${cat.name}${subCats}` });
                    });
                }
            } catch (err) {
                if (this.isCancelled || err?.isCancelled) {
                    this.onProgress({ status: 'warning', message: 'Process cancelled.' });
                    return null;
                }
                console.error('Schema generation failed, falling back to basic categories:', err);
                this.onProgress({ status: 'warning', message: `Schema generation failed after retries: ${err.message}. Using default categories (no subfolders).` });
                schema = {
                    categories: this.categories.map(c => ({ name: c, sub_categories: [] }))
                };
            }

            if (this.isCancelled) {
                this.onProgress({ status: 'warning', message: 'Process cancelled.' });
                return null;
            }

            const total = activeLinks.length;
            let processed = 0;

            const batchSize = this.calculateAdaptiveBatchSize(total);
            this.onProgress({ status: 'info', message: `Processing with adaptive batch size: ${batchSize} items/batch` });

            // Group into batches
            const batches = [];
            for (let i = 0; i < total; i += batchSize) {
                batches.push({
                    index: batches.length,
                    batchData: activeLinks.slice(i, i + batchSize)
                });
            }

            const results = new Array(batches.length);
            const failedBatches = [];
            let batchIdx = 0;

            const processNext = async () => {
                if (batchIdx >= batches.length || this.isCancelled) return;
                const currentIdx = batchIdx++;
                const { index, batchData } = batches[currentIdx];

                this.onProgress({
                    status: 'processing',
                    message: `Classifying batch ${currentIdx + 1}/${batches.length}...`,
                    percent: Math.round((processed / total) * 100)
                });

                try {
                    const classified = await classifyBatch(
                        batchData,
                        this.apiKey,
                        schema,
                        this.model,
                        this.cleanTitles,
                        () => this.isCancelled,
                        ({ delayMs, isRateLimit }) => {
                            const sec = Math.ceil(delayMs / 1000);
                            this.onProgress({
                                status: 'warning',
                                message: isRateLimit
                                    ? `Rate limit reached (429). Pausing for ${sec}s before retrying batch ${currentIdx + 1}...`
                                    : `Network issue on batch ${currentIdx + 1}. Retrying in ${sec}s...`
                            });
                        }
                    );
                    if (this.isCancelled) return;

                    // Accumulate results
                    results[index] = classified;
                    processed += batchData.length;
                    this.onProgress({ status: 'progress', percent: Math.min(100, Math.round((processed / total) * 100)), clearNotice: true });

                } catch (err) {
                    if (this.isCancelled || err?.isCancelled) return;
                    console.error(`Batch ${currentIdx + 1} failed:`, err);
                    failedBatches.push({ index, batchData, label: currentIdx + 1 });
                    this.onProgress({ status: 'warning', message: `Batch ${currentIdx + 1} failed (${err.message}) — will retry after the main pass. Continuing remaining batches in background...` });
                }

                await processNext();
            };

            // Run batches concurrently (increased to 4 concurrent requests for optimal throughput)
            const concurrencyLimit = 4;
            const workers = [];
            for (let w = 0; w < Math.min(concurrencyLimit, batches.length); w++) {
                workers.push(processNext());
            }
            await Promise.all(workers);

            if (this.isCancelled) {
                this.onProgress({ status: 'warning', message: 'Process cancelled.' });
                return null;
            }

            // Second pass: retry failed batches one at a time, with no concurrent
            // traffic competing — transient network drops usually clear by now.
            for (const { index, batchData, label } of failedBatches) {
                if (this.isCancelled) break;

                this.onProgress({ status: 'processing', message: `Retrying batch ${label}/${batches.length}...` });
                results[index] = await this.classifyWithSubdivision(batchData, schema, label);
                if (this.isCancelled) break;
                processed += batchData.length;
                this.onProgress({ status: 'progress', percent: Math.min(100, Math.round((processed / total) * 100)), clearNotice: true });
            }

            if (this.isCancelled) {
                this.onProgress({ status: 'warning', message: 'Process cancelled.' });
                return null;
            }

            classifiedActive = results.flat().filter(Boolean);
        }

        // Combine classified reachable links with archived unreachable links
        const finalResults = [...classifiedActive, ...deadLinks];

        // Creation order determines display order in Chrome, so sorting the
        // results here controls the order of folders and bookmarks within them.
        if (this.schemaSortOrder && this.schemaSortOrder !== 'none') {
            const sortLabels = {
                'alpha': 'Alphabetical (A–Z)',
                'date-desc': 'Date Added (Newest First)',
                'date-asc': 'Date Added (Oldest First)',
                'domain': 'Website / Domain (A–Z)',
                'alpha-desc': 'Reverse Alphabetical (Z–A)'
            };
            const sortLabel = sortLabels[this.schemaSortOrder] || this.schemaSortOrder;
            this.onProgress({
                status: 'info',
                message: `Sorting folder contents (${sortLabel})...`
            });

            finalResults.sort((a, b) => {
                // Keep categories and sub-categories grouped and alphabetized
                const catDiff = (a.category || '').localeCompare(b.category || '');
                if (catDiff !== 0) return catDiff;
                const subDiff = (a.sub_category || '').localeCompare(b.sub_category || '');
                if (subDiff !== 0) return subDiff;

                // Sort bookmarks within each folder according to chosen schema
                switch (this.schemaSortOrder) {
                    case 'date-desc': {
                        const timeA = getBookmarkTimestamp(a);
                        const timeB = getBookmarkTimestamp(b);
                        if (timeA > 0 && timeB > 0) {
                            if (timeA !== timeB) return timeB - timeA;
                        } else if (timeA > 0) {
                            return -1;
                        } else if (timeB > 0) {
                            return 1;
                        }
                        return (a.title || '').localeCompare(b.title || '');
                    }
                    case 'date-asc': {
                        const timeA = getBookmarkTimestamp(a);
                        const timeB = getBookmarkTimestamp(b);
                        if (timeA > 0 && timeB > 0) {
                            if (timeA !== timeB) return timeA - timeB;
                        } else if (timeA > 0) {
                            return -1;
                        } else if (timeB > 0) {
                            return 1;
                        }
                        return (a.title || '').localeCompare(b.title || '');
                    }
                    case 'domain': {
                        const domainA = getBookmarkDomain(a);
                        const domainB = getBookmarkDomain(b);
                        const domainDiff = domainA.localeCompare(domainB);
                        if (domainDiff !== 0) return domainDiff;
                        return (a.title || '').localeCompare(b.title || '');
                    }
                    case 'alpha-desc': {
                        return (b.title || '').localeCompare(a.title || '');
                    }
                    case 'alpha':
                    default: {
                        return (a.title || '').localeCompare(b.title || '');
                    }
                }
            });
        }

        if (this.isCancelled) {
            this.onProgress({ status: 'warning', message: 'Process cancelled.' });
            return null;
        }

        if (fileBookmarks) {
            this.onProgress({ status: 'info', message: 'Generating organized file...' });
            downloadBookmarks(finalResults);
        } else {
            // Browser mode: Save bookmarks to Chrome
            this.onProgress({ status: 'info', message: `Saving ${finalResults.length} bookmarks to browser...` });
            
            const rootId = '2'; // 'Other Bookmarks' usually
            const rootFolder = await findOrCreateFolder(rootId, "AI Organized Bookmarks-" + new Date().toISOString().slice(0, 10));

            // Clean up the folder cache before starting the write operation
            clearFolderCache();

            // To avoid duplicate folder creation and empty folders:
            const createdFolders = {}; // path key -> folder Object
            const itemsWithParents = [];

            for (const item of finalResults) {
                if (this.isCancelled) break;
                
                const category = item.category || "Uncategorized";
                
                // Find or create category folder
                let catFolder;
                if (createdFolders[category]) {
                    catFolder = createdFolders[category];
                } else {
                    catFolder = await findOrCreateFolder(rootFolder.id, category);
                    createdFolders[category] = catFolder;
                }
                
                let targetParentId = catFolder.id;
                
                const subCategory = item.sub_category;
                if (shouldCreateSubFolder(category, subCategory)) {
                    const subPath = `${category}/${subCategory}`;
                    let subFolder;
                    if (createdFolders[subPath]) {
                        subFolder = createdFolders[subPath];
                    } else {
                        subFolder = await findOrCreateFolder(catFolder.id, subCategory);
                        createdFolders[subPath] = subFolder;
                    }
                    targetParentId = subFolder.id;
                }
                
                itemsWithParents.push({ parentId: targetParentId, title: item.title, url: item.url });
            }

            // High-speed pipelined creation in chunks of 15 promises
            const WRITE_CHUNK_SIZE = 15;
            for (let i = 0; i < itemsWithParents.length; i += WRITE_CHUNK_SIZE) {
                if (this.isCancelled) break;
                const chunk = itemsWithParents.slice(i, i + WRITE_CHUNK_SIZE);
                await Promise.all(chunk.map(b => createBookmark(b.parentId, b.title, b.url)));
            }
        }

        if (this.isCancelled) {
            this.onProgress({ status: 'warning', message: 'Process cancelled.' });
            return null;
        }

        // Compute summary statistics and flat category breakdown
        const categoryBreakdown = {};
        for (const item of finalResults) {
            const cat = item.category || 'Other';
            categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;
        }

        const dateSpan = calculateDateSpan(finalResults);
        if (dateSpan) {
            this.onProgress({ status: 'info', message: `Total date range: ${dateSpan}` });
        }

        this.stats = {
            total: finalResults.length,
            duplicatesRemoved,
            deadLinksArchived: deadLinks.length,
            categoriesCount: Object.keys(categoryBreakdown).length,
            categoryBreakdown,
            isFlat: false,
            schemaSortOrder: this.schemaSortOrder,
            dateSpan
        };
        finalResults.stats = this.stats;

        // Log flat category breakdown to terminal
        this.onProgress({ status: 'info', message: 'Category breakdown:' });
        Object.entries(categoryBreakdown)
            .sort(([a], [b]) => a.localeCompare(b))
            .forEach(([category, count]) => {
                this.onProgress({ status: 'info', message: `  • ${category}: ${count}` });
            });

        this.onProgress({ status: 'done', message: 'Organization complete!' });
        return finalResults;
    }
}
