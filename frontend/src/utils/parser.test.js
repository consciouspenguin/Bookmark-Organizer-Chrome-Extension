import { describe, expect, it } from 'vitest'
import { parseBookmarks } from './parser'

// A minimal Netscape bookmark file as Chrome/Firefox actually export it:
// uppercase ADD_DATE attributes holding epoch *seconds*, nested <DL> folders.
const netscapeFile = (rows) => `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1600000000" LAST_MODIFIED="1600000000">Bookmarks bar</H3>
    <DL><p>
${rows}
    </DL><p>
</DL><p>`

describe('parseBookmarks — add_date extraction from the original file', () => {
    it('reads the epoch-seconds ADD_DATE attribute verbatim, uppercase and all', () => {
        const links = parseBookmarks(netscapeFile(
            `        <DT><A HREF="https://alpha.example.com" ADD_DATE="1500000000">Alpha</A>
        <DT><A HREF="https://beta.example.com" ADD_DATE="1712000000">Beta</A>`
        ))

        expect(links).toEqual([
            { title: 'Alpha', url: 'https://alpha.example.com/', add_date: '1500000000' },
            { title: 'Beta', url: 'https://beta.example.com/', add_date: '1712000000' }
        ])
    })

    it('keeps add_date as the raw string — no numeric coercion, no ms rescaling', () => {
        const [link] = parseBookmarks(netscapeFile(
            `        <DT><A HREF="https://x.example.com" ADD_DATE="1500000000">X</A>`
        ))

        expect(link.add_date).toBe('1500000000')
        expect(typeof link.add_date).toBe('string')
    })

    it('returns add_date === null when the source link has no ADD_DATE', () => {
        const [link] = parseBookmarks(netscapeFile(
            `        <DT><A HREF="https://no-date.example.com">No Date</A>`
        ))

        expect(link.add_date).toBeNull()
    })

    it('preserves each link its own date through deeply nested folders', () => {
        const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3 ADD_DATE="1600000000">Top</H3>
    <DL><p>
        <DT><A HREF="https://top.example.com" ADD_DATE="1111111111">Top Link</A>
        <DT><H3 ADD_DATE="1600000000">Nested</H3>
        <DL><p>
            <DT><A HREF="https://nested.example.com" ADD_DATE="2222222222">Nested Link</A>
        </DL><p>
    </DL><p>
</DL><p>`

        const byUrl = Object.fromEntries(parseBookmarks(html).map(l => [l.url, l.add_date]))

        expect(byUrl['https://top.example.com/']).toBe('1111111111')
        expect(byUrl['https://nested.example.com/']).toBe('2222222222')
    })

    it('skips Firefox place: entries but dates every real link', () => {
        const links = parseBookmarks(netscapeFile(
            `        <DT><A HREF="place:type=6&sort=14" ADD_DATE="1500000000">Recent Tags</A>
        <DT><A HREF="https://real.example.com" ADD_DATE="1650000000">Real</A>`
        ))

        expect(links).toHaveLength(1)
        expect(links[0]).toMatchObject({ url: 'https://real.example.com/', add_date: '1650000000' })
    })
})
