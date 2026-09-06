import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import Organizer from './Organizer'
import { OrganizerService } from '../services/organizer'

vi.mock('../services/organizer', () => {
    return {
        OrganizerService: vi.fn(),
        DEFAULT_CATEGORIES: [
            'Work & Career',
            'Finance & Crypto',
            'Design & Media',
            'Reading & Knowledge',
            'Entertainment & Social',
            'Shopping & Tools',
            'Travel & Lifestyle',
            'Tech & Development'
        ],
        SUGGESTED_ADDABLE_CATEGORIES: [
            'Health, Fitness & Wellness',
            'AI & Machine Learning',
            'News & Current Affairs',
            'Recipes & Cooking',
            'Education & Academia',
            'Open Source & Code',
            'Home, DIY & Real Estate',
            'Podcasts, Audio & Music',
            'Gaming & Esports',
            'Legal, Docs & Admin'
        ],
        SCHEMA_SORT_OPTIONS: [
            { id: 'alpha', label: 'Alphabetical (A–Z)' }
        ]
    }
})

describe('Organizer Component UI Tests', () => {
    beforeEach(() => {
        localStorage.clear()
        vi.clearAllMocks()
        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({})),
                    set: vi.fn(),
                    remove: vi.fn()
                },
                session: {
                    get: vi.fn((keys, cb) => cb({})),
                    set: vi.fn()
                }
            }
        }
    })

    afterEach(() => {
        cleanup()
        delete global.chrome
    })

    it('renders the initial UI with Powered by Google Gemini', () => {
        render(<Organizer />)

        expect(screen.getByText(/Powered by/i)).toBeDefined()
        expect(screen.getByText(/Google Gemini/i)).toBeDefined()
        expect(screen.getByPlaceholderText(/AIza\.\.\. \(Google AI Studio\) or sk-or-\.\.\. \(OpenRouter\)/i)).toBeDefined()
    })

    it('allows entering API key and persists to localStorage', () => {
        render(<Organizer />)

        const input = screen.getByPlaceholderText(/AIza\.\.\. \(Google AI Studio\) or sk-or-\.\.\. \(OpenRouter\)/i)
        act(() => {
            fireEvent.change(input, { target: { value: 'sk-or-test-12345' } })
        })

        expect(input.value).toBe('sk-or-test-12345')
        expect(localStorage.getItem('apiKey')).toBe('sk-or-test-12345')
    })

    it('handles status processing and progress to actually update UI progress and logs', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-12345')

        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            this.start = vi.fn(async () => {
                act(() => {
                    onProgress({ status: 'processing', message: 'Classifying batch 1/2...', percent: 0 })
                })
                act(() => {
                    onProgress({ status: 'progress', message: 'Classified batch 1/2.', percent: 50 })
                })
                act(() => {
                    onProgress({ status: 'processing', message: 'Classifying batch 2/2...', percent: 50 })
                })
                act(() => {
                    onProgress({ status: 'progress', message: 'Classified batch 2/2.', percent: 100 })
                })
                act(() => {
                    onProgress({ status: 'done', message: 'Organization complete!' })
                })
                return [
                    { title: 'Item 1', url: 'https://example.com/1', category: 'Tech', sub_category: 'Code' }
                ]
            })
            this.cancel = vi.fn()
            this.isCancelled = false
        })

        render(<Organizer />)

        const startButton = screen.getByRole('button', { name: /Organize My Bookmarks/i })
        expect(startButton.disabled).toBe(false)

        act(() => {
            fireEvent.click(startButton)
        })

        await waitFor(() => {
            expect(screen.getByText(/Classifying batch 1\/2\.\.\./i)).toBeDefined()
            expect(screen.getByText(/Classified batch 1\/2\./i)).toBeDefined()
            expect(screen.getByText(/Organization complete!/i)).toBeDefined()
        })
    })

    it('shows rate limit / network retry notification banner when warning is received and clears on completion', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-12345')

        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            this.start = vi.fn(async () => {
                act(() => {
                    onProgress({
                        status: 'warning',
                        message: 'Rate limit reached (429). Pausing for 8s before retrying batch 1...'
                    })
                })
                act(() => {
                    onProgress({ status: 'done', message: 'Organization complete!' })
                })
                return [{ title: 'Item 1', url: 'https://example.com/1' }]
            })
            this.cancel = vi.fn()
            this.isCancelled = false
        })

        render(<Organizer />)

        const startButton = screen.getByRole('button', { name: /Organize My Bookmarks/i })
        act(() => {
            fireEvent.click(startButton)
        })

        await waitFor(() => {
            expect(screen.getByText(/Organization complete!/i)).toBeDefined()
        })
    })

    it('allows toggling flat date sort (0 AI tokens) which makes API key optional', () => {
        render(<Organizer />)

        const flatToggle = screen.getByRole('switch', { name: /Sort by Date Added \(Flat List\)/i })
        expect(flatToggle.getAttribute('aria-checked')).toBe('false')

        act(() => {
            fireEvent.click(flatToggle)
        })
        expect(flatToggle.getAttribute('aria-checked')).toBe('true')

        expect(screen.getByText(/Optional for flat date sorting/i)).toBeDefined()
    })

    it('provides cancel button during processing that invokes organizer.cancel()', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-12345')

        let serviceInstance = null
        let resolveStart = null
        const startPromise = new Promise(resolve => {
            resolveStart = resolve
        })

        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            serviceInstance = this
            this.start = vi.fn(() => startPromise)
            this.cancel = vi.fn(() => {
                this.isCancelled = true
                act(() => {
                    onProgress({ status: 'warning', message: 'Process cancelled.' })
                })
            })
            this.isCancelled = false
        })

        render(<Organizer />)

        const startButton = screen.getByRole('button', { name: /Organize My Bookmarks/i })
        act(() => {
            fireEvent.click(startButton)
        })

        // Cancel button appears
        const cancelButton = await screen.findByRole('button', { name: /Cancel/i })
        expect(cancelButton).toBeDefined()

        act(() => {
            fireEvent.click(cancelButton)
        })

        expect(serviceInstance.cancel).toHaveBeenCalled()

        resolveStart(null)
    })
})

