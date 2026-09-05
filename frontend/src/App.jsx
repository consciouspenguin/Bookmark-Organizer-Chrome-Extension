import Organizer from './components/Organizer'
import ThemeToggle from './components/ThemeToggle'
import { useTheme } from './hooks/useTheme'
import { X } from 'lucide-react'

function App() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="app-container">
      <header style={{ marginBottom: '1.5rem' }}>
        {/* Top bar: theme toggle + close, right-aligned */}
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: '0.5rem',
          marginBottom: '1rem'
        }}>
          <ThemeToggle theme={theme} setTheme={setTheme} />
          <button
            onClick={() => window.close()}
            title="Close Extension"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '36px',
              height: '36px',
              borderRadius: '10px',
              background: 'var(--surface-alt)',
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
              cursor: 'pointer'
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Title block */}
        <div style={{ textAlign: 'center' }}>
          <h1 style={{
            fontSize: 'clamp(1.75rem, 5vw, 2.5rem)',
            fontWeight: '800',
            background: 'var(--accent-gradient)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            margin: 0
          }}>
            AI Bookmark Organizer
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 'clamp(0.95rem, 2.5vw, 1.15rem)', marginTop: '0.4rem' }}>
            Transform your chaos into a curated library
          </p>
        </div>
      </header>

      <main>
        <Organizer />
      </main>
    </div>
  )
}

export default App
