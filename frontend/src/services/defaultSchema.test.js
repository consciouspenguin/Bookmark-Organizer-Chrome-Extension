import { describe, expect, it } from 'vitest'
import { buildFallbackSchema, curatedSubcategories } from './defaultSchema'
import { DEFAULT_CATEGORIES, SUGGESTED_ADDABLE_CATEGORIES } from '../components/Organizer'

const find = (schema, name) => schema.categories.find(c => c.name === name)

describe('curatedSubcategories', () => {
    it('covers every category the extension ships with', () => {
        for (const category of [...DEFAULT_CATEGORIES, ...SUGGESTED_ADDABLE_CATEGORIES]) {
            expect(curatedSubcategories(category), `missing curated folders for ${category}`).not.toBeNull()
            expect(curatedSubcategories(category).length).toBeGreaterThanOrEqual(5)
        }
    })

    it('matches regardless of casing and surrounding whitespace', () => {
        expect(curatedSubcategories('  finance & CRYPTO ')).toEqual(curatedSubcategories('Finance & Crypto'))
    })

    it('returns null for a category it does not know', () => {
        expect(curatedSubcategories('My Stuff')).toBeNull()
        expect(curatedSubcategories('')).toBeNull()
        expect(curatedSubcategories(undefined)).toBeNull()
    })
})

describe('buildFallbackSchema', () => {
    it('gives every known category real subfolders instead of an empty array', () => {
        const { schema, curatedCount } = buildFallbackSchema(DEFAULT_CATEGORIES)

        expect(curatedCount).toBe(DEFAULT_CATEGORIES.length)
        expect(find(schema, 'Finance & Crypto').sub_categories.length).toBeGreaterThanOrEqual(5)

        // The exact failure mode this fallback exists to prevent.
        expect(schema.categories.every(c => c.sub_categories.length === 0)).toBe(false)
    })

    it('prefers subcategories salvaged from the failed AI response', () => {
        const partial = { categories: [{ name: 'Finance & Crypto', sub_categories: ['Options Flow', 'Macro Research'] }] }

        const { schema, curatedCount, carriedCount } = buildFallbackSchema(DEFAULT_CATEGORIES, partial)

        expect(carriedCount).toBe(1)
        expect(curatedCount).toBe(DEFAULT_CATEGORIES.length - 1)
        expect(find(schema, 'Finance & Crypto').sub_categories).toEqual(['Options Flow', 'Macro Research'])
    })

    it('ignores salvaged categories that are themselves empty', () => {
        const partial = { categories: [{ name: 'Finance & Crypto', sub_categories: [] }] }

        const { schema, carriedCount } = buildFallbackSchema(DEFAULT_CATEGORIES, partial)

        expect(carriedCount).toBe(0)
        expect(find(schema, 'Finance & Crypto').sub_categories).toEqual(curatedSubcategories('Finance & Crypto'))
    })

    it('leaves an unknown custom category without invented subfolders', () => {
        const { schema, curatedCount } = buildFallbackSchema(['My Stuff', 'Finance & Crypto'])

        expect(curatedCount).toBe(1)
        // Deliberately empty rather than a literal ["General"]: the classifier
        // falls back to "General" on its own, and both write paths file that
        // directly under the category instead of creating a "General" folder.
        expect(find(schema, 'My Stuff').sub_categories).toEqual([])
    })

    it('always provides an Other category for bookmarks that fit nowhere', () => {
        expect(find(buildFallbackSchema(['Finance & Crypto']).schema, 'Other')).toBeDefined()

        const alreadyPresent = buildFallbackSchema(['Finance & Crypto', 'Other']).schema
        expect(alreadyPresent.categories.filter(c => c.name === 'Other')).toHaveLength(1)
    })

    it('survives empty or malformed category input', () => {
        expect(buildFallbackSchema([]).schema.categories).toEqual([{ name: 'Other', sub_categories: [] }])
        expect(buildFallbackSchema(null).schema.categories).toEqual([{ name: 'Other', sub_categories: [] }])
        expect(buildFallbackSchema(['  ', null, 42, 'Finance & Crypto']).schema.categories).toHaveLength(2)
    })
})