describe('Last run banner date reporting', () => {
    const savedAt = new Date(2026, 8, 4, 18, 13, 43).getTime()
    const runTime = new Date(savedAt).toLocaleString(undefined, {
        month: 'numeric',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    })

    const bannerText = (stats) => {
        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({ organizedMeta: { count: 3462, savedAt, stats } })),
                    set: vi.fn(),
                    remove: vi.fn()
                },
                session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
            }
        }
        const { container } = render(<Organizer />)
        const banner = container.querySelector('.last-run-banner')
        expect(banner).not.toBeNull()
        return banner.textContent
    }

    afterEach(() => {
        cleanup()
        delete global.chrome
    })

    it('opens with the bare run time and trails the unlabeled bookmark range', () => {
        const text = bannerText({
            total: 3462,
            isFlat: false,
            duplicatesRemoved: 0,
            deadLinksArchived: 0,
            categoriesCount: 12,
            categoryBreakdown: {},
            dateSpan: '7/14/2017 – 11/14/2023'
        })

        expect(text).toContain(`${runTime} · 3,462 bookmarks organized · 7/14/2017 – 11/14/2023`)
        expect(text).not.toContain('Last run')
        expect(text).not.toContain('Dates')
        expect(text).not.toContain('Ran')
        expect(text).not.toContain('6:13:43')
    })

    it('widens a legacy stored single date into a full range', () => {
        const text = bannerText({
            total: 3462,
            isFlat: false,
            duplicatesRemoved: 0,
            deadLinksArchived: 0,
            categoriesCount: 12,
            categoryBreakdown: {},
            dateSpan: '9/3/2026'
        })

        expect(text).toContain('· 9/3/2026 – 9/3/2026')
    })

    it('says the range was not recorded for metadata saved without one, rather than leaving a lone date', () => {
        const text = bannerText({
            total: 3462,
            isFlat: false,
            duplicatesRemoved: 0,
            deadLinksArchived: 0,
            categoriesCount: 12,
            categoryBreakdown: {}
        })

        expect(text).toContain('dates not recorded')
        expect(text.trimStart().startsWith(runTime)).toBe(true)
    })

    it('shows failed moves in the last-run banner', () => {
        const text = bannerText({
            total: 3, isFlat: false, duplicatesRemoved: 0, deadLinksArchived: 0,
            categoriesCount: 1, categoryBreakdown: {},
            failedMoves: [{ title: 'X', reason: 'gone' }]
        })
        expect(text).toContain('1 move failed')
    })

    it('displays date span in the idle schema drawer header when expanded', async () => {
        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({
                        organizedMeta: {
                            count: 10,
                            savedAt,
                            stats: {
                                total: 10,
                                isFlat: false,
                                duplicatesRemoved: 0,
                                deadLinksArchived: 0,
                                categoriesCount: 1,
                                categoryBreakdown: { 'Tech': 10 },
                                dateSpan: '1/1/2021 – 12/31/2023'
                            }
                        }
                    })),
                    set: vi.fn(),
                    remove: vi.fn()
                },
                session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
            }
        }
        render(<Organizer />)
        const schemaBtn = screen.getByRole('button', { name: /Schema/i })
        act(() => {
            fireEvent.click(schemaBtn)
        })
        expect(screen.getAllByText(/Dates 1\/1\/2021 – 12\/31\/2023/i).length).toBe(1)
    })

    it('backfills dateSpan from chrome.storage.session if organizedMeta lacks dateSpan', async () => {
        const mockSet = vi.fn()
        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({
                        organizedMeta: {
                            count: 2,
                            savedAt,
                            stats: {
                                total: 2,
                                isFlat: false
                            }
                        }
                    })),
                    set: mockSet,
                    remove: vi.fn()
                },
                session: {
                    get: vi.fn((keys, cb) => cb({
                        organizedData: [
                            { url: 'https://a.com', dateAdded: 1609459200000 }, // 2021-01-01
                            { url: 'https://b.com', dateAdded: 1703980800000 }  // 2023-12-31
                        ]
                    })),
                    set: vi.fn()
                }
            }
        }

        render(<Organizer />)

        await waitFor(() => {
            expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
                organizedMeta: expect.objectContaining({
                    dateSpan: expect.stringMatching(/\d{1,2}\/\d{1,2}\/\d{4}/)
                })
            }))
        })
    })
})

