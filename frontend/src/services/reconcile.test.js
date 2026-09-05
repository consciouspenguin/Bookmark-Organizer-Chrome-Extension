import { describe, expect, it } from 'vitest'
import { reconcileSubcategories, canonicalKey } from './reconcile'

// Builds `count` bookmarks sharing one category/sub_category pair.
const items = (category, sub_category, count, opts = {}) =>
    Array.from({ length: count }, (_, i) => ({
        title: `${sub_category} ${i}`,
        url: `https://example.com/${encodeURIComponent(sub_category)}/${i}`,
        category,
        sub_category,
        ...opts
    }))

const schema = {
    categories: [
        { name: 'Tech', sub_categories: ['Web Development', 'Databases'] },
        { name: 'Finance', sub_categories: ['Trading'] }
    ]
}

const subsIn = (result, category) =>
    result.classified.filter(b => b.category === category).map(b => b.sub_category)

describe('canonicalKey', () => {
    it('collapses case, spacing and a trailing plural', () => {
        expect(canonicalKey('AI Tools')).toBe(canonicalKey('ai tool'))
        expect(canonicalKey('  Web   Development ')).toBe('web development')
    })
})

describe('reconcileSubcategories', () => {
    it('is a no-op on empty or non-array input', () => {
        expect(reconcileSubcategories([], schema).classified).toEqual([])
        expect(reconcileSubcategories(null, schema).classified).toEqual([])
        expect(reconcileSubcategories(undefined, schema).summary.merged).toBe(0)
    })

    it('merges spelling variants onto the most frequent spelling', () => {
        const classified = [
            ...items('Tech', 'AI Tools', 4, { proposed: true }),
            ...items('Tech', 'ai tools', 2, { proposed: true }),
            ...items('Tech', 'AI Tool', 1, { proposed: true })
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: '5-10' })

        expect(new Set(subsIn(result, 'Tech'))).toEqual(new Set(['AI Tools']))
        expect(result.summary.merged).toBe(2)
        expect(result.summary.proposedKept).toBe(1)
    })

    it('keeps identically named subcategories separate across categories', () => {
        const classified = [
            ...items('Tech', 'News', 5),
            ...items('Finance', 'News', 5)
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: '5-10' })

        expect(new Set(subsIn(result, 'Tech'))).toEqual(new Set(['News']))
        expect(new Set(subsIn(result, 'Finance'))).toEqual(new Set(['News']))
        expect(result.summary.orphansFolded).toBe(0)
    })

    it('folds an undersized subcategory into the nearest related sibling', () => {
        const classified = [
            ...items('Tech', 'Web Development', 6),
            ...items('Tech', 'Web Frameworks', 2, { proposed: true })
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: '5-10' })

        // "Web Frameworks" shares the token "web", so it joins Web Development
        // rather than being dumped in General.
        expect(new Set(subsIn(result, 'Tech'))).toEqual(new Set(['Web Development']))
        expect(result.summary.orphansFolded).toBe(1)
        expect(result.summary.proposedFolded).toBe(1)
    })

    it('sends an undersized subcategory with no related sibling to General', () => {
        const classified = [
            ...items('Tech', 'Web Development', 6),
            ...items('Tech', 'Knitting Patterns', 1, { proposed: true })
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: '5-10' })

        expect(subsIn(result, 'Tech').filter(s => s === 'General')).toHaveLength(1)
        expect(result.summary.orphansFolded).toBe(1)
    })

    it('never folds an orphan into another folder that is itself dissolving', () => {
        const classified = [
            ...items('Tech', 'Web Development', 6),
            ...items('Tech', 'Web Alpha', 1, { proposed: true }),
            ...items('Tech', 'Web Beta', 1, { proposed: true })
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: '5-10' })

        expect(new Set(subsIn(result, 'Tech'))).toEqual(new Set(['Web Development']))
        expect(result.summary.orphansFolded).toBe(2)
    })

    it('uses a lower orphan threshold at the finest granularity', () => {
        const classified = [
            ...items('Tech', 'Web Development', 6),
            ...items('Tech', 'Rust Ecosystem', 2, { proposed: true })
        ]

        const balanced = reconcileSubcategories(
            classified.map(b => ({ ...b })), schema, { subfolderTarget: '5-10' }
        )
        const detailed = reconcileSubcategories(
            classified.map(b => ({ ...b })), schema, { subfolderTarget: '10+' }
        )

        // minCount is 3 at '5-10' so the 2-item folder dissolves, but 2 at '10+'.
        expect(new Set(subsIn(balanced, 'Tech'))).not.toContain('Rust Ecosystem')
        expect(new Set(subsIn(detailed, 'Tech'))).toContain('Rust Ecosystem')
    })

    it('caps subcategories per category, folding the smallest overflow into General', () => {
        const classified = []
        // 12 distinct viable subcategories, descending in size.
        for (let i = 0; i < 12; i++) {
            classified.push(...items('Tech', `Topic ${String.fromCharCode(65 + i)}`, 20 - i, { proposed: true }))
        }

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: '5-10' })

        const distinct = new Set(subsIn(result, 'Tech'))
        // 10 kept for '5-10', plus the General sink holding the 2 that overflowed.
        expect(distinct.size).toBe(11)
        expect(distinct).toContain('General')
        expect(distinct).toContain('Topic A')
        expect(distinct).not.toContain('Topic L')
        expect(result.summary.cappedFolded).toBe(2)
    })

    it('leaves General bookmarks and exempt categories untouched', () => {
        const classified = [
            ...items('Tech', 'General', 4),
            ...items('Archive', 'Broken Links', 1),
            ...items('Tech', 'Web Development', 5)
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: '5-10' })

        expect(subsIn(result, 'Tech').filter(s => s === 'General')).toHaveLength(4)
        expect(subsIn(result, 'Archive')).toEqual(['Broken Links'])
        expect(result.summary.orphansFolded).toBe(0)
    })

    it('strips the internal proposed flag from every bookmark', () => {
        const classified = [
            ...items('Tech', 'Rust Ecosystem', 5, { proposed: true }),
            ...items('Tech', 'Web Development', 5)
        ]

        const result = reconcileSubcategories(classified, schema, { subfolderTarget: '5-10' })

        expect(result.classified.every(b => !('proposed' in b))).toBe(true)
    })

    it('is deterministic regardless of the order batches completed in', () => {
        const build = () => [
            ...items('Tech', 'AI Tools', 3, { proposed: true }),
            ...items('Tech', 'ai tools', 3, { proposed: true }),
            ...items('Tech', 'Web Development', 4)
        ]

        const forward = reconcileSubcategories(build(), schema, { subfolderTarget: '5-10' })
        const reversed = reconcileSubcategories(build().reverse(), schema, { subfolderTarget: '5-10' })

        expect(new Set(subsIn(forward, 'Tech'))).toEqual(new Set(subsIn(reversed, 'Tech')))
        expect(forward.summary).toEqual(reversed.summary)
    })
})
