import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const rootDir = dirname(fileURLToPath(import.meta.url))

/**
 * The production CSP in index.html is strict. Vite's dev server injects inline React refresh code,
 * inline CSS, and a WebSocket for HMR, so the dev server alone relaxes exactly those directives.
 */
function devContentSecurityPolicy(): Plugin {
  return {
    name: 'opendesk-dev-content-security-policy',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/content="([^"]*)"/, (_match, policy: string) => {
        const relaxed = policy
          .replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
          .replace("style-src 'self';", "style-src 'self' 'unsafe-inline';")
          .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* ws://127.0.0.1:*")
        return `content="${relaxed}"`
      })
    }
  }
}

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: { index: resolve(rootDir, 'src/main/index.ts') } } } },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // Sandboxed renderers (sandbox: true) can load only CommonJS preload scripts.
      rollupOptions: {
        input: { index: resolve(rootDir, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: { resolve: { alias: { '@renderer': resolve(rootDir, 'src/renderer/src') } }, plugins: [react(), devContentSecurityPolicy()] }
})
