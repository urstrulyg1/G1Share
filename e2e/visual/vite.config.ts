import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const rootDir = resolve(fileURLToPath(new URL('../..', import.meta.url)))
export default defineConfig({
  root: rootDir,
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(rootDir, 'src/renderer/src')
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true
  }
})
