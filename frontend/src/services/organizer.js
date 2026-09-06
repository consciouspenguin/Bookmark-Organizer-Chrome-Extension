import { getBookmarks, findOrCreateFolder, clearFolderCache, shouldCreateSubFolder, moveBookmark, removeBookmark, getBookmarkChildren } from './bookmarks';
import { generateSchema, classifyBatch, SCHEMA_SAMPLE_LIMIT, isNetworkError, isRateLimitError } from './ai';
import { downloadBookmarks } from './bookmarks_export';
import { reconcileSubcategories } from './reconcile';
import { buildFallbackSchema } from './defaultSchema';

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

// Browser-mode provenance index (spec §7): exact-URL groups, oldest dateAdded wins,
// numeric id breaks ties. Survivor = group head; everything else is a doomed duplicate.
export function buildUrlIndex(links) {
    const index = new Map();
    for (const link of links) {
        if (!link.url) continue;
        if (!index.has(link.url)) index.set(link.url, []);
        index.get(link.url).push({ id: link.id, dateAdded: link.dateAdded || 0 });
    }
    for (const group of index.values()) {
        group.sort((a, b) => (a.dateAdded - b.dateAdded) || (Number(a.id) - Number(b.id)));
    }
    return index;
}

export function dedupeFromIndex(links, urlIndex) {
    const survivorIds = new Set();
    for (const group of urlIndex.values()) {
        if (group.length > 0 && group[0].id !== undefined) survivorIds.add(String(group[0].id));
    }
    const survivors = [];
    const doomed = [];
    for (const link of links) {
        if (link.id === undefined) { survivors.push(link); continue; }
        if (survivorIds.has(String(link.id))) survivors.push(link);
        else doomed.push(link);
    }
    return { survivors, doomed, duplicatesRemoved: doomed.length };
}

export { getBookmarkTimestamp, calculateDateSpan } from '../utils/dates';
import { getBookmarkTimestamp, calculateDateSpan } from '../utils/dates';


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

