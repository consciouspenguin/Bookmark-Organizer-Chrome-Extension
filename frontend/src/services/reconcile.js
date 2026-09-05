import { subfolderBounds } from './ai';

// Where a dissolved subcategory's bookmarks go. `shouldCreateSubFolder` treats
// this name as "no subfolder", so these land directly under their category in
// both write paths.
const SINK_SUBCATEGORY = 'General';

// Names that already mean "no real subcategory". They are never merged, folded
// or capped — they are the destination, not a candidate.
const SINK_NAMES = new Set(['general', 'other', 'misc', 'miscellaneous', 'uncategorized', 'none', 'various', '']);

// Categories whose contents are bookkeeping rather than topics. Folding a
// 2-item "Broken Links" folder into "General" would lose the distinction that
// makes it useful.
const EXEMPT_CATEGORIES = new Set(['archive']);

// Tokens too common to signal that two folder names are related.
const STOPWORDS = new Set(['and', 'the', 'of', 'for', 'in', 'on', 'to', 'a', 'an', '&']);

function isSink(name) {
    return typeof name !== 'string' || SINK_NAMES.has(name.trim().toLowerCase());
}

// Collapses the spelling variants that independent, concurrently-run batches
// produce for the same idea: "AI Tools" / "ai tools" / "AI Tool".
export function canonicalKey(name) {
    return name
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/s$/, '');
}

function tokenize(name) {
    return new Set(
        name
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(t => t && !STOPWORDS.has(t))
            .map(t => t.replace(/s$/, ''))
    );
}

// Shared-token count, used to pick where a dissolved folder's bookmarks go.
// Deliberately crude: it only has to beat "dump it in General".
function overlap(a, b) {
    let shared = 0;
    for (const token of a) if (b.has(token)) shared++;
    return shared;
}

// The surviving group a dissolved folder's bookmarks belong closest to, or
// null when it shares no token with any of them.
function nearestSibling(group, kept) {
    let best = null;
    let bestScore = 0;
    for (const candidate of kept) {
        const score = overlap(group.tokens, candidate.tokens);
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return best;
}

/**
 * Normalize, merge and bound the subcategories produced by classification.
 *
 * Batches are classified concurrently and independently, so two of them can
 * invent "AI Tools" and "AI Tooling" for the same cluster, and a proposed
 * subcategory can end up holding a single bookmark. This pass is the only
 * point where the whole picture is visible, so it is where those are resolved.
 *
 * @param {Array} classified - bookmarks carrying `category` / `sub_category`.
 * @param {Object} schema - the approved schema (used only to spot proposals).
 * @param {Object} options - `subfolderTarget` granularity setting.
 * @returns {{ classified: Array, summary: Object }}
 */
export function reconcileSubcategories(classified, schema, { subfolderTarget = '5-10' } = {}) {
    const summary = { proposedKept: 0, proposedFolded: 0, merged: 0, orphansFolded: 0, cappedFolded: 0 };

    if (!Array.isArray(classified) || classified.length === 0) {
        return { classified: Array.isArray(classified) ? classified : [], summary };
    }

    const { max } = subfolderBounds(subfolderTarget);
    const minCount = subfolderTarget === '10+' ? 2 : 3;

    const schemaSubs = new Map(
        (Array.isArray(schema?.categories) ? schema.categories : [])
            .filter(c => typeof c?.name === 'string')
            .map(c => [
                c.name.trim().toLowerCase(),
                new Set((Array.isArray(c.sub_categories) ? c.sub_categories : [])
                    .filter(s => typeof s === 'string')
                    .map(s => canonicalKey(s)))
            ])
    );

    // category -> canonical key -> { spellings: Map<name, count>, items: [] }
    const byCategory = new Map();

    for (const item of classified) {
        const category = typeof item?.category === 'string' ? item.category : '';
        if (!category || EXEMPT_CATEGORIES.has(category.trim().toLowerCase())) continue;
        if (isSink(item.sub_category)) continue;

        const key = canonicalKey(item.sub_category);
        if (!key) continue;

        if (!byCategory.has(category)) byCategory.set(category, new Map());
        const groups = byCategory.get(category);
        if (!groups.has(key)) groups.set(key, { spellings: new Map(), items: [] });

        const group = groups.get(key);
        const spelling = item.sub_category.trim().replace(/\s+/g, ' ');
        group.spellings.set(spelling, (group.spellings.get(spelling) || 0) + 1);
        group.items.push(item);
    }

    // sub_category rewrites, applied after every decision is made.
    const rename = new Map();

    for (const [category, groups] of byCategory) {
        const approved = schemaSubs.get(category.trim().toLowerCase()) || new Set();

        const resolved = [];
        for (const [key, group] of groups) {
            // The most-used spelling wins; ties break lexicographically so the
            // result does not depend on batch completion order.
            const name = [...group.spellings.entries()]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];

            if (group.spellings.size > 1) summary.merged += group.spellings.size - 1;

            resolved.push({
                key,
                name,
                count: group.items.length,
                items: group.items,
                tokens: tokenize(name),
                isProposed: !approved.has(key)
            });
        }

        // A folder too small to be worth its own place in the sidebar is
        // dissolved. Survivors are chosen first so nothing folds into a folder
        // that is itself about to disappear.
        let survivors = resolved.filter(g => g.count >= minCount);
        let orphans = resolved.filter(g => g.count < minCount);

        // A category must never lose all of its structure — that outcome is the
        // bug this module exists to prevent. When nothing clears the floor, keep
        // the largest groups holding at least two bookmarks rather than
        // dissolving the whole category into "General". A category whose every
        // subcategory holds a single bookmark genuinely has no structure, so it
        // still falls through.
        if (survivors.length === 0) {
            const rescued = resolved
                .filter(g => g.count >= 2)
                .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
                .slice(0, max);
            if (rescued.length > 0) {
                const rescuedSet = new Set(rescued);
                survivors = rescued;
                orphans = resolved.filter(g => !rescuedSet.has(g));
            }
        }

        // Rank survivors by size, then name, and enforce the per-category
        // ceiling for this granularity setting.
        survivors.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        const kept = survivors.slice(0, max);
        const capped = survivors.slice(max);

        // Overflow past the ceiling is still well-classified content, so it goes
        // to its nearest surviving kin on the same terms as an orphan. Dumping
        // it in "General" put more than half of a healthy category there at the
        // '0-5' setting.
        for (const group of capped) {
            summary.cappedFolded++;
            if (group.isProposed) summary.proposedFolded++;

            const best = nearestSibling(group, kept);
            rename.set(group, best ? best.name : SINK_SUBCATEGORY);
        }

        for (const group of orphans) {
            summary.orphansFolded++;
            if (group.isProposed) summary.proposedFolded++;

            const best = nearestSibling(group, kept);
            rename.set(group, best ? best.name : SINK_SUBCATEGORY);
        }

        for (const group of kept) {
            if (group.isProposed) summary.proposedKept++;
            rename.set(group, group.name);
        }

        for (const group of resolved) {
            const target = rename.get(group);
            for (const item of group.items) {
                item.sub_category = target;
            }
        }
    }

    // `proposed` is an internal signal for this pass only; it must not reach
    // the folder-writing or export code.
    for (const item of classified) {
        if (item && 'proposed' in item) delete item.proposed;
    }

    return { classified, summary };
}
