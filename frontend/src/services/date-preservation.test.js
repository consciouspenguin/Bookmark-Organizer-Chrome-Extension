import { describe, expect, it, vi, afterEach } from 'vitest'
import { OrganizerService } from './organizer'
import { parseBookmarks } from '../utils/parser'
import * as ai from './ai'
import * as bookmarksExport from './bookmarks_export'
import { generateNetscapeHTML } from './bookmarks_export'

// End-to-end guard: a bookmark's "date added" must survive the whole
// file → parse → organize → export round trip unchanged. The Netscape format
// stores ADD_DATE in epoch *seconds*; Chrome's bookmarks API uses epoch
// *milliseconds*. Both must land back in the exported file as the same instant.

const SECONDS = {
    alpha: '1500000000',   // 2017-07-14
    beta: '1600000000',    // 2020-09-13
    gamma: '1712000000',   // 2024-04-01
    delta: '1735689600'    // 2025-01-01
}

// Build a realistic Netscape export: uppercase ADD_DATE, nested folders.
const buildNetscapeFile = (entries) => `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1590000000" LAST_MODIFIED="1590000000">Imported</H3>
    <DL><p>
${entries.map(e =>
    `        <DT><A HREF="${e.url}"${e.addDate ? ` ADD_DATE="${e.addDate}"` : ''}>${e.title}</A>`
).join('\n')}
    </DL><p>
</DL><p>`

// url -> ADD_DATE string, read straight from an exported Netscape file.
const exportedDates = (html) => {
    const map = {}
    for (const m of html.matchAll(/<A HREF="([^"]*)"[^>]*?ADD_DATE="([^"]*)"/g)) {
        map[m[1]] = m[2]
    }
    return map
}

// Run a file-mode organize and return the exported HTML that the user downloads.
const organizeFileToHtml = async (service, links) => {
    let exported = null
    vi.spyOn(bookmarksExport, 'downloadBookmarks').mockImplementation((results) => {
        exported = generateNetscapeHTML(results)
    })
    await service.start(links)
    return exported
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe('bookmark date preservation: original file → organized file', () => {
    it('flat chronological export keeps every ADD_DATE second-for-second', async () => {
        const links = parseBookmarks(buildNetscapeFile([
            { url: 'https://alpha.example.com/', title: 'Alpha', addDate: SECONDS.alpha },
            { url: 'https://beta.example.com/', title: 'Beta', addDate: SECONDS.beta },
            { url: 'https://gamma.example.com/', title: 'Gamma', addDate: SECONDS.gamma }
        ]))

        const service = new OrganizerService(
            'test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite',
            '5-10', true, true, false,
            true,   // flatDateSort — no AI
            'desc'
        )

        const html = await organizeFileToHtml(service, links)

        expect(exportedDates(html)).toEqual({
            'https://alpha.example.com/': SECONDS.alpha,
            'https://beta.example.com/': SECONDS.beta,
            'https://gamma.example.com/': SECONDS.gamma
        })
    })

    it('AI category export carries ADD_DATE through classification untouched', async () => {
        vi.spyOn(ai, 'generateSchema').mockResolvedValue({
            categories: [{ name: 'Tech', sub_categories: ['Web'] }, { name: 'News', sub_categories: [] }]
        })
        // Mirror the real classifyBatch contract: spread the source bookmark so
        // fields the model never sees (add_date, icon) reach the export.
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) =>
            batch.map(b => ({
                ...b,
                category: b.url.includes('news') ? 'News' : 'Tech',
                sub_category: b.url.includes('news') ? 'General' : 'Web'
            }))
        )

        const links = parseBookmarks(buildNetscapeFile([
            { url: 'https://tech.example.com/a', title: 'Tech A', addDate: SECONDS.alpha },
            { url: 'https://news.example.com/b', title: 'News B', addDate: SECONDS.beta },
            { url: 'https://tech.example.com/c', title: 'Tech C', addDate: SECONDS.gamma }
        ]))

        const service = new OrganizerService(
            'test-key', ['Tech', 'News'], () => {}, 'google/gemini-3.1-flash-lite',
            '5-10', false, true, false,
            false,  // categorized (AI) mode
            'desc'
        )

        const html = await organizeFileToHtml(service, links)

        expect(exportedDates(html)).toEqual({
            'https://tech.example.com/a': SECONDS.alpha,
            'https://news.example.com/b': SECONDS.beta,
            'https://tech.example.com/c': SECONDS.gamma
        })
    })

    it('title cleanup rewrites the title but never the date', async () => {
        vi.spyOn(ai, 'classifyBatch').mockImplementation(async (batch) =>
            batch.map(b => ({ ...b, title: `Clean ${b.title}` }))
        )

        const links = parseBookmarks(buildNetscapeFile([
            { url: 'https://alpha.example.com/', title: 'alpha - the messy title | site', addDate: SECONDS.alpha },
            { url: 'https://beta.example.com/', title: 'beta :: raw', addDate: SECONDS.delta }
        ]))

        const service = new OrganizerService(
            'test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite',
            '5-10', true, true,
            true,   // cleanTitles
            true,   // flatDateSort
            'asc'
        )

        const html = await organizeFileToHtml(service, links)

        expect(html).toContain('>Clean alpha - the messy title | site<')
        expect(exportedDates(html)).toEqual({
            'https://alpha.example.com/': SECONDS.alpha,
            'https://beta.example.com/': SECONDS.delta
        })
    })

    it('Chrome dateAdded milliseconds export as exact epoch seconds, no drift', async () => {
        // Bookmarks straight off the Chrome API: dateAdded is milliseconds.
        const links = [
            { title: 'Ms One', url: 'https://ms-one.example.com/', dateAdded: 1500000000000 },
            { title: 'Ms Two', url: 'https://ms-two.example.com/', dateAdded: 1712000000456 } // sub-second remainder
        ]

        const service = new OrganizerService(
            'test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite',
            '5-10', true, true, false, true, 'desc'
        )

        const html = await organizeFileToHtml(service, links)

        expect(exportedDates(html)).toEqual({
            'https://ms-one.example.com/': '1500000000',
            'https://ms-two.example.com/': '1712000000' // floor(1712000000456 / 1000)
        })
    })

    it('links with no source date get a fresh timestamp, dated links stay exact', async () => {
        const before = Math.floor(Date.now() / 1000)

        const links = parseBookmarks(buildNetscapeFile([
            { url: 'https://dated.example.com/', title: 'Dated', addDate: SECONDS.beta },
            { url: 'https://undated.example.com/', title: 'Undated' } // no ADD_DATE in the file
        ]))
        expect(links.find(l => l.url === 'https://undated.example.com/').add_date).toBeNull()

        const service = new OrganizerService(
            'test-key', ['Tech'], () => {}, 'google/gemini-3.1-flash-lite',
            '5-10', true, true, false, true, 'desc'
        )

        const html = await organizeFileToHtml(service, links)
        const dates = exportedDates(html)
        const after = Math.floor(Date.now() / 1000)

        expect(dates['https://dated.example.com/']).toBe(SECONDS.beta)

        const fallback = Number(dates['https://undated.example.com/'])
        expect(Number.isFinite(fallback)).toBe(true)
        expect(fallback).toBeGreaterThanOrEqual(before)
        expect(fallback).toBeLessThanOrEqual(after)
    })
})
