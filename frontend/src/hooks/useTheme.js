import { useState, useEffect, useCallback } from 'react'

const STORAGE_KEY = 'themeMode'

function getSystemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
}

// Resolve a mode ('dark' | 'light' | 'system') to an actual theme and apply it.
function applyTheme(mode) {
    const resolved = mode === 'system' ? getSystemTheme() : mode
    document.documentElement.setAttribute('data-theme', resolved)
    return resolved
}

function getInitialTheme() {
    try {
        return localStorage.getItem(STORAGE_KEY) || 'light';
    } catch {
        return 'light';
    }
}

/**
 * Theme controller. Returns the chosen mode, the resolved theme actually
 * shown, and a setter. Persists to chrome.storage (with localStorage fallback)
 * and reacts to OS changes while in "system" mode.
 */
export function useTheme() {
    const [theme, setThemeState] = useState(getInitialTheme)
    const [resolved, setResolved] = useState(() => applyTheme(getInitialTheme()))

    // Sync from chrome.storage if present
    useEffect(() => {
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            chrome.storage.local.get([STORAGE_KEY], (r) => {
                if (r && r[STORAGE_KEY]) {
                    setThemeState(r[STORAGE_KEY])
                    setResolved(applyTheme(r[STORAGE_KEY]))
                    try { localStorage.setItem(STORAGE_KEY, r[STORAGE_KEY]) } catch { /* ignore */ }
                }
            })
        }
    }, [])

    // Follow the OS when in "system" mode
    useEffect(() => {
        if (theme !== 'system') return
        const mq = window.matchMedia('(prefers-color-scheme: dark)')
        const handler = () => setResolved(applyTheme('system'))
        mq.addEventListener('change', handler)
        return () => mq.removeEventListener('change', handler)
    }, [theme])

    const setTheme = useCallback((mode) => {
        setThemeState(mode)
        setResolved(applyTheme(mode))
        try { localStorage.setItem(STORAGE_KEY, mode) } catch { /* ignore */ }
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            chrome.storage.local.set({ [STORAGE_KEY]: mode })
        }
    }, [])

    return { theme, resolved, setTheme }
}
