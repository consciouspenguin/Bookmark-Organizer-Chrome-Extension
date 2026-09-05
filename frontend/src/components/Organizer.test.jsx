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
