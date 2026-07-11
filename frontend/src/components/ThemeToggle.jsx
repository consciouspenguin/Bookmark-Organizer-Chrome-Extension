import { createElement } from 'react'
import { Sun, Moon, Monitor } from 'lucide-react'

const options = [
    { id: 'light', icon: Sun, label: 'Light' },
    { id: 'dark', icon: Moon, label: 'Dark' },
    { id: 'system', icon: Monitor, label: 'System' },
]

/**
 * Minimalist segmented control for theme selection.
 * Light / Dark / System — driven by the useTheme hook.
 */
export default function ThemeToggle({ theme, setTheme }) {
    return (
        <div
            role="radiogroup"
            aria-label="Theme"
            style={{
                display: 'inline-flex',
                gap: '2px',
                padding: '3px',
                borderRadius: '10px',
                background: 'var(--surface-alt)',
                border: '1px solid var(--border)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
            }}
        >
            {options.map(({ id, icon, label }) => {
                const active = theme === id
                return (
                    <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={label}
                        title={label}
                        onClick={() => setTheme(id)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: '30px',
                            height: '30px',
                            borderRadius: '7px',
                            border: 'none',
                            cursor: 'pointer',
                            background: active ? 'var(--accent)' : 'transparent',
                            color: active ? 'var(--on-accent)' : 'var(--text-muted)',
                            boxShadow: active ? '0 1px 6px var(--accent-glow)' : 'none',
                        }}
                    >
                        {createElement(icon, { size: 16 })}
                    </button>
                )
            })}
        </div>
    )
}
