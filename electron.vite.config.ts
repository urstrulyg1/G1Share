import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const rootDir = dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: { index: resolve(rootDir, 'src/main/index.ts') } } } },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: { index: resolve(rootDir, 'src/preload/index.ts') } } } },
  renderer: { resolve: { alias: { '@renderer': resolve(rootDir, 'src/renderer/src') } }, plugins: [react()] }
})
