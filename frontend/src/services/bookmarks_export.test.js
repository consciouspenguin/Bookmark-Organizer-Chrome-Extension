import { describe, expect, it } from 'vitest'
import { generateNetscapeHTML } from './bookmarks_export'

// Folder and link names are HTML-escaped in the output; decode them so the
// assertions read as the folder names a user would actually see.
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"')

// Lists folder headings by name, so a test can assert a folder is absent
// rather than merely that some substring does not appear.
const folderNames = (html) =>
    [...html.matchAll(/<H3[^>]*>([^<]*)<\/H3>/g)].map(m => decode(m[1]))

const linkTitles = (html) =>
    [...html.matchAll(/<A HREF="[^"]*"[^>]*>([^<]*)<\/A>/g)].map(m => decode(m[1]))

describe('generateNetscapeHTML subfolder alignment with browser writes', () => {
    it('does not emit a General folder — those bookmarks sit directly under the category', () => {
        const html = generateNetscapeHTML([
            { title: 'Bloomberg', url: 'https://bloomberg.com', category: 'Finance & Crypto', sub_category: 'General' },
            { title: 'Benzinga', url: 'https://benzinga.com', category: 'Finance & Crypto', sub_category: 'General' }
        ])

        expect(folderNames(html)).toEqual(['Finance & Crypto'])
        expect(html).not.toContain('>General<')
        expect(linkTitles(html)).toEqual(['Bloomberg', 'Benzinga'])
    })

    it('treats every name shouldCreateSubFolder rejects as no subfolder', () => {
        const html = generateNetscapeHTML([
            { title: 'A', url: 'https://a.example.com', category: 'Tech', sub_category: 'General' },
            { title: 'B', url: 'https://b.example.com', category: 'Tech', sub_category: 'none' },
            { title: 'C', url: 'https://c.example.com', category: 'Tech', sub_category: 'Uncategorized' },
            { title: 'D', url: 'https://d.example.com', category: 'Tech', sub_category: '' },
            { title: 'E', url: 'https://e.example.com', category: 'Tech', sub_category: null },
            { title: 'F', url: 'https://f.example.com', category: 'Tech' },
            // A subcategory echoing its own parent is also not a real folder.
            { title: 'G', url: 'https://g.example.com', category: 'Tech', sub_category: 'tech' }
        ])

        expect(folderNames(html)).toEqual(['Tech'])
        expect(linkTitles(html)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
    })

    it('still nests genuine subcategories', () => {
        const html = generateNetscapeHTML([
            { title: 'MDN', url: 'https://developer.mozilla.org', category: 'Tech', sub_category: 'Web Development' },
            { title: 'PyTorch', url: 'https://pytorch.org', category: 'Tech', sub_category: 'AI & Machine Learning' }
        ])

        expect(folderNames(html)).toEqual(['Tech', 'Web Development', 'AI & Machine Learning'])
        // Folder names stay HTML-escaped in the emitted markup.
        expect(html).toContain('AI &amp; Machine Learning')
    })

    it('mixes nested subcategories and category-root bookmarks in one category', () => {
        const html = generateNetscapeHTML([
            { title: 'MDN', url: 'https://developer.mozilla.org', category: 'Tech', sub_category: 'Web Development' },
            { title: 'Odd One', url: 'https://odd.example.com', category: 'Tech', sub_category: 'General' }
        ])

        expect(folderNames(html)).toEqual(['Tech', 'Web Development'])

        // The nested folder closes before the category-root link is written, so
        // the loose bookmark is a child of the category, not of Web Development.
        const subFolderEnd = html.indexOf('</DL><p>')
        expect(html.indexOf('Odd One')).toBeGreaterThan(subFolderEnd)
        expect(linkTitles(html)).toEqual(['MDN', 'Odd One'])
    })

    it('keeps identically named subcategories separate across categories', () => {
        const html = generateNetscapeHTML([
            { title: 'Design News', url: 'https://d.example.com', category: 'Design & Media', sub_category: 'News' },
            { title: 'Tech News', url: 'https://t.example.com', category: 'Tech', sub_category: 'News' }
        ])

        expect(folderNames(html).filter(n => n === 'News')).toHaveLength(2)
    })

    it('leaves the flat chronological export untouched', () => {
        const bookmarks = [
            { title: 'One', url: 'https://one.example.com', category: null, sub_category: null },
            { title: 'Two', url: 'https://two.example.com', category: null, sub_category: null }
        ]
        bookmarks.isFlat = true

        const html = generateNetscapeHTML(bookmarks)

        expect(folderNames(html)).toEqual([])
        expect(linkTitles(html)).toEqual(['One', 'Two'])
    })
})