// Determines if an error CANNOT be resolved by subdividing a batch into smaller chunks.
// Subdividing is ONLY beneficial for prompt/payload size limits, model token truncation, or malformed JSON.
// Network drops, timeouts, rate limits, 5xx server outages, and 4xx client errors should NEVER subdivide.
export function isNonSubdividableError(err) {
    if (!err) return false;
    const statusCode = err.statusCode || (err.message?.match(/(\d{3})/) ? parseInt(err.message.match(/(\d{3})/)[1], 10) : null);
    const msg = (err.message || '').toLowerCase();
    const name = (err.name || '').toLowerCase();

    // 1. Permanent client errors (400 Bad Request, 401 Unauthorized, 402 Payment Required, 403 Forbidden, 404 Not Found)
    if ([400, 401, 402, 403, 404].includes(statusCode)) {
        return true;
    }

    // 2. Server-side errors (500 Internal Error, 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout)
    if ([500, 502, 503, 504].includes(statusCode)) {
        return true;
    }

    // 3. Rate limit / quota exhausted (429 Too Many Requests, quota exceeded)
    if (statusCode === 429 || msg.includes('rate limit') || msg.includes('429') || msg.includes('quota') || msg.includes('too many requests')) {
        return true;
    }

    // 4. Network, DNS, offline, connection drop, or timeout errors
    if (
        name === 'aborterror' ||
        name === 'timeouterror' ||
        msg.includes('fetch') ||
        msg.includes('network') ||
        msg.includes('timeout') ||
        msg.includes('timed out') ||
        msg.includes('time out') ||
        msg.includes('connection') ||
        msg.includes('offline') ||
        msg.includes('econnrefused') ||
        msg.includes('enotfound') ||
        msg.includes('internet')
    ) {
        return true;
    }

    return false;
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
            dateSpan: null,
            failedMoves: []
        };
        this.failedMoves = [];
        this.snapshotProvider = null;
    }

    cancel() {
        this.isCancelled = true;
    }

    async moveItems(pairs) {
        const WRITE_CHUNK_SIZE = 15;
        for (let i = 0; i < pairs.length; i += WRITE_CHUNK_SIZE) {
            if (this.isCancelled) break;
            const chunk = pairs.slice(i, i + WRITE_CHUNK_SIZE);
            await Promise.all(chunk.map(({ item, parentId }) => this.safeMove(item, parentId)));
        }
    }

    async safeMove(item, parentId) {
        if (this.isCancelled) return;
        if (item.id === undefined) {
            this.failedMoves.push({ title: item.title, reason: 'bookmark node id missing' });
            return;
        }
        if (item.parentId === parentId) return; // already home — keeps re-runs idempotent (G4)
        try {
            await moveBookmark(item.id, { parentId });
        } catch (err) {
            this.failedMoves.push({ title: item.title, reason: err?.message || String(err) });
        }
    }

    async removeDoomedDuplicates() {
        for (const node of this.doomedDuplicates || []) {
            if (this.isCancelled) break;
            try {
                await removeBookmark(String(node.id));
            } catch (err) {
                this.failedMoves.push({ title: node.title, reason: `duplicate remove failed: ${err?.message || err}` });
            }
        }
    }

    // Phase B: after every node is home, restore the expected order within
    // each folder by moving ONLY the nodes that are misplaced (spec G4).
    async reorderFolder(parentId, expectedIds) {
        if (this.isCancelled || expectedIds.length === 0) return;
        let children;
        try {
            children = await getBookmarkChildren(parentId);
        } catch {
            return;
        }
        const order = children.map(c => String(c.id));
        for (let i = 0; i < expectedIds.length; i++) {
            const want = String(expectedIds[i]);
            if (order[i] === want) continue;
            const pos = order.indexOf(want);
            if (pos === -1) continue;
            try {
                await moveBookmark(want, { parentId, index: i });
                order.splice(pos, 1);
                order.splice(i, 0, want);
            } catch (err) {
                this.failedMoves.push({ title: want, reason: `reorder failed: ${err?.message || err}` });
            }
        }
    }

    async prepareSnapshot(survivors, doomedDuplicates) {
        if (!this.snapshotProvider) {
            const { downloadBookmarks } = await import('./bookmarks_export');
            this.snapshotProvider = async (surv, doomed) => {
                // No filename: the exporter keeps its organized_bookmarks.html default (spec §8).
                // saveAs: false — a Save-As dialog on every organize run would be hostile.
                downloadBookmarks([...surv, ...doomed], undefined, { saveAs: false });
            };
        }
        this.onProgress({ status: 'info', message: 'Saving a backup before touching your bookmarks (restores content and dates, not the previous folder layout)...' });
        try {
            await this.snapshotProvider(survivors, doomedDuplicates);
            return true;
        } catch (err) {
            this.onProgress({ status: 'error', message: `Backup failed — organize cancelled before touching your bookmarks. (${err?.message || err})` });
            return false;
        }
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

    // One-line shape of the structure the run will actually use, so a thin
    // schema is visible in the log before thousands of bookmarks are filed
    // against it.
    describeSchema(schema) {
        const categories = Array.isArray(schema?.categories) ? schema.categories : [];
        const subTotal = categories.reduce((sum, c) => sum + (c.sub_categories?.length || 0), 0);
        const avg = categories.length > 0 ? (subTotal / categories.length).toFixed(1) : '0';
        return `Schema: ${categories.length} categories, ${subTotal} subcategories (avg ${avg} per category).`;
    }

    // Second chance at a usable schema before giving up and using built-in
    // defaults. Halving the sample relieves the token pressure that truncates
    // large structures, and the balanced granularity asks for less than '10+'.
    async retrySchemaOnSmallerSample(activeLinks) {
        // Halve the sample limit rather than slicing the head off the list:
        // exports are grouped by folder, so the first N bookmarks are one
        // corner of the collection. generateSchema spaces the sample itself.
        const reducedLimit = Math.max(1, Math.floor(SCHEMA_SAMPLE_LIMIT / 2));
        const sampleSize = Math.min(reducedLimit, activeLinks.length);

        this.onProgress({
            status: 'info',
            message: `Retrying schema generation on a smaller sample of ${sampleSize.toLocaleString()} bookmarks...`
        });

        try {
            const schema = await generateSchema(
                activeLinks,
                this.apiKey,
                this.categories,
                this.model,
                '5-10',
                () => this.isCancelled,
                ({ delayMs, isRateLimit, isSchemaCorrection, error }) => {
                    if (isSchemaCorrection) {
                        this.onProgress({
                            status: 'warning',
                            message: `The first folder structure was too flat (${error.message}) — asking the AI to try again with specifics.`
                        });
                        return;
                    }
                    const sec = Math.ceil(delayMs / 1000);
                    this.onProgress({
                        status: 'warning',
                        message: isRateLimit
                            ? `Rate limit reached (429). Pausing for ${sec}s before retrying schema generation...`
                            : `Network issue during schema generation. Retrying in ${sec}s...`
                    });
                },
                reducedLimit
            );

            this.onProgress({ status: 'success', message: 'Schema generation succeeded on the smaller sample.' });
            this.onProgress({ status: 'info', message: this.describeSchema(schema) });
            return schema;
        } catch (retryErr) {
            if (this.isCancelled || retryErr?.isCancelled) return null;
            console.error('Reduced-sample schema generation also failed:', retryErr);
            this.onProgress({ status: 'warning', message: `Reduced-sample retry also failed: ${retryErr.message}` });
            return null;
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
                                parentId: node.parentId,
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

        const initialDateSpan = calculateDateSpan(allLinks);
        this.dateSpan = initialDateSpan;
        this.stats.dateSpan = initialDateSpan;

        this.onProgress({
            status: 'info',
            message: initialDateSpan
                ? `Found ${allLinks.length.toLocaleString()} bookmarks (Date range: ${initialDateSpan}).`
                : `Found ${allLinks.length.toLocaleString()} bookmarks.`,
            dateSpan: initialDateSpan,
            totalBookmarks: allLinks.length
        });
        if (initialDateSpan) {
            this.onProgress({ status: 'info', message: `Total date range: ${initialDateSpan}`, dateSpan: initialDateSpan });
        }

        let duplicatesRemoved = 0;
        this.doomedDuplicates = [];
        const isBrowserMode = !fileBookmarks;
        if (this.removeDuplicates && isBrowserMode) {
            const urlIndex = buildUrlIndex(allLinks);
            const dedup = dedupeFromIndex(allLinks, urlIndex);
            allLinks = dedup.survivors;
            this.doomedDuplicates = dedup.doomed;
            duplicatesRemoved = dedup.duplicatesRemoved;
            this.onProgress({
                status: 'info',
                message: duplicatesRemoved > 0
                    ? `Removed ${duplicatesRemoved} duplicate URL${duplicatesRemoved === 1 ? '' : 's'} from the organized result.`
                    : 'No duplicate URLs found.'
            });
        } else if (this.removeDuplicates) {
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
        if (duplicatesRemoved > 0) {
            const postDupeSpan = calculateDateSpan(allLinks);
            if (postDupeSpan && postDupeSpan !== this.dateSpan) {
                this.dateSpan = postDupeSpan;
                this.stats.dateSpan = postDupeSpan;
                this.onProgress({
                    status: 'info',
                    message: `Date range after deduplication: ${postDupeSpan}`,
                    dateSpan: postDupeSpan
                });
            }
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

            const dateSpan = calculateDateSpan(finalResults) || this.dateSpan;
            this.dateSpan = dateSpan;
            if (dateSpan) {
                this.onProgress({ status: 'info', message: `Date range: ${dateSpan}`, dateSpan });
            }

            this.stats = {
                total: finalResults.length,
                duplicatesRemoved,
                deadLinksArchived: 0,
                categoriesCount: 0,
                categoryBreakdown: {},
                isFlat: true,
                dateSortOrder: this.dateSortOrder,
                dateSpan,
                failedMoves: this.failedMoves
            };
            finalResults.stats = this.stats;

            if (fileBookmarks) {
                this.onProgress({ status: 'info', message: `Generating chronological file${dateSpan ? ` (${dateSpan})` : ''}...`, dateSpan });
                downloadBookmarks(finalResults);
            } else {
                this.onProgress({ status: 'info', message: `Saving ${finalResults.length.toLocaleString()} chronological bookmarks${dateSpan ? ` (${dateSpan})` : ''} to browser...`, dateSpan });
                if (!await this.prepareSnapshot(finalResults, this.doomedDuplicates || [])) return null;
                const rootId = '2';
                const folderTitle = "Chronological Bookmarks-" + new Date().toISOString().slice(0, 10);
                const rootFolder = await findOrCreateFolder(rootId, folderTitle);
                clearFolderCache();

                await this.moveItems(finalResults.map(item => ({ item, parentId: rootFolder.id })));
                await this.removeDoomedDuplicates();
                await this.reorderFolder(rootFolder.id, finalResults.map(r => r.id));
            }

            if (this.isCancelled) {
                this.onProgress({ status: 'warning', message: 'Process cancelled.' });
                return null;
            }

            if (this.failedMoves.length > 0) {
                const n = this.failedMoves.length;
                this.onProgress({ status: 'warning', message: `${n} move${n === 1 ? '' : 's'} failed and need${n === 1 ? 's' : ''} another run: ${this.failedMoves.map(f => f.title).slice(0, 5).join(', ')}${n > 5 ? '…' : ''}` });
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
                    ({ delayMs, isRateLimit, isSchemaCorrection, error }) => {
                        // The corrective round-trip is not a transport failure:
                        // reporting it as one hides the only signal that says
                        // why the structure came back flat.
                        if (isSchemaCorrection) {
                            this.onProgress({
                                status: 'warning',
                                message: `The first folder structure was too flat (${error.message}) — asking the AI to try again with specifics.`
                            });
                            return;
                        }
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
                this.onProgress({ status: 'info', message: this.describeSchema(schema) });
            } catch (err) {
                if (this.isCancelled || err?.isCancelled) {
                    this.onProgress({ status: 'warning', message: 'Process cancelled.' });
                    return null;
                }

                console.error('Schema generation failed, falling back to curated default folders:', err);
                this.onProgress({ status: 'warning', message: `Schema generation failed: ${err.message}` });

                // A schema-less run is what filed every bookmark under "General".
                // Retry once on a smaller sample and the default granularity —
                // a token ceiling or an over-ambitious structure is the common
                // cause, and both ease off with less input.
                schema = await this.retrySchemaOnSmallerSample(activeLinks);

                if (!schema) {
                    const { schema: fallback, curatedCount, carriedCount } = buildFallbackSchema(this.categories, err?.partialSchema);
                    schema = fallback;

                    // `status` is a lifecycle signal in both consumers, not a
                    // log severity: 'error' would flip the panel to a terminal
                    // failure screen for the rest of a run that is still going,
                    // and jobRunner does not log it at all.
                    this.onProgress({
                        status: 'warning',
                        message: 'AI schema generation failed — used built-in default folders. Re-run for a structure tailored to your bookmarks.'
                    });
                    this.onProgress({
                        status: 'warning',
                        message: `Fallback structure: ${curatedCount} categor${curatedCount === 1 ? 'y' : 'ies'} from built-in defaults, ${carriedCount} salvaged from the AI response.`
                    });
                    this.onProgress({ status: 'info', message: this.describeSchema(schema) });

                    const structureless = schema.categories.filter(c => c.sub_categories.length === 0).length;
                    if (structureless > 0) {
                        this.onProgress({
                            status: 'warning',
                            message: `${structureless} custom categor${structureless === 1 ? 'y has' : 'ies have'} no built-in subfolders — those bookmarks will sit directly in the category folder.`
                        });
                    }
                }
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

            // Batches run concurrently and cannot see each other, so this is the
            // first point where the whole set of subcategories is visible —
            // and the only place spelling variants and one-bookmark folders can
            // be resolved.
            const { classified: reconciled, summary } = reconcileSubcategories(
                classifiedActive,
                schema,
                { subfolderTarget: this.subfolderTarget }
            );
            classifiedActive = reconciled;

            const foldedTotal = summary.orphansFolded + summary.cappedFolded;
            if (summary.proposedKept > 0 || summary.merged > 0 || foldedTotal > 0) {
                this.onProgress({
                    status: 'info',
                    message: `Subcategories: +${summary.proposedKept} AI-created, ~${summary.merged} merged, ${foldedTotal} folded into General.`
                });
            }
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

        let dateSpan = calculateDateSpan(finalResults) || this.dateSpan;
        this.dateSpan = dateSpan;

        if (fileBookmarks) {
            this.onProgress({ status: 'info', message: `Generating organized file${dateSpan ? ` (${dateSpan})` : ''}...`, dateSpan });
            try {
                downloadBookmarks(finalResults);
            } catch (dlErr) {
                console.warn('[Organizer] Download invocation deferred:', dlErr);
            }
        } else {
            // Browser mode: relocate existing bookmarks (spec §6)
            this.onProgress({ status: 'info', message: `Reorganizing ${finalResults.length.toLocaleString()} bookmarks${dateSpan ? ` (${dateSpan})` : ''} in the browser...`, dateSpan });
            if (!await this.prepareSnapshot(finalResults, this.doomedDuplicates || [])) return null;
            const rootId = '2'; // 'Other Bookmarks' usually
            const rootFolder = await findOrCreateFolder(rootId, "AI Organized Bookmarks-" + new Date().toISOString().slice(0, 10));
            clearFolderCache();

            const createdFolders = {}; // path key -> folder Object
            const itemsWithParents = [];

            for (const item of finalResults) {
                if (this.isCancelled) break;

                const category = item.category || "Uncategorized";
                let targetParentId;
                try {
                    let catFolder;
                    if (createdFolders[category]) {
                        catFolder = createdFolders[category];
                    } else {
                        catFolder = await findOrCreateFolder(rootFolder.id, category);
                        createdFolders[category] = catFolder;
                    }

                    targetParentId = catFolder.id;

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
                } catch (err) {
                    this.failedMoves.push({ title: item.title, reason: err?.message || String(err) });
                    continue;
                }

                itemsWithParents.push({ item, parentId: targetParentId });
            }

            await this.moveItems(itemsWithParents);
            await this.removeDoomedDuplicates();

            const byFolder = new Map();
            for (const { item, parentId } of itemsWithParents) {
                if (!byFolder.has(parentId)) byFolder.set(parentId, []);
                byFolder.get(parentId).push(item.id);
            }
            for (const [parentId, expectedIds] of byFolder) {
                await this.reorderFolder(parentId, expectedIds);
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

        dateSpan = calculateDateSpan(finalResults) || dateSpan || this.dateSpan;
        this.dateSpan = dateSpan;
        if (dateSpan) {
            this.onProgress({ status: 'info', message: `Total date range: ${dateSpan}`, dateSpan });
        }

        this.stats = {
            total: finalResults.length,
            duplicatesRemoved,
            deadLinksArchived: deadLinks.length,
            categoriesCount: Object.keys(categoryBreakdown).length,
            categoryBreakdown,
            isFlat: false,
            schemaSortOrder: this.schemaSortOrder,
            dateSpan,
            failedMoves: this.failedMoves
        };
        finalResults.stats = this.stats;

        // Log flat category breakdown to terminal
        this.onProgress({ status: 'info', message: 'Category breakdown:' });
        Object.entries(categoryBreakdown)
            .sort(([a], [b]) => a.localeCompare(b))
            .forEach(([category, count]) => {
                this.onProgress({ status: 'info', message: `  • ${category}: ${count}` });
            });

        // The bug this run guards against is bookmarks silently collecting in
        // "General", so make that share impossible to miss.
        const generalCount = finalResults.filter(b => (b.sub_category || '').trim().toLowerCase() === 'general').length;
        const generalShare = finalResults.length > 0 ? Math.round((generalCount / finalResults.length) * 100) : 0;
        this.onProgress({
            status: generalShare > 20 ? 'warning' : 'info',
            message: generalShare > 20
                ? `${generalShare}% of bookmarks (${generalCount.toLocaleString()}) landed in General — the AI struggled to find distinct subfolders. Try a different model or re-run.`
                : `Filed directly under their category (General): ${generalCount.toLocaleString()} (${generalShare}%).`
        });

        if (this.failedMoves.length > 0) {
            const n = this.failedMoves.length;
            this.onProgress({ status: 'warning', message: `${n} move${n === 1 ? '' : 's'} failed and need${n === 1 ? 's' : ''} another run: ${this.failedMoves.map(f => f.title).slice(0, 5).join(', ')}${n > 5 ? '…' : ''}` });
        }

        this.onProgress({ status: 'done', message: 'Organization complete!' });
        return finalResults;
    }
}
