// Hand-written two-level structures for the categories the extension ships
// with (DEFAULT_CATEGORIES and SUGGESTED_ADDABLE_CATEGORIES in Organizer.jsx).
//
// These exist purely as a safety net: when the AI cannot produce a usable
// schema, falling back to categories with no subcategories is what put every
// bookmark in a single "General" bucket. A generic-but-real structure is a far
// better failure mode, and the user can re-run for a tailored one.
//
// Keyed by lowercased category name so lookup survives casing differences.
const CURATED_SUBCATEGORIES = {
    'work & career': ['Job Search', 'Resume & Interviews', 'Professional Network', 'Industry Research', 'Workplace Skills'],
    'finance & crypto': ['Trading & Markets', 'Investing & Wealth', 'Crypto & Blockchain', 'Banking & Payments', 'Tax & Economics'],
    'design & media': ['Design Inspiration', 'Fonts & Typography', 'Stock Assets', 'Design Tools', 'Video & Photography'],
    'reading & knowledge': ['Long Reads', 'Reference & Wikis', 'Science & Research', 'History & Culture', 'Book Lists'],
    'entertainment & social': ['Streaming & Video', 'Social Networks', 'Forums & Communities', 'Humor & Memes', 'Sports'],
    'shopping & tools': ['Online Stores', 'Deals & Coupons', 'Product Reviews', 'Web Utilities', 'Productivity Apps'],
    'travel & lifestyle': ['Flights & Hotels', 'Destination Guides', 'Food & Restaurants', 'Fitness & Wellness', 'Home & Living'],
    'tech & development': ['Web Development', 'Programming Languages', 'DevOps & Cloud', 'Developer Tools', 'Security'],
    'health, fitness & wellness': ['Nutrition & Diet', 'Workouts & Training', 'Mental Health', 'Medical Reference', 'Sleep & Recovery'],
    'ai & machine learning': ['Models & Research', 'AI Tools', 'Prompting & Guides', 'Datasets', 'MLOps'],
    'news & current affairs': ['World News', 'Politics & Policy', 'Business News', 'Technology News', 'Local News'],
    'recipes & cooking': ['Weeknight Meals', 'Baking & Desserts', 'Techniques', 'Meal Planning', 'Kitchen Gear'],
    'education & academia': ['Online Courses', 'Papers & Journals', 'Study Resources', 'Universities', 'Certifications'],
    'open source & code': ['Repositories', 'Libraries & Frameworks', 'Code Examples', 'Documentation', 'Contributing'],
    'home, diy & real estate': ['Home Improvement', 'Interior Design', 'Property Listings', 'Gardening', 'Repair Guides'],
    'podcasts, audio & music': ['Podcasts', 'Music Streaming', 'Artists & Albums', 'Audio Gear', 'Music Production'],
    'gaming & esports': ['Game Guides', 'Reviews & News', 'Esports', 'Game Stores', 'Modding & Tools'],
    'legal, docs & admin': ['Contracts & Templates', 'Government Services', 'Tax & Filing', 'Insurance', 'Records & Archives']
};

export function curatedSubcategories(category) {
    return CURATED_SUBCATEGORIES[(category || '').trim().toLowerCase()] || null;
}

/**
 * Assemble the best schema available without a working AI response.
 *
 * Prefers whatever the model did return for a category, then the curated
 * structure, and finally an empty list. An empty list is not a dead end: the
 * classifier falls back to "General", which both write paths file directly
 * under the category rather than inside a literal "General" folder.
 *
 * @param {string[]} categories - the user's configured top-level categories.
 * @param {Object} [partialSchema] - salvage from a failed generateSchema call.
 * @returns {{ schema: Object, curatedCount: number, carriedCount: number }}
 */
export function buildFallbackSchema(categories, partialSchema = null) {
    const carried = new Map(
        (Array.isArray(partialSchema?.categories) ? partialSchema.categories : [])
            .filter(c => typeof c?.name === 'string' && Array.isArray(c.sub_categories) && c.sub_categories.length > 0)
            .map(c => [c.name.trim().toLowerCase(), c.sub_categories])
    );

    let curatedCount = 0;
    let carriedCount = 0;

    const list = Array.isArray(categories) && categories.length > 0 ? categories : [];

    const built = list
        .filter(name => typeof name === 'string' && name.trim())
        .map(name => {
            const key = name.trim().toLowerCase();

            const fromModel = carried.get(key);
            if (fromModel) {
                carriedCount++;
                return { name: name.trim(), sub_categories: [...fromModel] };
            }

            const curated = curatedSubcategories(name);
            if (curated) {
                curatedCount++;
                return { name: name.trim(), sub_categories: [...curated] };
            }

            return { name: name.trim(), sub_categories: [] };
        });

    // "Other" is where the classifier sends anything that fits nowhere; without
    // it those bookmarks have no destination at all.
    if (!built.some(c => c.name.trim().toLowerCase() === 'other')) {
        built.push({ name: 'Other', sub_categories: [] });
    }

    return { schema: { categories: built }, curatedCount, carriedCount };
}
