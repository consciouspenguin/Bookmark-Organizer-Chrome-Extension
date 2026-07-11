import { getBookmarks, createBookmark, findOrCreateFolder, clearFolderCache, shouldCreateSubFolder } from './bookmarks';
import { generateSchema, classifyBatch, SCHEMA_SAMPLE_LIMIT } from './ai';
import { downloadBookmarks } from './bookmarks_export';

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

export class OrganizerService {
    constructor(apiKey, categories, onProgress, model = "google/gemini-3.5-flash", subfolderTarget = "5-10", sortAlphabetically = true, removeDuplicates = true) {
        this.apiKey = apiKey;
        this.categories = categories;
        this.onProgress = onProgress || (() => { });
        this.model = model;
        this.subfolderTarget = subfolderTarget;
        this.sortAlphabetically = sortAlphabetically;
        this.removeDuplicates = removeDuplicates;
        this.batchSize = 35;
        this.isCancelled = false;
    }

    cancel() {
        this.isCancelled = true;
    }

    calculateAdaptiveBatchSize(totalBookmarks) {
        const isLiteModel = this.model.includes('lite') || this.model.includes('flash-lite');
        const isProModel = this.model.includes('pro');

        if (totalBookmarks < 50) {
            return isLiteModel ? 15 : 20;
        } else if (totalBookmarks < 200) {
            return isLiteModel ? 20 : isProModel ? 25 : 35;
        } else if (totalBookmarks < 500) {
            return isLiteModel ? 25 : isProModel ? 30 : 45;
        } else {
            return isLiteModel ? 30 : isProModel ? 35 : 50;
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
                            allLinks.push({ title: node.title, url: node.url, id: node.id });
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

        if (this.removeDuplicates) {
            const originalCount = allLinks.length;
            allLinks = removeDuplicateUrls(allLinks);
            const duplicatesRemoved = originalCount - allLinks.length;
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

        // --- Phase 1: Generate Schema ---
        this.onProgress({ status: 'info', message: 'Analyzing bookmarks to generate a clean, non-redundant folder structure...' });
        if (allLinks.length > SCHEMA_SAMPLE_LIMIT) {
            this.onProgress({ status: 'info', message: `Large collection: designing the folder structure from a sample of ${SCHEMA_SAMPLE_LIMIT.toLocaleString()} of ${allLinks.length.toLocaleString()} bookmarks. All bookmarks will still be classified.` });
        }

        let schema;
        try {
            schema = await generateSchema(allLinks, this.apiKey, this.categories, this.model, this.subfolderTarget);
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
            console.error('Schema generation failed, falling back to basic categories:', err);
            this.onProgress({ status: 'warning', message: `Schema generation failed after retries: ${err.message}. Using default categories (no subfolders).` });
            schema = {
                categories: this.categories.map(c => ({ name: c, sub_categories: [] }))
            };
        }

        let rootFolder = null;
        if (!fileBookmarks) {
            this.onProgress({ status: 'info', message: 'Creating output directory...' });
            const rootId = '2'; // 'Other Bookmarks' usually
            rootFolder = await findOrCreateFolder(rootId, "AI Organized Bookmarks-" + new Date().toISOString().slice(0, 10));
        }

        const total = allLinks.length;
        let processed = 0;

        const batchSize = this.calculateAdaptiveBatchSize(total);
        this.onProgress({ status: 'info', message: `Processing with adaptive batch size: ${batchSize} items/batch` });

        // Group into batches
        const batches = [];
        for (let i = 0; i < total; i += batchSize) {
            batches.push({
                index: batches.length,
                batchData: allLinks.slice(i, i + batchSize)
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
                const classified = await classifyBatch(batchData, this.apiKey, schema, this.model);

                // Accumulate results
                results[index] = classified;
                processed += batchData.length;
                this.onProgress({ status: 'progress', percent: Math.min(100, Math.round((processed / total) * 100)) });

            } catch (err) {
                console.error(`Batch ${currentIdx + 1} failed:`, err);
                failedBatches.push({ index, batchData, label: currentIdx + 1 });
                this.onProgress({ status: 'warning', message: `Batch ${currentIdx + 1} failed (${err.message}) — will retry after the main pass.` });
            }

            await processNext();
        };

        // Run batches concurrently (limit to 3 concurrent requests to prevent rate limit issues)
        const concurrencyLimit = 3;
        const workers = [];
        for (let w = 0; w < Math.min(concurrencyLimit, batches.length); w++) {
            workers.push(processNext());
        }
        await Promise.all(workers);

        // Second pass: retry failed batches one at a time, with no concurrent
        // traffic competing — transient network drops usually clear by now.
        // A batch that STILL fails gets filed under Other/General rather than
        // dropped, so the output always contains every bookmark.
        for (const { index, batchData, label } of failedBatches) {
            if (this.isCancelled) break;

            this.onProgress({ status: 'processing', message: `Retrying batch ${label}/${batches.length}...` });
            try {
                results[index] = await classifyBatch(batchData, this.apiKey, schema, this.model);
            } catch (err) {
                console.error(`Batch ${label} failed on second pass:`, err);
                results[index] = batchData.map(b => ({ title: b.title, url: b.url, category: 'Other', sub_category: 'General' }));
                this.onProgress({ status: 'warning', message: `Batch ${label} could not be classified (${err.message}). Its ${batchData.length} bookmarks were filed under Other → General so none are lost.` });
            }
            processed += batchData.length;
            this.onProgress({ status: 'progress', percent: Math.min(100, Math.round((processed / total) * 100)) });
        }

        if (this.isCancelled) {
            this.onProgress({ status: 'warning', message: 'Process cancelled.' });
            return null;
        }

        const finalResults = results.flat().filter(Boolean);

        // Creation order determines display order in Chrome, so sorting the
        // results here alphabetizes the folders and the bookmarks within them.
        if (this.sortAlphabetically) {
            finalResults.sort((a, b) =>
                (a.category || '').localeCompare(b.category || '') ||
                (a.sub_category || '').localeCompare(b.sub_category || '') ||
                (a.title || '').localeCompare(b.title || '')
            );
        }

        if (fileBookmarks) {
            this.onProgress({ status: 'info', message: 'Generating organized file...' });
            downloadBookmarks(finalResults);
        } else {
            // Browser mode: Save all sequentially at the end
            this.onProgress({ status: 'info', message: `Saving ${finalResults.length} bookmarks to browser...` });
            
            // Clean up the folder cache before starting the write operation
            clearFolderCache();

            // To avoid duplicate folder creation and empty folders:
            const createdFolders = {}; // path key -> folder Object

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
                
                await createBookmark(targetParentId, item.title, item.url);
            }
        }

        if (this.isCancelled) {
            this.onProgress({ status: 'warning', message: 'Process cancelled.' });
            return null;
        } else {
            this.onProgress({ status: 'done', message: 'Organization complete!' });
            return finalResults;
        }
    }
}
