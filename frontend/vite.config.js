import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
