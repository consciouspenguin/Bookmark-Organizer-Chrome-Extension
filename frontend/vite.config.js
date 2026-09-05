import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Side panel startup must depend on as few asset fetches as possible:
// inline the single stylesheet into index.html (MV3 CSP forbids inlining
// JS, so the script tag stays external).
const inlineStyles = () => ({
  name: 'inline-styles',
  enforce: 'post',
  closeBundle() {
    const dir = join(import.meta.dirname, 'dist')
    const htmlPath = join(dir, 'index.html')
    let html = readFileSync(htmlPath, 'utf8')
    const link = html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+\.css)"[^>]*>/)
    if (link) {
      const cssFile = link[1].replace(/^[./]+/, '')
      const css = readFileSync(join(dir, cssFile), 'utf8')
      html = html.replace(link[0], `<style>${css}</style>`)
      rmSync(join(dir, cssFile))
      writeFileSync(htmlPath, html)
    }
  }
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), inlineStyles()],
  base: './', // CRITICAL for extensions
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: { polyfill: false }
  },
  test: {
    environment: 'jsdom'
  }
})
