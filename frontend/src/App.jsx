import Organizer from './components/Organizer'
import ThemeToggle from './components/ThemeToggle'
import { useTheme } from './hooks/useTheme'
import { X } from 'lucide-react'

function App() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="app-container">
      <header className="app-header">
        {/* Top bar: theme toggle + close, right-aligned */}
        <div className="header-top">
          <ThemeToggle theme={theme} setTheme={setTheme} />
          <button
            onClick={() => window.close()}
            title="Close Extension"
            className="header-close-btn"
          >
            <X size={18} />
          </button>
        </div>

        {/* Title block */}
        <div className="header-title-block">
          <h1 className="header-title">
            AI Bookmark Organizer
          </h1>
          <p className="header-subtitle">
            Transform your chaos into a curated library
          </p>
        </div>
      </header>

      <main className="app-main">
        <Organizer />
      </main>
    </div>
  )
}

export default App
