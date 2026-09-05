import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Terminal, Play, AlertCircle, Plus, X, Bookmark, Upload, FileText, Lock, Zap, Download, Loader2, RefreshCw, Square, Copy, Check, ChevronDown, ChevronUp, Clock, ArrowDown, ArrowUp, ArrowDownAZ, ArrowUpAZ, Globe, FolderTree, ExternalLink } from 'lucide-react'
import { OrganizerService } from '../services/organizer'
import { detectProvider } from '../services/ai'
import { parseBookmarks } from '../utils/parser'
import { downloadBookmarks } from '../services/bookmarks_export'

export const DEFAULT_CATEGORIES = [
    'Work & Career',
    'Finance & Crypto',
    'Design & Media',
    'Reading & Knowledge',
    'Entertainment & Social',
    'Shopping & Tools',
    'Travel & Lifestyle',
    'Tech & Development'
];

export const SUGGESTED_ADDABLE_CATEGORIES = [
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
];

export const SCHEMA_SORT_OPTIONS = [
    {
        id: 'alpha',
        label: 'Alphabetical (A–Z)',
        badge: 'Default',
        icon: ArrowDownAZ,
        desc: 'Folders and bookmarks sorted alphabetically by title A to Z.'
    },
    {
        id: 'date-desc',
        label: 'Date Added (Newest First)',
        badge: 'Recent',
        icon: ArrowDown,
        desc: 'Folders sorted A–Z; newest bookmarks at the top of each folder.'
    },
    {
        id: 'date-asc',
        label: 'Date Added (Oldest First)',
        badge: 'Archive',
        icon: ArrowUp,
        desc: 'Folders sorted A–Z; earliest saved bookmarks at the top of each folder.'
    },
    {
        id: 'domain',
        label: 'By Website / Domain (A–Z)',
        badge: 'Grouped',
        icon: Globe,
        desc: 'Groups bookmarks by domain (e.g. github.com, youtube.com), then title.'
    },
    {
        id: 'alpha-desc',
        label: 'Reverse Alphabetical (Z–A)',
        badge: 'Z → A',
        icon: ArrowUpAZ,
        desc: 'Folders and bookmarks sorted in reverse alphabetical order Z to A.'
    }
];

// Synchronous in-process memory reader (0.05ms latency, zero IPC overhead)
const getStored = (key, fallback) => {
    try {
        const item = localStorage.getItem(key);
        return item !== null ? JSON.parse(item) : fallback;
    } catch {
        return fallback;
    }
};

