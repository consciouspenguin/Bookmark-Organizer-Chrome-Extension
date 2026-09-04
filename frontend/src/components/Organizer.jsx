import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Terminal, Play, AlertCircle, Plus, X, Bookmark, Upload, FileText, Lock, Zap, Download } from 'lucide-react'
import { OrganizerService } from '../services/organizer'
import { detectProvider } from '../services/ai'
import { parseBookmarks } from '../utils/parser'
import { downloadBookmarks } from '../services/bookmarks_export'

export default function Organizer() {
    const [status, setStatus] = useState('idle') // idle, processing, complete, error
    const [logs, setLogs] = useState([])
    const [progress, setProgress] = useState(0)
    const [errorMsg, setErrorMsg] = useState('')
    const organizedResultsRef = useRef(null)
    const [lastOrganized, setLastOrganized] = useState(null)

    // API Key — single field accepts a Google AI Studio ("AIza...") or OpenRouter ("sk-or-...") key
    const [apiKey, setApiKey] = useState('')
    const provider = useMemo(() => detectProvider(apiKey), [apiKey])

    // Model Selection — Gemini Flash & Flash-Lite models (OpenRouter + Google AI Studio)
    const [selectedModel, setSelectedModel] = useState('google/gemini-3.1-flash-lite')
    const models = useMemo(() => [
        { id: 'google/gemini-3.1-flash-lite', label: '3.1 Flash Lite (Fast & Cheap)' },
        { id: 'google/gemini-3.8-flash', label: '3.8 Flash (Recommended)' },
        { id: 'google/gemini-3.7-flash', label: '3.7 Flash' },
        { id: 'google/gemini-2.5-flash', label: '2.5 Flash' },
        { id: 'google/gemini-2.5-pro', label: '2.5 Pro' }
    ], [])

    const [categories, setCategories] = useState([
        "Technology & Coding",
        "News & Research",
        "Entertainment & Media",
        "Shopping & Products",
        "Finance & Business",
        "Education & Reference",
        "Social & Community",
        "Lifestyle & Health",
        "Work & Productivity",
        "Design & Creative"
    ])
    const [newCategory, setNewCategory] = useState('')

    // Sort folders/bookmarks alphabetically after classification
    const [sortAlphabetically, setSortAlphabetically] = useState(true)

    // Keep only one copy of each exact URL in the organized output.
    const [removeDuplicates, setRemoveDuplicates] = useState(true)

    // Subfolder Target Size
    const [subfolderTarget, setSubfolderTarget] = useState('5-10')
    const subfolderOptions = useMemo(() => [
        { id: '0-5', label: 'Compact (0-5)', description: 'Minimal subfolders' },
        { id: '5-10', label: 'Balanced (5-10)', description: 'Recommended' },
        { id: '10+', label: 'Detailed (10+)', description: 'More specific grouping' }
    ], [])

    const logContainerRef = useRef(null)
    const organizerRef = useRef(null)

    // Load Settings from storage
    useEffect(() => {
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.get(['apiKey', 'selectedModel', 'subfolderTarget', 'sortAlphabetically', 'removeDuplicates', 'organizedMeta'], (result) => {
                if (result.apiKey) setApiKey(result.apiKey)
                if (result.selectedModel) setSelectedModel(result.selectedModel)
                if (result.subfolderTarget) setSubfolderTarget(result.subfolderTarget)
                if (typeof result.sortAlphabetically === 'boolean') setSortAlphabetically(result.sortAlphabetically)
                if (typeof result.removeDuplicates === 'boolean') setRemoveDuplicates(result.removeDuplicates)
                if (result.organizedMeta) setLastOrganized(result.organizedMeta)
            })
        }
    }, [])

    // Save Settings
    const updateSetting = useCallback((key, val) => {
        if (typeof chrome !== 'undefined' && chrome.storage) {
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

    const handleSortToggle = useCallback((enabled) => {
        setSortAlphabetically(enabled)
        updateSetting('sortAlphabetically', enabled)
    }, [updateSetting])

    const handleRemoveDuplicatesToggle = useCallback((enabled) => {
        setRemoveDuplicates(enabled)
        updateSetting('removeDuplicates', enabled)
    }, [updateSetting])

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
            chrome.storage.local.get(['organizedData'], (result) => {
                if (result.organizedData && result.organizedData.length > 0) {
                    organizedResultsRef.current = result.organizedData
                    downloadBookmarks(result.organizedData)
                } else {
                    setErrorMsg('No saved organized bookmarks found.')
                    setLastOrganized(null)
                }
            })
        }
    }, [])

    const resetApp = useCallback(() => {
        setStatus('idle')
        setLogs([])
        setProgress(0)
        setErrorMsg('')
        setUploadedFile(null)
        setParsedBookmarks(null)
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, [])

    const startProcess = useCallback(async () => {
        if (!apiKey) {
            setErrorMsg(`Please enter your Google AI Studio or OpenRouter API Key.`)
            return
        }

        try {
            setStatus('processing')
            const selectedModelLabel = models.find(m => m.id === selectedModel)?.label || selectedModel
            const subfolderLabel = subfolderOptions.find(opt => opt.id === subfolderTarget)?.label || subfolderTarget
            setLogs([
                { message: 'Starting AI Organization...', timestamp: new Date() },
                { message: `Using Model: Google Gemini ${selectedModelLabel}`, timestamp: new Date() },
                { message: `Subfolder Organization: ${subfolderLabel}`, timestamp: new Date() },
                { message: `Alphabetical Sorting: ${sortAlphabetically ? 'On' : 'Off'}`, timestamp: new Date() },
                { message: `Remove Duplicate URLs: ${removeDuplicates ? 'On' : 'Off'}`, timestamp: new Date() }
            ])
            setProgress(0)
            setErrorMsg('')

            organizerRef.current = new OrganizerService(
                apiKey,
                categories,
                (data) => {
                    if (data.status === 'info') {
                        addLog(data.message)
                    } else if (data.status === 'progress') {
                        setProgress(data.percent)
                    } else if (data.status === 'warning') {
                        addLog(data.message)
                    } else if (data.status === 'error') {
                        setErrorMsg(data.message)
                        setStatus('error')
                    } else if (data.status === 'success') {
                        addLog(data.message)
                    } else if (data.status === 'done') {
                        addLog(data.message)
                        setStatus('complete')
                        setProgress(100)
                    }
                },
                selectedModel,
                subfolderTarget,
                sortAlphabetically,
                removeDuplicates
            )

            // Pass parsed bookmarks if file mode, otherwise null (browser mode)
            const results = await organizerRef.current.start(parsedBookmarks)

            if (results && results.length > 0) {
                organizedResultsRef.current = results
                const stats = organizerRef.current?.stats || results.stats || null
                const meta = { count: results.length, savedAt: Date.now(), stats }
                setLastOrganized(meta)
                if (typeof chrome !== 'undefined' && chrome.storage) {
                    chrome.storage.local.set({ organizedData: results, organizedMeta: meta }, () => {
                        if (chrome.runtime.lastError) {
                            addLog(`Could not save results for later download: ${chrome.runtime.lastError.message}`)
                        } else {
                            addLog('Results saved — downloadable anytime, even after closing this panel.')
                        }
                    })
                }
            }

        } catch (err) {
            console.error(err)
            setErrorMsg("Failed to start process.")
            setStatus('error')
        }
    }, [apiKey, models, selectedModel, categories, addLog, parsedBookmarks, subfolderTarget, subfolderOptions, sortAlphabetically, removeDuplicates])

    return (
        <div className="glass-panel" style={{ width: '100%', padding: '2rem', textAlign: 'left', boxSizing: 'border-box' }}>

            {/* API Key Input */}
            <div style={{ marginBottom: '2rem' }}>
                <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: '500' }}>
                    API Key <span style={{ color: 'var(--error)' }}>*</span>
                    <span style={{ marginLeft: '0.5rem', color: 'var(--text-muted)', fontWeight: '400' }}>
                        Google AI Studio or OpenRouter
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
                        marginBottom: '0.5rem',
                        boxSizing: 'border-box'
                    }}
                />

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
            {status === 'idle' && (
                <div style={{ marginBottom: '2rem', padding: '1.5rem', background: 'var(--surface-alt)', borderRadius: '8px', border: '1px solid var(--border)' }}>
                    <label style={{ display: 'block', marginBottom: '0.75rem', color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: '500' }}>
                        Select AI Model
                    </label>
                    <div style={{ display: 'flex', gap: '0.5rem', padding: '0.4rem', background: 'var(--surface-solid)', borderRadius: '8px', border: '1px solid var(--border)' }}>
                        {models.map((model) => (
                            <button
                                key={model.id}
                                onClick={() => handleModelChange(model.id)}
                                style={{
                                    flex: 1,
                                    padding: '0.6rem 0.8rem',
                                    borderRadius: '6px',
                                    border: 'none',
                                    background: selectedModel === model.id ? 'var(--accent-gradient)' : 'transparent',
                                    color: selectedModel === model.id ? 'var(--on-accent)' : 'var(--text-secondary)',
                                    cursor: 'pointer',
                                    fontSize: '0.85rem',
                                    fontWeight: selectedModel === model.id ? '600' : '500',
                                    transition: 'all 0.2s ease',
                                    boxShadow: selectedModel === model.id ? '0 1px 10px var(--accent-glow)' : 'none'
                                }}
                            >
                                {model.label}
                            </button>
                        ))}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.75rem' }}>
                        3.5 Flash: best accuracy. 2.5 Flash: faster & efficient. 3.1 Lite: lightweight option.
                    </div>
                </div>
            )}

            {/* Subfolder Target Size */}
            {status === 'idle' && (
                <div style={{ marginBottom: '2rem', padding: '1.5rem', background: 'var(--surface-alt)', borderRadius: '8px', border: '1px solid var(--border)' }}>
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
            )}

            {/* Alphabetical Sorting Toggle */}
            {status === 'idle' && (
                <div style={{ marginBottom: '2rem', padding: '1.5rem', background: 'var(--surface-alt)', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                    <div>
                        <label style={{ display: 'block', color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: '500' }}>
                            Sort Alphabetically
                        </label>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                            Sort folders and the bookmarks inside them A–Z
                        </div>
                    </div>
                    <button
                        role="switch"
                        aria-checked={sortAlphabetically}
                        onClick={() => handleSortToggle(!sortAlphabetically)}
                        style={{
                            width: '44px',
                            height: '24px',
                            borderRadius: '12px',
                            border: '1px solid var(--border)',
                            background: sortAlphabetically ? 'var(--accent)' : 'var(--surface-solid)',
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
                            left: sortAlphabetically ? '22px' : '2px',
                            width: '18px',
                            height: '18px',
                            borderRadius: '50%',
                            background: sortAlphabetically ? 'var(--on-accent)' : 'var(--text-muted)',
                            transition: 'left 0.2s ease'
                        }} />
                    </button>
                </div>
            )}

            {/* Duplicate Removal Toggle */}
            {status === 'idle' && (
                <div style={{ marginBottom: '2rem', padding: '1.5rem', background: 'var(--surface-alt)', borderRadius: '8px', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
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
            )}

            {/* Category Editor */}
            {status === 'idle' && (
                <div className="glass-panel" style={{ marginBottom: '2rem', padding: '1.5rem', background: 'var(--surface-alt)' }}>
                    <h3 style={{ margin: '0 0 1rem 0', color: 'var(--text-primary)', fontSize: '1.1rem' }}>Customize Categories</h3>

                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
                        <input
                            type="text"
                            placeholder="Add generic category..."
                            value={newCategory}
                            onChange={(e) => setNewCategory(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && newCategory.trim()) {
                                    setCategories([...categories, newCategory.trim()]);
                                    setNewCategory('');
                                }
                            }}
                            style={{
                                flex: 1,
                                padding: '0.5rem',
                                borderRadius: '6px',
                                border: '1px solid var(--border)',
                                background: 'var(--surface-solid)',
                                color: 'var(--text-primary)',
                                outline: 'none'
                            }}
                        />
                        <button
                            onClick={() => {
                                if (newCategory.trim()) {
                                    setCategories([...categories, newCategory.trim()]);
                                    setNewCategory('');
                                }
                            }}
                            className="btn-secondary"
                            style={{
                                padding: '0.5rem 1rem',
                                borderRadius: '6px',
                                border: '1px solid var(--border)',
                                background: 'var(--accent)',
                                color: 'var(--on-accent)',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center'
                            }}
                        >
                            <Plus size={16} />
                        </button>
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                        {categories.map((cat, idx) => (
                            <div key={idx} style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem',
                                background: 'var(--surface-solid)',
                                border: '1px solid var(--border)',
                                padding: '0.25rem 0.75rem',
                                borderRadius: '20px',
                                fontSize: '0.9rem',
                                color: 'var(--text-secondary)'
                            }}>
                                {cat}
                                <X
                                    size={14}
                                    style={{ cursor: 'pointer', color: 'var(--error)' }}
                                    onClick={() => setCategories(categories.filter((_, i) => i !== idx))}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* File Upload Area */}
            {status === 'idle' && (
                <div
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    style={{
                        border: '2px dashed var(--border)',
                        borderRadius: '12px',
                        padding: '1.5rem',
                        marginBottom: '2rem',
                        textAlign: 'center',
                        background: uploadedFile ? 'var(--success-soft)' : 'transparent',
                        borderColor: uploadedFile ? 'var(--success)' : 'var(--border)',
                        cursor: 'pointer',
                        transition: 'all 0.2s'
                    }}
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
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '1rem',
                    padding: '0.75rem 1rem',
                    marginBottom: '2rem',
                    background: 'var(--surface-alt)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    boxSizing: 'border-box'
                }}>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        Last run: {lastOrganized.count.toLocaleString()} bookmarks organized
                        {lastOrganized.stats?.duplicatesRemoved > 0 && ` · ${lastOrganized.stats.duplicatesRemoved} dupes`}
                        {lastOrganized.stats?.deadLinksArchived > 0 && ` · ${lastOrganized.stats.deadLinksArchived} archived`}
                        <span style={{ color: 'var(--text-muted)' }}> · {new Date(lastOrganized.savedAt).toLocaleString()}</span>
                    </div>
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
            )}

            {/* Controls */}
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '2rem' }}>
                {status === 'complete' ? (
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ marginBottom: '0.75rem', color: 'var(--success)', fontSize: '1.2rem', fontWeight: 'bold' }}>
                            {uploadedFile ? "File Processed! Check your downloads." : 'All Done! Check your "AI Organized Bookmarks" folder.'}
                        </div>
                        {lastOrganized?.stats && (
                            <div style={{
                                display: 'inline-flex',
                                flexWrap: 'wrap',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '0.6rem',
                                padding: '0.4rem 0.9rem',
                                marginBottom: '1.25rem',
                                borderRadius: '20px',
                                background: 'var(--surface-alt)',
                                border: '1px solid var(--border)',
                                fontSize: '0.85rem',
                                color: 'var(--text-secondary)'
                            }}>
                                <span><strong>{lastOrganized.stats.total.toLocaleString()}</strong> organized</span>
                                <span>•</span>
                                <span><strong>{lastOrganized.stats.duplicatesRemoved}</strong> duplicates</span>
                                {lastOrganized.stats.deadLinksArchived > 0 && (
                                    <>
                                        <span>•</span>
                                        <span><strong>{lastOrganized.stats.deadLinksArchived}</strong> dead archived</span>
                                    </>
                                )}
                                <span>•</span>
                                <span><strong>{lastOrganized.stats.categoriesCount}</strong> categories</span>
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
                                    Download Organized Bookmarks
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
                            Organize Again
                        </div>
                    </div>
                ) : (
                    <button
                        className="btn-primary"
                        onClick={startProcess}
                        disabled={!apiKey || status === 'processing'}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            opacity: (!apiKey || status === 'processing') ? 0.5 : 1,
                            cursor: (!apiKey || status === 'processing') ? 'not-allowed' : 'pointer'
                        }}
                    >
                        {status === 'processing' ? (
                            <>Processing... {progress}%</>
                        ) : (
                            <>
                                {uploadedFile ? <FileText size={20} /> : <Bookmark size={20} />}
                                {uploadedFile ? 'Organize File & Download' : 'Organize My Bookmarks'}
                            </>
                        )}
                    </button>
                )}
            </div>

            {/* Error Message */}
            {errorMsg && (
                <div style={{ background: 'var(--error-soft)', border: '1px solid var(--error)', color: 'var(--error)', padding: '1rem', borderRadius: '8px', marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <AlertCircle size={20} />
                    {errorMsg}
                </div>
            )}

            {/* Logs / Terminal */}
            <div
                className="glass-panel"
                style={{
                    background: 'var(--terminal-bg)',
                    border: '1px solid var(--border)',
                    height: '300px',
                    overflowY: 'auto',
                    padding: '1rem',
                    fontFamily: 'monospace',
                    fontSize: '0.9rem',
                    color: 'var(--terminal-text)'
                }}
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