describe('In-process and completion date range display', () => {
    afterEach(() => {
        cleanup()
        delete global.chrome
    })

    it('renders active date range pill while processing when dateSpan is received', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-12345')

        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            this.start = vi.fn(async () => {
                act(() => {
                    onProgress({
                        status: 'info',
                        message: 'Found 5 bookmarks',
                        dateSpan: '5/10/2018 – 8/20/2024'
                    })
                })
                act(() => {
                    onProgress({
                        status: 'processing',
                        message: 'Classifying bookmarks...',
                        percent: 30
                    })
                })
                // keep in processing state for check
                return new Promise(() => {})
            })
            this.cancel = vi.fn()
            this.isCancelled = false
        })

        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({})),
                    set: vi.fn(),
                    remove: vi.fn()
                },
                session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
            }
        }

        render(<Organizer />)

        const startButton = screen.getByRole('button', { name: /Organize My Bookmarks/i })
        act(() => {
            fireEvent.click(startButton)
        })

        await waitFor(() => {
            expect(screen.getByText(/5\/10\/2018 – 8\/20\/2024/i)).toBeDefined()
        })
    })

    it('displays date range under download button on completion screen', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-12345')

        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            this.start = vi.fn(async () => {
                act(() => {
                    onProgress({ status: 'done', message: 'Complete!' })
                })
                const results = [
                    { title: 'Item 1', url: 'https://example.com/1', dateAdded: 1609459200000 }
                ]
                results.stats = {
                    total: 1,
                    isFlat: false,
                    duplicatesRemoved: 0,
                    deadLinksArchived: 0,
                    categoriesCount: 1,
                    dateSpan: '1/1/2021'
                }
                return results
            })
            this.cancel = vi.fn()
            this.isCancelled = false
        })

        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({})),
                    set: vi.fn(),
                    remove: vi.fn()
                },
                session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
            }
        }

        render(<Organizer />)

        const startButton = screen.getByRole('button', { name: /Organize My Bookmarks/i })
        act(() => {
            fireEvent.click(startButton)
        })

        await waitFor(() => {
            expect(screen.getByText(/All Done! Check your "AI Organized Bookmarks" folder/i)).toBeDefined()
            expect(screen.getByText(/Date range:/i)).toBeDefined()
            expect(screen.getByRole('button', { name: /Download Organized Bookmarks/i }).getAttribute('title')).toContain('Dates 1/1/2021')
        })
    })

    it('shows the compact sort label and an oldest-to-newest range in the completion stats pill', async () => {
        localStorage.setItem('apiKey', 'sk-or-test-12345')

        OrganizerService.mockImplementation(function (apiKey, categories, onProgress) {
            this.start = vi.fn(async () => {
                act(() => {
                    onProgress({ status: 'done', message: 'Complete!' })
                })
                const results = [{ title: 'Item 1', url: 'https://example.com/1', dateAdded: 1788489600000 }]
                results.stats = {
                    total: 3462,
                    isFlat: false,
                    duplicatesRemoved: 0,
                    deadLinksArchived: 0,
                    categoriesCount: 9,
                    schemaSortOrder: 'alpha',
                    categoryBreakdown: {},
                    dateSpan: '9/3/2026 – 9/3/2026'
                }
                return results
            })
            this.cancel = vi.fn()
            this.isCancelled = false
        })

        global.chrome = {
            storage: {
                local: {
                    get: vi.fn((keys, cb) => cb({})),
                    set: vi.fn(),
                    remove: vi.fn()
                },
                session: { get: vi.fn((keys, cb) => cb({})), set: vi.fn() }
            }
        }

        const { container } = render(<Organizer />)

        act(() => {
            fireEvent.click(screen.getByRole('button', { name: /Organize My Bookmarks/i }))
        })

        await waitFor(() => {
            const pill = container.querySelector('.stats-pill')
            expect(pill).not.toBeNull()
            expect(pill.textContent).toContain('A–Z')
            expect(pill.textContent).toContain('Dates 9/3/2026 – 9/3/2026')
            expect(pill.textContent).not.toContain('Alphabetical')
        })
    })

    describe('Background Organization and Reconnection', () => {
        it('restores in-flight background organization state from session storage on mount', async () => {
            global.chrome = {
                storage: {
                    local: {
                        get: vi.fn((keys, cb) => cb({})),
                        set: vi.fn(),
                        remove: vi.fn()
                    },
                    session: {
                        get: vi.fn((keys, cb) => {
                            if (keys.includes('activeJobState')) {
                                cb({
                                    activeJobState: {
                                        status: 'processing',
                                        progress: 68,
                                        activeDateSpan: '1/1/2024 – 6/1/2024',
                                        logs: [
                                            { message: 'Classifying batch 2/4 in background...', timestamp: Date.now() }
                                        ]
                                    }
                                })
                            } else {
                                cb({})
                            }
                        }),
                        set: vi.fn()
                    }
                }
            }

            render(<Organizer />)

            await waitFor(() => {
                expect(screen.getByText(/68%/i)).toBeDefined()
                expect(screen.getByText(/1\/1\/2024 – 6\/1\/2024/i)).toBeDefined()
                expect(screen.getByText(/Classifying batch 2\/4 in background/i)).toBeDefined()
                expect(screen.getByRole('button', { name: /Cancel/i })).toBeDefined()
            })
        })

        it('dispatches START_JOB and CANCEL_JOB over port to service worker when connected', async () => {
            localStorage.setItem('apiKey', 'sk-or-test-port')

            const mockPort = {
                postMessage: vi.fn(),
                onMessage: { addListener: vi.fn() },
                onDisconnect: { addListener: vi.fn() },
                disconnect: vi.fn()
            }

            global.chrome = {
                runtime: {
                    connect: vi.fn(() => mockPort)
                },
                storage: {
                    local: {
                        get: vi.fn((keys, cb) => cb({})),
                        set: vi.fn(),
                        remove: vi.fn()
                    },
                    session: {
                        get: vi.fn((keys, cb) => cb({})),
                        set: vi.fn()
                    }
                }
            }

            render(<Organizer />)

            expect(global.chrome.runtime.connect).toHaveBeenCalledWith({ name: 'organizer-channel' })

            act(() => {
                fireEvent.click(screen.getByRole('button', { name: /Organize My Bookmarks/i }))
            })

            expect(mockPort.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'START_JOB',
                    payload: expect.objectContaining({
                        config: expect.objectContaining({ apiKey: 'sk-or-test-port' })
                    })
                })
            )

            // Click Cancel
            act(() => {
                fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))
            })

            expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'CANCEL_JOB' })
        })
    })
})