export default function Organizer() {
    const [status, setStatus] = useState('idle') // idle, processing, complete, error
    const [logs, setLogs] = useState([])
    const [progress, setProgress] = useState(0)
    const [errorMsg, setErrorMsg] = useState('')
    const [backgroundNotice, setBackgroundNotice] = useState('')
    const [isCancelling, setIsCancelling] = useState(false)
    const organizedResultsRef = useRef(null)
    const [lastOrganized, setLastOrganized] = useState(null)
    const [showSchema, setShowSchema] = useState(true)
    const [showIdleSchema, setShowIdleSchema] = useState(false)
    const [copiedSchema, setCopiedSchema] = useState(false)

    const handleCopySchema = useCallback((breakdown) => {
        if (!breakdown) return
        const text = Object.entries(breakdown)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([cat, count]) => `${cat}: ${count}`)
            .join('\n')
        navigator.clipboard?.writeText(text).then(() => {
            setCopiedSchema(true)
            setTimeout(() => setCopiedSchema(false), 2000)
        })
    }, [])

    // API Key — synchronous in-process memory initialization (0ms delay)
    const [apiKey, setApiKey] = useState(() => {
        try { return localStorage.getItem('apiKey') || '' } catch { return '' }
    })

    // Auto-detect provider from key format
    const provider = useMemo(() => detectProvider(apiKey), [apiKey])

    // Models supported for Google Gemini
    const models = useMemo(() => [
        {
            id: 'google/gemini-3.1-flash-lite',
            name: '3.1 Flash Lite',
            label: '3.1 Flash Lite',
            badge: 'Default',
            desc: 'Recommended default — ultra-fast latency and minimal token cost.',
            description: 'Recommended default — ultra-fast latency and minimal token cost.'
        },
        {
            id: 'google/gemini-3.8-flash',
            name: '3.8 Flash',
            label: '3.8 Flash',
            badge: 'Balanced',
            desc: 'High intelligence & reasoning for everyday bookmark collections.',
            description: 'High intelligence & reasoning for everyday bookmark collections.'
        },
        {
            id: 'google/gemini-3.1-pro-preview',
            name: '3.1 Pro Preview',
            label: '3.1 Pro Preview',
            badge: 'Deep Reasoning',
            desc: 'Complex taxonomies & heavy loads with rich nested structures.',
            description: 'Complex taxonomies & heavy loads with rich nested structures.'
        },
    ], [])

    const [selectedModel, setSelectedModel] = useState(() => {
        try {
            const m = localStorage.getItem('selectedModel')
            return m && ['google/gemini-3.1-flash-lite', 'google/gemini-3.8-flash', 'google/gemini-3.1-pro-preview'].includes(m)
                ? m
                : 'google/gemini-3.1-flash-lite'
        } catch {
            return 'google/gemini-3.1-flash-lite'
        }
    })

    // Default Categories — instantaneous bootstrap
    const [categories, setCategories] = useState(() => getStored('categories', DEFAULT_CATEGORIES))
    const [newCategory, setNewCategory] = useState('')

    // Suggested Categories not yet in active categories
    const availableSuggestions = useMemo(() =>
        SUGGESTED_ADDABLE_CATEGORIES.filter(s => !categories.some(c => c.toLowerCase() === s.toLowerCase())),
        [categories]
    )

    // Folder Content Sorting inside schema folders (alpha, date-desc, date-asc, domain, alpha-desc)
    const [schemaSortOrder, setSchemaSortOrder] = useState(() => {
        try {
            const s = localStorage.getItem('schemaSortOrder')
            return s && SCHEMA_SORT_OPTIONS.some(opt => opt.id === s) ? s : 'alpha'
        } catch {
            return 'alpha'
        }
    })
    const sortAlphabetically = schemaSortOrder === 'alpha'

    // Keep only one copy of each exact URL in the organized output.
    const [removeDuplicates, setRemoveDuplicates] = useState(() => getStored('removeDuplicates', true))

    // Clean messy or truncated titles with AI
    const [cleanTitles, setCleanTitles] = useState(() => getStored('cleanTitles', false))

    // Flat chronological sort by date added — ALWAYS false by default on launch
    const [flatDateSort, setFlatDateSort] = useState(false)
    const [dateSortOrder, setDateSortOrder] = useState(() => {
        try {
            const o = localStorage.getItem('dateSortOrder')
            return o === 'asc' || o === 'desc' ? o : 'desc'
        } catch {
            return 'desc'
        }
    })

    // Subfolder Target Size
    const subfolderTargetOptions = useMemo(() => [
        { id: '0-5', label: 'Compact (0-5)', description: 'Minimal subfolders' },
        { id: '5-10', label: 'Balanced (5-10)', description: 'Recommended' },
        { id: '10+', label: 'Detailed (10+)', description: 'More specific grouping' }
    ], [])
    const [subfolderTarget, setSubfolderTarget] = useState(() => {
        try {
            const t = localStorage.getItem('subfolderTarget')
            return t && ['0-5', '5-10', '10+'].includes(t) ? t : '5-10'
        } catch {
            return '5-10'
        }
    })
    const subfolderOptions = subfolderTargetOptions

    const logContainerRef = useRef(null)
    const organizerRef = useRef(null)

    // Non-blocking background sync from chrome.storage (runs AFTER UI is already painted)
    useEffect(() => {
        const startTime = performance.now()
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            chrome.storage.local.get(['apiKey', 'categories', 'selectedModel', 'subfolderTarget', 'sortAlphabetically', 'schemaSortOrder', 'removeDuplicates', 'cleanTitles', 'dateSortOrder', 'organizedMeta'], (result) => {
                if (!result) return
                if (result.apiKey && result.apiKey !== apiKey) setApiKey(result.apiKey)
                if (result.categories && Array.isArray(result.categories) && result.categories.length > 0) {
                    setCategories(result.categories)
                    try { localStorage.setItem('categories', JSON.stringify(result.categories)) } catch {}
                }
                if (result.selectedModel === 'google/gemini-2.5-pro') {
                    setSelectedModel('google/gemini-3.1-pro-preview')
                    try { localStorage.setItem('selectedModel', 'google/gemini-3.1-pro-preview') } catch {}
                    chrome.storage.local.set({ selectedModel: 'google/gemini-3.1-pro-preview' })
                } else if (result.selectedModel && ['google/gemini-3.1-flash-lite', 'google/gemini-3.8-flash', 'google/gemini-3.1-pro-preview'].includes(result.selectedModel)) {
                    setSelectedModel(result.selectedModel)
                    try { localStorage.setItem('selectedModel', result.selectedModel) } catch {}
                }
                if (result.subfolderTarget) {
                    setSubfolderTarget(result.subfolderTarget)
                    try { localStorage.setItem('subfolderTarget', result.subfolderTarget) } catch {}
                }
                if (result.schemaSortOrder && SCHEMA_SORT_OPTIONS.some(opt => opt.id === result.schemaSortOrder)) {
                    setSchemaSortOrder(result.schemaSortOrder)
                    try { localStorage.setItem('schemaSortOrder', result.schemaSortOrder) } catch {}
                } else if (typeof result.sortAlphabetically === 'boolean') {
                    const fallbackOrder = result.sortAlphabetically ? 'alpha' : 'date-desc'
                    setSchemaSortOrder(fallbackOrder)
                    try { localStorage.setItem('schemaSortOrder', fallbackOrder) } catch {}
                }
                if (typeof result.removeDuplicates === 'boolean') {
                    setRemoveDuplicates(result.removeDuplicates)
                    try { localStorage.setItem('removeDuplicates', JSON.stringify(result.removeDuplicates)) } catch {}
                }
                if (result.cleanTitles !== undefined) {
                    setCleanTitles(Boolean(result.cleanTitles))
                    try { localStorage.setItem('cleanTitles', JSON.stringify(Boolean(result.cleanTitles))) } catch {}
                }
                if (result.dateSortOrder === 'asc' || result.dateSortOrder === 'desc') {
                    setDateSortOrder(result.dateSortOrder)
                    try { localStorage.setItem('dateSortOrder', result.dateSortOrder) } catch {}
                }
                if (result.organizedMeta) setLastOrganized(result.organizedMeta)

                console.log(`[Startup] Side panel ready & synced in ${(performance.now() - startTime).toFixed(1)}ms`)
            })

            // Defer LevelDB cleanup to idle time (3s delay) so disk I/O NEVER competes with window opening
            const cleanupTimer = setTimeout(() => {
                chrome.storage.local.remove(['organizedData', 'flatDateSort'])
            }, 3000)
            return () => clearTimeout(cleanupTimer)
        }
    }, [])

    // Save Settings to both in-process memory and chrome.storage
    const updateSetting = useCallback((key, val) => {
        try {
            if (typeof val === 'string') localStorage.setItem(key, val)
            else localStorage.setItem(key, JSON.stringify(val))
        } catch {}
        if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            chrome.storage.local.set({ [key]: val })
        }
    }, [])

    const handleApiKeyChange = useCallback((val) => {
        setApiKey(val)
        updateSetting('apiKey', val)
    }, [updateSetting])

    const handleModelChange = useCallback((modelId) => {
        setSelectedModel(modelId)
        updateSetting('selectedModel', modelId)
    }, [updateSetting])

    const handleSubfolderTargetChange = useCallback((target) => {
        setSubfolderTarget(target)
        updateSetting('subfolderTarget', target)
    }, [updateSetting])

    const handleSchemaSortChange = useCallback((newOrder) => {
        setSchemaSortOrder(newOrder)
        updateSetting('schemaSortOrder', newOrder)
        updateSetting('sortAlphabetically', newOrder === 'alpha')
    }, [updateSetting])

    const handleRemoveDuplicatesToggle = useCallback((enabled) => {
        setRemoveDuplicates(enabled)
        updateSetting('removeDuplicates', enabled)
    }, [updateSetting])

    const handleCleanTitlesToggle = useCallback((enabled) => {
        setCleanTitles(enabled)
        updateSetting('cleanTitles', enabled)
    }, [updateSetting])

    const handleFlatDateSortToggle = useCallback((enabled) => {
        setFlatDateSort(enabled)
    }, [])

    const handleDateSortOrderChange = useCallback((order) => {
        setDateSortOrder(order)
        updateSetting('dateSortOrder', order)
    }, [updateSetting])

    const handleAddCategory = useCallback((catName) => {
        const trimmed = (catName || '').trim();
        if (!trimmed) return;
        if (categories.some(c => c.toLowerCase() === trimmed.toLowerCase())) return;
        const next = [...categories, trimmed];
        setCategories(next);
        updateSetting('categories', next);
    }, [categories, updateSetting]);

    const handleRemoveCategory = useCallback((indexToRemove) => {
        const next = categories.filter((_, i) => i !== indexToRemove);
        setCategories(next);
        updateSetting('categories', next);
    }, [categories, updateSetting]);

    const handleClearAllCategories = useCallback(() => {
        setCategories([]);
        updateSetting('categories', []);
    }, [updateSetting]);

    const handleResetDefaultCategories = useCallback(() => {
        setCategories(DEFAULT_CATEGORIES);
        updateSetting('categories', DEFAULT_CATEGORIES);
    }, [updateSetting]);

    // File Upload Handlers
    const [uploadedFile, setUploadedFile] = useState(null)
    const [parsedBookmarks, setParsedBookmarks] = useState(null)
    const fileInputRef = useRef(null)

    const addLog = useCallback((message) => {
        setLogs(prev => [...prev, { message, timestamp: new Date() }])
    }, [])

    const processFile = useCallback((file) => {
        if (!file.name.endsWith('.html') && !file.name.endsWith('.htm')) {
            setErrorMsg("Please upload a valid bookmarks HTML file.");
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target.result;
            try {
                const links = parseBookmarks(content);
                setUploadedFile(file);
                setParsedBookmarks(links);
                setErrorMsg('');
                addLog(`Loaded ${file.name} (${links.length} bookmarks found)`);
            } catch (err) {
                console.error(err);
                setErrorMsg("Failed to parse bookmarks file.");
            }
        };
        reader.readAsText(file);
    }, [addLog])

    const handleFileSelect = useCallback(async (e) => {
        const file = e.target.files[0];
        if (file) processFile(file);
    }, [processFile])

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) processFile(file);
    }, [processFile])

    const handleDragOver = useCallback((e) => {
        e.preventDefault();
    }, [])

    // Auto-scroll logs
    useEffect(() => {
        if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
        }
    }, [logs])

    const downloadOrganized = useCallback(() => {
        if (organizedResultsRef.current) {
            downloadBookmarks(organizedResultsRef.current)
            return
        }
        if (typeof chrome !== 'undefined' && chrome.storage) {
            const retrieve = (data) => {
                if (data && data.length > 0) {
                    organizedResultsRef.current = data
                    downloadBookmarks(data)
                } else {
                    setErrorMsg('No saved organized bookmarks found.')
                    setLastOrganized(null)
                }
            }

            if (chrome.storage.session) {
                chrome.storage.session.get(['organizedData'], (res) => {
                    if (res?.organizedData && res.organizedData.length > 0) {
                        retrieve(res.organizedData)
                    } else if (chrome.storage.local) {
                        chrome.storage.local.get(['organizedData'], (localRes) => {
                            retrieve(localRes?.organizedData)
                        })
                    } else {
                        retrieve(null)
                    }
                })
            } else if (chrome.storage.local) {
                chrome.storage.local.get(['organizedData'], (localRes) => {
                    retrieve(localRes?.organizedData)
                })
            }
        }
    }, [])

    const handleCancel = useCallback(() => {
        if (organizerRef.current) {
            organizerRef.current.cancel();
            setIsCancelling(true);
            addLog('Cancellation requested — halting operations...');
        }
    }, [addLog]);

    const resetApp = useCallback(() => {
        if (organizerRef.current) {
            organizerRef.current.cancel();
        }
        setIsCancelling(false);
        setStatus('idle')
        setLogs([])
        setProgress(0)
        setErrorMsg('')
        setBackgroundNotice('')
        setUploadedFile(null)
        setParsedBookmarks(null)
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, [])

    const startProcess = useCallback(async () => {
        const requiresApiKey = !flatDateSort || cleanTitles;
        if (requiresApiKey && !apiKey) {
            setErrorMsg(`Please enter your Google AI Studio or OpenRouter API Key.`);
            return;
        }

        setIsCancelling(false);

        try {
            setStatus('processing');
            if (flatDateSort) {
                const orderLabel = dateSortOrder === 'desc' ? 'Newest First' : 'Oldest First';
                setLogs([
                    { message: 'Starting Chronological Date Sort...', timestamp: new Date() },
                    { message: 'Mode: Flat List (No Folders / Schema-free)', timestamp: new Date() },
                    { message: `Sort Direction: ${orderLabel}`, timestamp: new Date() },
                    { message: `Remove Duplicate URLs: ${removeDuplicates ? 'On' : 'Off'}`, timestamp: new Date() },
                    { message: `Clean Bookmark Titles: ${cleanTitles ? 'On' : 'Off'}`, timestamp: new Date() }
                ]);
            } else {
                const selectedModelLabel = models.find(m => m.id === selectedModel)?.label || selectedModel;
                const subfolderLabel = subfolderOptions.find(opt => opt.id === subfolderTarget)?.label || subfolderTarget;
                const sortLabel = SCHEMA_SORT_OPTIONS.find(opt => opt.id === schemaSortOrder)?.label || 'Alphabetical (A–Z)';
                setLogs([
                    { message: 'Starting AI Organization...', timestamp: new Date() },
                    { message: `Using Model: Google Gemini ${selectedModelLabel}`, timestamp: new Date() },
                    { message: `Subfolder Organization: ${subfolderLabel}`, timestamp: new Date() },
                    { message: `Folder Content Sorting: ${sortLabel}`, timestamp: new Date() },
                    { message: `Remove Duplicate URLs: ${removeDuplicates ? 'On' : 'Off'}`, timestamp: new Date() },
                    { message: `Clean Bookmark Titles: ${cleanTitles ? 'On' : 'Off'}`, timestamp: new Date() }
                ]);
            }
            setProgress(0);
            setErrorMsg('');
            setBackgroundNotice('');

            organizerRef.current = new OrganizerService(
                apiKey,
                categories,
                (data) => {
                    if (data.status === 'info') {
                        addLog(data.message);
                    } else if (data.status === 'processing') {
                        if (data.message) addLog(data.message);
                        if (typeof data.percent === 'number') setProgress(data.percent);
                    } else if (data.status === 'progress') {
                        if (data.message) addLog(data.message);
                        setProgress(data.percent);
                        if (data.clearNotice) {
                            setBackgroundNotice('');
                        }
                    } else if (data.status === 'retry') {
                        addLog(data.message);
                        setBackgroundNotice(data.message);
                    } else if (data.status === 'warning') {
                        addLog(data.message);
                        if (data.message?.includes('Pausing') || data.message?.includes('Retrying') || data.message?.includes('background')) {
                            setBackgroundNotice(data.message);
                        }
                        if (data.message?.includes('cancelled')) {
                            setStatus('idle');
                            setIsCancelling(false);
                        }
                    } else if (data.status === 'error') {
                        setErrorMsg(data.message);
                        setBackgroundNotice('');
                        setStatus('error');
                    } else if (data.status === 'success') {
                        addLog(data.message);
                        setBackgroundNotice('');
                    } else if (data.status === 'done') {
                        addLog(data.message);
                        setBackgroundNotice('');
                        setStatus('complete');
                        setProgress(100);
                    }
                },
                selectedModel,
                subfolderTarget,
                sortAlphabetically,
                removeDuplicates,
                cleanTitles,
                flatDateSort,
                dateSortOrder,
                schemaSortOrder
            );

            // Pass parsed bookmarks if file mode, otherwise null (browser mode)
            const results = await organizerRef.current.start(parsedBookmarks);

            if (organizerRef.current?.isCancelled || !results) {
                setStatus('idle');
                setIsCancelling(false);
                return;
            }

            if (results && results.length > 0) {
                organizedResultsRef.current = results;
                const stats = organizerRef.current?.stats || results.stats || null;
                const meta = { count: results.length, savedAt: Date.now(), stats };
                setLastOrganized(meta);
                if (typeof chrome !== 'undefined' && chrome.storage) {
                    // Save bookmark tree into memory-based session storage (RAM) so local LevelDB remains tiny (<5KB)
                    if (chrome.storage.session) {
                        try {
                            chrome.storage.session.set({ organizedData: results });
                        } catch { /* ignore session set errors */ }
                    }
                    chrome.storage.local.set({ organizedMeta: meta }, () => {
                        if (chrome.runtime.lastError) {
                            addLog(`Could not save results metadata: ${chrome.runtime.lastError.message}`);
                        } else {
                            addLog('Results saved — downloadable anytime during your browsing session.');
                        }
                    });
                }
            }

        } catch (err) {
            console.error(err);
            setErrorMsg("Failed to start process.");
            setStatus('error');
        } finally {
            setIsCancelling(false);
        }
    }, [apiKey, models, selectedModel, categories, addLog, parsedBookmarks, subfolderTarget, subfolderOptions, sortAlphabetically, schemaSortOrder, removeDuplicates, cleanTitles, flatDateSort, dateSortOrder]);

    const canStart = (flatDateSort && !cleanTitles) || Boolean(apiKey);

    return (
        <div className="glass-panel main-glass-panel">

            {/* API Key Input */}
            <div className="section-block">
                <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: '500' }}>
                    API Key {(!flatDateSort || cleanTitles) ? <span style={{ color: 'var(--error)' }}>*</span> : null}
                    <span style={{ marginLeft: '0.5rem', color: 'var(--text-muted)', fontWeight: '400' }}>
                        {flatDateSort && !cleanTitles ? 'Optional for flat date sorting' : 'Google AI Studio or OpenRouter'}
                    </span>
                </label>
                <input
                    type="password"
                    placeholder="AIza... (Google AI Studio) or sk-or-... (OpenRouter)"
                    value={apiKey}
                    onChange={(e) => handleApiKeyChange(e.target.value)}
                    style={{
                        width: '100%',
                        padding: '0.75rem',
                        borderRadius: '8px',
                        border: '1px solid var(--border)',
                        background: 'var(--surface-solid)',
                        color: 'var(--text-primary)',
                        fontSize: '1rem',
                        outline: 'none',
                        marginBottom: '0.4rem',
                        boxSizing: 'border-box'
                    }}
                />

                {/* Minimal Quick Links to Get API Keys */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '0.5rem',
                    marginBottom: '0.65rem',
                    padding: '0 0.15rem'
                }}>
                    <a
                        href="https://aistudio.google.com/app/apikey"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.3rem',
                            color: 'var(--accent)',
                            fontSize: '0.74rem',
                            textDecoration: 'none',
                            opacity: 0.9,
                            transition: 'opacity 0.2s ease'
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.textDecoration = 'underline'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.9'; e.currentTarget.style.textDecoration = 'none'; }}
                    >
                        <span>Get Google AI Studio Key (Free)</span>
                        <ExternalLink size={11} />
                    </a>
                    <a
                        href="https://openrouter.ai/keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.3rem',
                            color: 'var(--accent)',
                            fontSize: '0.74rem',
                            textDecoration: 'none',
                            opacity: 0.9,
                            transition: 'opacity 0.2s ease'
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.textDecoration = 'underline'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.9'; e.currentTarget.style.textDecoration = 'none'; }}
                    >
                        <span>Get OpenRouter Key</span>
                        <ExternalLink size={11} />
                    </a>
                </div>

                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', background: 'var(--surface-alt)', padding: '0.75rem', borderRadius: '6px', border: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.25rem' }}>
                        <Lock size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />
                        <span>Your API key is stored locally in your browser.</span>
                    </div>
                </div>

                <div style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                    <p style={{ margin: 0, display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                        <Zap size={14} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: '2px' }} />
                        <span>
                            Powered by <strong>Google Gemini</strong>. Paste a key from{' '}
                            <strong>Google AI Studio</strong> (free, starts with <code>AIza</code>) or{' '}
                            <strong>OpenRouter</strong> (<code>sk-or-</code>) — the provider is detected
                            automatically{apiKey ? `: ${provider === 'gemini' ? 'Google AI Studio' : 'OpenRouter'}` : ''}.
                        </span>
                    </p>
                </div>
            </div>

            {/* Model Selector */}
            {status === 'idle' && (!flatDateSort || cleanTitles) && (
                <div className="card-panel section-block">
                    <label style={{ display: 'block', marginBottom: '0.75rem', color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: '500' }}>
                        Select AI Model
                    </label>
                    <div className="model-selector-grid">
                        {models.map((model) => (
                            <button
                                key={model.id}
                                onClick={() => handleModelChange(model.id)}
                                className={`model-select-btn ${selectedModel === model.id ? 'active' : ''}`}
                            >
                                <span className="model-name">{model.name}</span>
                                {model.badge && (
                                    <span className="model-badge">
                                        ({model.badge})
                                    </span>
                                )}
                            </button>
                        ))}
                    </div>
                    <div className="model-desc">
                        {models.find(m => m.id === selectedModel)?.description || models.find(m => m.id === selectedModel)?.desc || '3.1 Flash Lite: Recommended default — ultra-fast latency and minimal token cost.'}
                    </div>
                </div>
            )}

            {/* Sort by Date Added (Flat List) — Conditionally Active Flat Pipeline */}
            {status === 'idle' && (
                <div className={`flat-date-card section-block ${flatDateSort ? 'active' : ''}`}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.85rem' }}>
                            <div style={{
                                width: '36px',
                                height: '36px',
                                borderRadius: '10px',
                                background: flatDateSort ? 'var(--accent-gradient)' : 'var(--surface-solid)',
                                color: flatDateSort ? '#ffffff' : 'var(--accent)',
                                border: '1px solid var(--border)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0,
                                boxShadow: flatDateSort ? '0 2px 8px var(--accent-glow)' : 'none',
                                transition: 'all 0.2s ease',
                                marginTop: '2px'
                            }}>
                                <Clock size={18} />
                            </div>
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                    <label style={{ display: 'block', color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: '700' }}>
                                        Sort by Date Added (Flat List)
                                    </label>
                                    <span style={{
                                        fontSize: '0.68rem',
                                        padding: '0.15rem 0.5rem',
                                        borderRadius: '10px',
                                        background: 'var(--accent-soft)',
                                        border: '1px solid var(--border)',
                                        color: 'var(--accent)',
                                        fontWeight: 700,
                                        letterSpacing: '0.4px',
                                        textTransform: 'uppercase'
                                    }}>
                                        Zero AI Tokens
                                    </span>
                                </div>
                                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.25rem', lineHeight: '1.35' }}>
                                    Orders all bookmarks chronologically into a single list without folders.
                                </div>
                            </div>
                        </div>
                        <button
                            role="switch"
                            aria-label="Sort by Date Added (Flat List)"
                            aria-checked={flatDateSort}
                            onClick={() => handleFlatDateSortToggle(!flatDateSort)}
                            style={{
                                width: '46px',
                                height: '26px',
                                borderRadius: '13px',
                                border: '1px solid var(--border)',
                                background: flatDateSort ? 'var(--accent)' : 'var(--surface-solid)',
                                position: 'relative',
                                cursor: 'pointer',
                                padding: 0,
                                flexShrink: 0,
                                transition: 'all 0.2s ease',
                                boxShadow: flatDateSort ? '0 0 10px var(--accent-glow)' : 'none'
                            }}
                        >
                            <span style={{
                                position: 'absolute',
                                top: '2px',
                                left: flatDateSort ? '22px' : '2px',
                                width: '20px',
                                height: '20px',
                                borderRadius: '50%',
                                background: flatDateSort ? '#ffffff' : 'var(--text-muted)',
                                transition: 'left 0.2s ease',
                                boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                            }} />
                        </button>
                    </div>

                    {flatDateSort && (
                        <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.4rem' }}>
                                <label style={{ color: 'var(--text-primary)', fontSize: '0.82rem', fontWeight: '600' }}>
                                    Chronological Direction
                                </label>
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                                    {dateSortOrder === 'desc' ? 'Newest bookmarks at the top' : 'Oldest bookmarks at the top'}
                                </span>
                            </div>
                            <div style={{ display: 'flex', gap: '0.5rem', padding: '0.3rem', background: 'var(--surface-solid)', borderRadius: '8px', border: '1px solid var(--border)' }}>
                                <button
                                    type="button"
                                    onClick={() => handleDateSortOrderChange('desc')}
                                    style={{
                                        flex: 1,
                                        padding: '0.5rem 0.75rem',
                                        borderRadius: '6px',
                                        border: 'none',
                                        background: dateSortOrder === 'desc' ? 'var(--accent-gradient)' : 'transparent',
                                        color: dateSortOrder === 'desc' ? '#ffffff' : 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        fontSize: '0.82rem',
                                        fontWeight: dateSortOrder === 'desc' ? '600' : '500',
                                        transition: 'all 0.2s ease',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: '0.4rem',
                                        boxShadow: dateSortOrder === 'desc' ? '0 1px 8px var(--accent-glow)' : 'none'
                                    }}
                                >
                                    <ArrowDown size={14} />
                                    <span>Newest First</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleDateSortOrderChange('asc')}
                                    style={{
                                        flex: 1,
                                        padding: '0.5rem 0.75rem',
                                        borderRadius: '6px',
                                        border: 'none',
                                        background: dateSortOrder === 'asc' ? 'var(--accent-gradient)' : 'transparent',
                                        color: dateSortOrder === 'asc' ? '#ffffff' : 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        fontSize: '0.82rem',
                                        fontWeight: dateSortOrder === 'asc' ? '600' : '500',
                                        transition: 'all 0.2s ease',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: '0.4rem',
                                        boxShadow: dateSortOrder === 'asc' ? '0 1px 8px var(--accent-glow)' : 'none'
                                    }}
                                >
                                    <ArrowUp size={14} />
                                    <span>Oldest First</span>
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Subfolder & Sorting Strategy Row (2-col grid on wide, stacked on compact) */}
            {status === 'idle' && !flatDateSort && (
                <div className="settings-grid-row section-block">
                    {/* Subfolder Target Size */}
                    <div className="card-panel">
                        <label style={{ display: 'block', marginBottom: '0.75rem', color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: '500' }}>
                            Subfolder Organization
                        </label>
                        <div style={{ display: 'flex', gap: '0.5rem', padding: '0.4rem', background: 'var(--surface-solid)', borderRadius: '8px', border: '1px solid var(--border)' }}>
                            {subfolderOptions.map((option) => (
                                <button
                                    key={option.id}
                                    onClick={() => handleSubfolderTargetChange(option.id)}
                                    style={{
                                        flex: 1,
                                        padding: '0.6rem 0.8rem',
                                        borderRadius: '6px',
                                        border: 'none',
                                        background: subfolderTarget === option.id ? 'var(--accent-gradient)' : 'transparent',
                                        color: subfolderTarget === option.id ? 'var(--on-accent)' : 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        fontSize: '0.85rem',
                                        fontWeight: subfolderTarget === option.id ? '600' : '500',
                                        transition: 'all 0.2s ease',
                                        boxShadow: subfolderTarget === option.id ? '0 1px 10px var(--accent-glow)' : 'none'
                                    }}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.75rem' }}>
                            {subfolderOptions.find(opt => opt.id === subfolderTarget)?.description}
                        </div>
                    </div>

                    {/* Folder Content Sorting (Schema-Dependent Mode) */}
                    <div className="card-panel">
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.65rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <FolderTree size={18} style={{ color: 'var(--accent)' }} />
                                <label style={{ display: 'block', color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: '600' }}>
                                    Folder Content Sorting
                                </label>
                            </div>
                            <span style={{
                                fontSize: '0.72rem',
                                padding: '0.15rem 0.5rem',
                                borderRadius: '10px',
                                background: 'var(--surface-solid)',
                                border: '1px solid var(--border)',
                                color: 'var(--accent)',
                                fontWeight: 600
                            }}>
                                {SCHEMA_SORT_OPTIONS.find(opt => opt.id === schemaSortOrder)?.badge || 'Active'}
                            </span>
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '1rem', lineHeight: '1.4' }}>
                            Choose how bookmarks are ordered inside each AI-generated category folder:
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            {SCHEMA_SORT_OPTIONS.map(option => {
                                const isSelected = schemaSortOrder === option.id;
                                const IconComponent = option.icon;
                                return (
                                    <button
                                        key={option.id}
                                        type="button"
                                        onClick={() => handleSchemaSortChange(option.id)}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            padding: '0.75rem 1rem',
                                            borderRadius: '8px',
                                            border: isSelected ? '2px solid var(--accent)' : '1px solid var(--border)',
                                            background: isSelected ? 'var(--surface-solid)' : 'transparent',
                                            color: 'var(--text-primary)',
                                            cursor: 'pointer',
                                            textAlign: 'left',
                                            transition: 'all 0.2s ease',
                                            boxShadow: isSelected ? '0 2px 10px var(--accent-glow)' : 'none'
                                        }}
                                    >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                            <div style={{
                                                width: '32px',
                                                height: '32px',
                                                borderRadius: '8px',
                                                background: isSelected ? 'var(--accent-soft)' : 'var(--surface-solid)',
                                                color: isSelected ? 'var(--accent)' : 'var(--text-muted)',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                flexShrink: 0,
                                                border: '1px solid var(--border)'
                                            }}>
                                                <IconComponent size={16} />
                                            </div>
                                            <div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                    <span style={{ fontSize: '0.86rem', fontWeight: isSelected ? '600' : '500' }}>
                                                        {option.label}
                                                    </span>
                                                </div>
                                                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                                                    {option.desc}
                                                </div>
                                            </div>
                                        </div>
                                        {isSelected && (
                                            <div style={{
                                                width: '20px',
                                                height: '20px',
                                                borderRadius: '50%',
                                                background: 'var(--accent)',
                                                color: 'var(--on-accent)',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                flexShrink: 0,
                                                marginLeft: '0.5rem'
                                            }}>
                                                <Check size={12} strokeWidth={3} />
                                            </div>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}

            {/* Toggles Row (2-col grid on wide, stacked on compact) */}
            {status === 'idle' && (
                <div className="settings-grid-row section-block">
                    {/* Duplicate Removal Toggle */}
                    <div className="card-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                        <div>
                            <label style={{ display: 'block', color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: '500' }}>
                                Remove Duplicate URLs
                            </label>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                                Keep one copy of each URL in the organized result; original bookmarks are unchanged
                            </div>
                        </div>
                        <button
                            role="switch"
                            aria-label="Remove duplicate URLs"
                            aria-checked={removeDuplicates}
                            onClick={() => handleRemoveDuplicatesToggle(!removeDuplicates)}
                            style={{
                                width: '44px',
                                height: '24px',
                                borderRadius: '12px',
                                border: '1px solid var(--border)',
                                background: removeDuplicates ? 'var(--accent)' : 'var(--surface-solid)',
                                position: 'relative',
                                cursor: 'pointer',
                                padding: 0,
                                flexShrink: 0,
                                transition: 'background 0.2s ease'
                            }}
                        >
                            <span style={{
                                position: 'absolute',
                                top: '2px',
                                left: removeDuplicates ? '22px' : '2px',
                                width: '18px',
                                height: '18px',
                                borderRadius: '50%',
                                background: removeDuplicates ? 'var(--on-accent)' : 'var(--text-muted)',
                                transition: 'left 0.2s ease'
                            }} />
                        </button>
                    </div>

                    {/* Clean Titles Toggle */}
                    <div className="card-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                <label style={{ display: 'block', color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: '600' }}>
                                    Clean Titles with AI
                                </label>
                                <span style={{
                                    fontSize: '0.68rem',
                                    padding: '0.12rem 0.45rem',
                                    borderRadius: '10px',
                                    background: cleanTitles ? 'var(--accent-soft)' : 'var(--surface-solid)',
                                    border: '1px solid var(--border)',
                                    color: cleanTitles ? 'var(--accent)' : 'var(--text-muted)',
                                    fontWeight: 600,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.3px'
                                }}>
                                    Consumes AI Tokens
                                </span>
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.35rem', lineHeight: '1.4' }}>
                                {flatDateSort
                                    ? 'Uses AI to rewrite cryptic, truncated, or raw-URL titles into clean names while preserving chronological date order. Consumes AI tokens and requires an API key.'
                                    : 'Uses AI to rewrite messy, truncated, or raw-URL titles into human-readable names. Consumes AI tokens.'}
                            </div>
                        </div>
                        <button
                            role="switch"
                            aria-label="Clean Titles with AI"
                            aria-checked={cleanTitles}
                            onClick={() => handleCleanTitlesToggle(!cleanTitles)}
                            style={{
                                width: '44px',
                                height: '24px',
                                borderRadius: '12px',
                                border: '1px solid var(--border)',
                                background: cleanTitles ? 'var(--accent)' : 'var(--surface-solid)',
                                position: 'relative',
                                cursor: 'pointer',
                                padding: 0,
                                flexShrink: 0,
                                transition: 'background 0.2s ease'
                            }}
                        >
                            <span style={{
                                position: 'absolute',
                                top: '2px',
                                left: cleanTitles ? '22px' : '2px',
                                width: '18px',
                                height: '18px',
                                borderRadius: '50%',
                                background: cleanTitles ? 'var(--on-accent)' : 'var(--text-muted)',
                                transition: 'left 0.2s ease'
                            }} />
                        </button>
                    </div>
                </div>
            )}

            {/* Category Editor */}
            {status === 'idle' && !flatDateSort && (
                <div className="glass-panel categories-panel section-block">
                    {/* Header with Title, Count Badge, and Clear All / Reset Action */}
                    <div className="categories-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <h3 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1.05rem', fontWeight: 600 }}>
                                Customize Categories
                            </h3>
                            <span style={{
                                fontSize: '0.72rem',
                                padding: '0.15rem 0.5rem',
                                borderRadius: '12px',
                                background: 'var(--surface-solid)',
                                border: '1px solid var(--border)',
                                color: 'var(--text-muted)'
                            }}>
                                {categories.length} chosen
                            </span>
                        </div>
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                            {categories.length > 0 ? (
                                <button
                                    type="button"
                                    onClick={handleClearAllCategories}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.3rem',
                                        padding: '0.25rem 0.6rem',
                                        fontSize: '0.75rem',
                                        borderRadius: '6px',
                                        border: '1px solid var(--error-soft)',
                                        background: 'var(--error-soft)',
                                        color: 'var(--error)',
                                        cursor: 'pointer',
                                        transition: 'all 0.15s ease'
                                    }}
                                    title="Clear all active categories"
                                >
                                    <X size={12} />
                                    <span>Clear All</span>
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={handleResetDefaultCategories}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.3rem',
                                        padding: '0.25rem 0.6rem',
                                        fontSize: '0.75rem',
                                        borderRadius: '6px',
                                        border: '1px solid var(--border)',
                                        background: 'var(--surface-solid)',
                                        color: 'var(--accent)',
                                        cursor: 'pointer',
                                        transition: 'all 0.15s ease'
                                    }}
                                    title="Reset to default categories"
                                >
                                    <RefreshCw size={12} />
                                    <span>Reset Defaults</span>
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Custom Category Input */}
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
                        <input
                            type="text"
                            placeholder="Add custom category..."
                            value={newCategory}
                            onChange={(e) => setNewCategory(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && newCategory.trim()) {
                                    handleAddCategory(newCategory);
                                    setNewCategory('');
                                }
                            }}
                            style={{
                                flex: 1,
                                padding: '0.5rem 0.75rem',
                                borderRadius: '6px',
                                border: '1px solid var(--border)',
                                background: 'var(--surface-solid)',
                                color: 'var(--text-primary)',
                                outline: 'none',
                                fontSize: '0.85rem'
                            }}
                        />
                        <button
                            type="button"
                            onClick={() => {
                                if (newCategory.trim()) {
                                    handleAddCategory(newCategory);
                                    setNewCategory('');
                                }
                            }}
                            className="btn-secondary"
                            style={{
                                padding: '0.5rem 0.85rem',
                                borderRadius: '6px',
                                border: '1px solid var(--border)',
                                background: 'var(--accent)',
                                color: 'var(--on-accent)',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.3rem',
                                fontSize: '0.85rem',
                                fontWeight: 500
                            }}
                        >
                            <Plus size={15} />
                            <span>Add</span>
                        </button>
                    </div>

                    {/* Active Chosen Categories Bin */}
                    {categories.length === 0 ? (
                        <div style={{
                            padding: '0.85rem',
                            textAlign: 'center',
                            fontSize: '0.8rem',
                            color: 'var(--text-muted)',
                            background: 'var(--surface-solid)',
                            borderRadius: '8px',
                            border: '1px dashed var(--border)'
                        }}>
                            No categories chosen. AI will automatically design a structure from your bookmarks, or you can add from the suggestions below.
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                            {categories.map((cat, idx) => (
                                <div key={idx} style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.45rem',
                                    background: 'var(--surface-solid)',
                                    border: '1px solid var(--border)',
                                    padding: '0.25rem 0.75rem',
                                    borderRadius: '20px',
                                    fontSize: '0.85rem',
                                    color: 'var(--text-secondary)'
                                }}>
                                    <span>{cat}</span>
                                    <X
                                        size={14}
                                        style={{ cursor: 'pointer', color: 'var(--error)' }}
                                        onClick={() => handleRemoveCategory(idx)}
                                        title={`Remove "${cat}"`}
                                    />
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Second List: Suggested Categories (Addable Pool) */}
                    {availableSuggestions.length > 0 && (
                        <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.65rem' }}>
                                <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                                    Suggested Categories
                                </span>
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                                    Click + to add into chosen
                                </span>
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem' }}>
                                {availableSuggestions.map((sug) => (
                                    <div
                                        key={sug}
                                        onClick={() => handleAddCategory(sug)}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.4rem',
                                            background: 'var(--surface-solid)',
                                            border: '1px dashed var(--border)',
                                            padding: '0.25rem 0.65rem',
                                            borderRadius: '20px',
                                            fontSize: '0.82rem',
                                            color: 'var(--text-secondary)',
                                            cursor: 'pointer',
                                            transition: 'all 0.15s ease'
                                        }}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.borderColor = 'var(--success)';
                                            e.currentTarget.style.color = 'var(--text-primary)';
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.borderColor = 'var(--border)';
                                            e.currentTarget.style.color = 'var(--text-secondary)';
                                        }}
                                        title={`Add "${sug}" to chosen categories`}
                                    >
                                        <span>{sug}</span>
                                        <Plus
                                            size={14}
                                            style={{ color: 'var(--success)', flexShrink: 0 }}
                                        />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* File Upload Area */}
            {status === 'idle' && (
                <div
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    className={`upload-dropzone section-block ${uploadedFile ? 'has-file' : ''}`}
                    onClick={() => fileInputRef.current.click()}
                >
                    <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileSelect}
                        accept=".html,.htm"
                        style={{ display: 'none' }}
                    />

                    {uploadedFile ? (
                        <div>
                            <div style={{ color: 'var(--success)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                                <FileText size={24} />
                                <span style={{ fontWeight: 'bold' }}>{uploadedFile.name}</span>
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                {parsedBookmarks ? `${parsedBookmarks.length} bookmarks ready` : 'Ready to process'}
                            </div>
                            <button
                                onClick={(e) => { e.stopPropagation(); resetApp(); }}
                                style={{
                                    marginTop: '0.5rem',
                                    background: 'transparent',
                                    border: 'none',
                                    color: 'var(--error)',
                                    fontSize: '0.8rem',
                                    cursor: 'pointer',
                                    textDecoration: 'underline'
                                }}
                            >
                                Remove File
                            </button>
                        </div>
                    ) : (
                        <div>
                            <Upload size={24} style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }} />
                            <div style={{ color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
                                Drag & drop bookmarks.html here
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                or click to browse
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--terminal-muted)', marginTop: '1rem' }}>
                                (Optional - defaults to browser's current bookmarks)
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Saved results from a previous run (persists across panel sessions) */}
            {status === 'idle' && lastOrganized && (
                <div className="last-run-banner section-block">
                    <div className="last-run-header">
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            Last run: {lastOrganized.count.toLocaleString()} bookmarks {lastOrganized.stats?.isFlat ? 'sorted' : 'organized'}
                            {lastOrganized.stats?.isFlat && ` · ${lastOrganized.stats?.dateSortOrder === 'desc' ? 'Newest First' : 'Oldest First'}`}
                            {lastOrganized.stats?.dateSpan && ` · ${lastOrganized.stats.dateSpan}`}
                            {lastOrganized.stats?.duplicatesRemoved > 0 && ` · ${lastOrganized.stats.duplicatesRemoved} dupes`}
                            {lastOrganized.stats?.deadLinksArchived > 0 && ` · ${lastOrganized.stats.deadLinksArchived} archived`}
                            <span style={{ color: 'var(--text-muted)' }}> · {new Date(lastOrganized.savedAt).toLocaleString()}</span>
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            {lastOrganized.stats?.categoryBreakdown && Object.keys(lastOrganized.stats.categoryBreakdown).length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setShowIdleSchema(!showIdleSchema)}
                                    title="View category counts"
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.3rem',
                                        padding: '0.5rem 0.75rem',
                                        borderRadius: '6px',
                                        border: '1px solid var(--border)',
                                        background: 'var(--surface-solid)',
                                        color: 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        fontSize: '0.85rem',
                                        whiteSpace: 'nowrap'
                                    }}
                                >
                                    {showIdleSchema ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                    Schema
                                </button>
                            )}
                            <button
                                onClick={downloadOrganized}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.4rem',
                                    padding: '0.5rem 0.9rem',
                                    borderRadius: '6px',
                                    border: 'none',
                                    background: 'var(--accent)',
                                    color: 'var(--on-accent)',
                                    cursor: 'pointer',
                                    fontSize: '0.85rem',
                                    whiteSpace: 'nowrap'
                                }}
                            >
                                <Download size={15} />
                                Download
                            </button>
                        </div>
                    </div>
                    {showIdleSchema && lastOrganized.stats?.categoryBreakdown && (
                        <div style={{
                            borderTop: '1px solid var(--border)',
                            background: 'var(--surface-solid)',
                            padding: '0.75rem 1rem'
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                                    Category Schema ({Object.keys(lastOrganized.stats.categoryBreakdown).length} categories)
                                </span>
                                <button
                                    type="button"
                                    onClick={() => handleCopySchema(lastOrganized.stats.categoryBreakdown)}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.3rem',
                                        padding: '0.2rem 0.5rem',
                                        borderRadius: '4px',
                                        border: '1px solid var(--border)',
                                        background: copiedSchema ? 'var(--success-soft)' : 'var(--surface-alt)',
                                        color: copiedSchema ? 'var(--success)' : 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        fontSize: '0.75rem'
                                    }}
                                >
                                    {copiedSchema ? <Check size={12} /> : <Copy size={12} />}
                                    {copiedSchema ? 'Copied' : 'Copy'}
                                </button>
                            </div>
                            <div style={{
                                maxHeight: '160px',
                                overflowY: 'auto',
                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                                fontSize: '0.8rem',
                                lineHeight: '1.6'
                            }}>
                                {Object.entries(lastOrganized.stats.categoryBreakdown)
                                    .sort(([a], [b]) => a.localeCompare(b))
                                    .map(([category, count]) => (
                                        <div key={category} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '1px 0' }}>
                                            <span>{category}</span>
                                            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{count}</span>
                                        </div>
                                    ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Controls */}
            <div className="action-button-container section-block" style={{ display: 'flex', justifyContent: 'center' }}>
                {status === 'complete' ? (
                    <div style={{ textAlign: 'center', width: '100%' }}>
                        <div style={{ marginBottom: '0.75rem', color: 'var(--success)', fontSize: '1.2rem', fontWeight: 'bold' }}>
                            {uploadedFile
                                ? "File Processed! Check your downloads."
                                : (flatDateSort ? 'All Done! Check your "Chronological Bookmarks" folder.' : 'All Done! Check your "AI Organized Bookmarks" folder.')}
                        </div>
                        {lastOrganized?.stats && (
                            <div style={{
                                display: 'inline-flex',
                                flexWrap: 'wrap',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '0.6rem',
                                padding: '0.4rem 0.9rem',
                                marginBottom: '1rem',
                                borderRadius: '20px',
                                background: 'var(--surface-alt)',
                                border: '1px solid var(--border)',
                                fontSize: '0.85rem',
                                color: 'var(--text-secondary)'
                            }}>
                                <span><strong>{lastOrganized.stats.total.toLocaleString()}</strong> {lastOrganized.stats.isFlat ? 'sorted' : 'organized'}</span>
                                <span>•</span>
                                <span><strong>{lastOrganized.stats.duplicatesRemoved}</strong> duplicates</span>
                                {lastOrganized.stats.deadLinksArchived > 0 && (
                                    <>
                                        <span>•</span>
                                        <span><strong>{lastOrganized.stats.deadLinksArchived}</strong> dead archived</span>
                                    </>
                                )}
                                {lastOrganized.stats.isFlat ? (
                                    <>
                                        <span>•</span>
                                        <span><strong>{lastOrganized.stats.dateSortOrder === 'desc' ? 'Newest First' : 'Oldest First'}</strong></span>
                                        {lastOrganized.stats.dateSpan && (
                                            <>
                                                <span>•</span>
                                                <span>{lastOrganized.stats.dateSpan}</span>
                                            </>
                                        )}
                                    </>
                                ) : (
                                    <>
                                        <span>•</span>
                                        <span><strong>{lastOrganized.stats.categoriesCount}</strong> categories</span>
                                        {lastOrganized.stats.schemaSortOrder && (
                                            <>
                                                <span>•</span>
                                                <span><strong>{SCHEMA_SORT_OPTIONS.find(o => o.id === lastOrganized.stats.schemaSortOrder)?.label || 'A–Z'}</strong></span>
                                            </>
                                        )}
                                        {lastOrganized.stats.dateSpan && (
                                            <>
                                                <span>•</span>
                                                <span>{lastOrganized.stats.dateSpan}</span>
                                            </>
                                        )}
                                    </>
                                )}
                            </div>
                        )}
                        {lastOrganized?.stats?.categoryBreakdown && Object.keys(lastOrganized.stats.categoryBreakdown).length > 0 && (
                            <div style={{
                                margin: '0 auto 1.25rem auto',
                                maxWidth: '440px',
                                textAlign: 'left',
                                background: 'var(--surface-alt)',
                                border: '1px solid var(--border)',
                                borderRadius: '10px',
                                overflow: 'hidden'
                            }}>
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '0.6rem 0.9rem',
                                    background: 'var(--surface-solid)',
                                    borderBottom: showSchema ? '1px solid var(--border)' : 'none',
                                    fontSize: '0.85rem',
                                    fontWeight: '600',
                                    color: 'var(--text-primary)'
                                }}>
                                    <button
                                        type="button"
                                        onClick={() => setShowSchema(!showSchema)}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.4rem',
                                            background: 'none',
                                            border: 'none',
                                            padding: 0,
                                            color: 'inherit',
                                            cursor: 'pointer',
                                            fontSize: 'inherit',
                                            fontWeight: 'inherit'
                                        }}
                                    >
                                        {showSchema ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                                        <span>Category Schema ({Object.keys(lastOrganized.stats.categoryBreakdown).length})</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleCopySchema(lastOrganized.stats.categoryBreakdown)}
                                        title="Copy category list as plain text"
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.3rem',
                                            padding: '0.25rem 0.6rem',
                                            borderRadius: '5px',
                                            border: '1px solid var(--border)',
                                            background: copiedSchema ? 'var(--success-soft)' : 'var(--surface-alt)',
                                            color: copiedSchema ? 'var(--success)' : 'var(--text-secondary)',
                                            cursor: 'pointer',
                                            fontSize: '0.75rem',
                                            fontWeight: '500',
                                            transition: 'all 0.2s ease'
                                        }}
                                    >
                                        {copiedSchema ? <Check size={13} /> : <Copy size={13} />}
                                        {copiedSchema ? 'Copied' : 'Copy'}
                                    </button>
                                </div>
                                {showSchema && (
                                    <div style={{
                                        padding: '0.6rem 0.9rem',
                                        maxHeight: '180px',
                                        overflowY: 'auto',
                                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                                        fontSize: '0.8rem',
                                        lineHeight: '1.6',
                                        color: 'var(--text-primary)'
                                    }}>
                                        {Object.entries(lastOrganized.stats.categoryBreakdown)
                                            .sort(([a], [b]) => a.localeCompare(b))
                                            .map(([category, count]) => (
                                                <div key={category} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '1px 0' }}>
                                                    <span>{category}</span>
                                                    <span style={{ color: 'var(--accent)', fontWeight: '600' }}>{count}</span>
                                                </div>
                                            ))}
                                    </div>
                                )}
                            </div>
                        )}
                        {lastOrganized && (
                            <div style={{ marginBottom: '1rem' }}>
                                <button
                                    className="btn-primary"
                                    onClick={downloadOrganized}
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}
                                >
                                    <Download size={18} />
                                    {lastOrganized.stats?.isFlat ? 'Download Chronological Bookmarks' : 'Download Organized Bookmarks'}
                                </button>
                            </div>
                        )}
                        <div
                            onClick={resetApp}
                            style={{
                                cursor: 'pointer',
                                color: 'var(--accent)',
                                fontSize: '0.9rem',
                                border: '1px solid var(--border)',
                                padding: '0.5rem 1rem',
                                borderRadius: '6px',
                                background: 'var(--accent-soft)',
                                display: 'inline-block'
                            }}
                        >
                            {flatDateSort ? 'Sort Again' : 'Organize Again'}
                        </div>
                    </div>
                ) : status === 'processing' ? (
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <button
                            className="btn-primary btn-in-progress"
                            disabled
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem',
                                cursor: 'wait'
                            }}
                        >
                            <Loader2 size={18} className="spin-icon" />
                            <span>In Progress... {progress}%</span>
                        </button>
                        <button
                            type="button"
                            onClick={handleCancel}
                            disabled={isCancelling}
                            title="Cancel the organization process"
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.4rem',
                                padding: '0.8rem 1.25rem',
                                borderRadius: '10px',
                                border: '1px solid var(--error)',
                                background: 'var(--error-soft)',
                                color: 'var(--error)',
                                fontWeight: '600',
                                fontSize: '0.95rem',
                                cursor: isCancelling ? 'not-allowed' : 'pointer',
                                opacity: isCancelling ? 0.6 : 1,
                                transition: 'all 0.2s ease'
                            }}
                        >
                            <Square size={16} fill="currentColor" />
                            {isCancelling ? 'Cancelling...' : 'Cancel'}
                        </button>
                    </div>
                ) : (
                    <button
                        className="btn-primary"
                        onClick={startProcess}
                        disabled={!canStart}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            opacity: !canStart ? 0.5 : 1,
                            cursor: !canStart ? 'not-allowed' : 'pointer'
                        }}
                    >
                        {flatDateSort ? (
                            <>
                                <Clock size={20} />
                                {uploadedFile ? 'Sort File & Download' : 'Sort My Bookmarks by Date'}
                            </>
                        ) : (
                            <>
                                {uploadedFile ? <FileText size={20} /> : <Bookmark size={20} />}
                                {uploadedFile ? 'Organize File & Download' : 'Organize My Bookmarks'}
                            </>
                        )}
                    </button>
                )}
            </div>

            {/* Background Ongoing Progress / Transient Retry Notification */}
            {status === 'processing' && backgroundNotice && (
                <div style={{
                    background: 'var(--success-soft)',
                    border: '1px solid var(--success)',
                    color: 'var(--success)',
                    padding: '0.85rem 1rem',
                    borderRadius: '8px',
                    marginBottom: '1.5rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    fontSize: '0.85rem'
                }}>
                    <RefreshCw size={18} className="spin-icon" style={{ flexShrink: 0 }} />
                    <div>
                        <strong>Background Run Active:</strong> {backgroundNotice}
                    </div>
                </div>
            )}

            {/* Error Message */}
            {errorMsg && (
                <div style={{ background: 'var(--error-soft)', border: '1px solid var(--error)', color: 'var(--error)', padding: '1rem', borderRadius: '8px', marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <AlertCircle size={20} />
                    {errorMsg}
                </div>
            )}

            {/* Logs / Terminal */}
            <div
                className="glass-panel terminal-panel"
                ref={logContainerRef}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid var(--terminal-muted)', paddingBottom: '0.5rem', color: 'var(--text-muted)' }}>
                    <Terminal size={16} />
                    <span>System Output</span>
                </div>

                {logs.length === 0 && <span style={{ color: 'var(--terminal-muted)' }}>Waiting for start...</span>}

                {logs.map((log, index) => (
                    <div key={index} style={{ marginBottom: '0.25rem', display: 'flex', gap: '0.5rem' }}>
                        <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                            {typeof log === 'object' ? log.timestamp.toLocaleTimeString() : new Date().toLocaleTimeString()}
                        </span>
                        <span style={{ overflowWrap: 'anywhere' }}>
                            {typeof log === 'object' ? log.message : log}
                        </span>
                    </div>
                ))}
                {status === 'processing' && (
                    <div className="animate-pulse">_</div>
                )}
            </div>

        </div>
    )
}
