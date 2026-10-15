import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const out = resolve(root, 'artifacts/visual-validation')
const port = 5188
const chromePath = process.env.CHROME_PATH
if (!chromePath) throw new Error('CHROME_PATH must point to Chromium/Chrome.')
await mkdir(out, { recursive: true })
const server = spawn(process.execPath, [
  resolve(root, 'node_modules/vite/bin/vite.js'),
  '--config', resolve(here, 'vite.config.ts'),
  '--host', '127.0.0.1',
  '--port', String(port),
  '--strictPort'
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', chunk => { serverLog += chunk.toString() })
server.stderr.on('data', chunk => { serverLog += chunk.toString() })
let browser
try {
  let ready = false
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/e2e/visual/index.html`)
      if (response.ok) { ready = true; break }
    } catch {}
    if (server.exitCode !== null) break
    await delay(250)
  }
  if (!ready) throw new Error(`Visual Vite server failed to start.\n${serverLog}`)
  const require = createRequire(import.meta.url)
  const puppeteer = require('puppeteer-core')
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1536, height: 1024, deviceScaleFactor: 1 })
  page.on('pageerror', error => console.error('[visual page error]', error.message))
  await page.goto(`http://127.0.0.1:${port}/e2e/visual/index.html`, { waitUntil: 'networkidle0', timeout: 60000 })
  await page.waitForSelector('.application-window', { timeout: 30000 })
  await page.waitForSelector('.dashboard-hero', { timeout: 30000 })
  await delay(1200)
  const result = await page.evaluate(() => {
    const selectors = [
      '.application-window', '.window-header', '.sidebar', '.workspace-main',
      '.dashboard-hero', '.access-panel', '.connect-panel', '.recent-devices-panel',
      '.network-panel', '.dashboard-benefits', '.local-device-card'
    ]
    return Object.fromEntries(selectors.map(selector => {
      const el = document.querySelector(selector)
      if (!el) return [selector, null]
      const r = el.getBoundingClientRect()
      const css = getComputedStyle(el)
      return [selector, {
        x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
        display: css.display, overflow: css.overflow
      }]
    }))
  })
  const referenceBounds = {
    '.application-window': { x: 40, y: 62, width: 1456, height: 900, tolerance: 2 },
    '.window-header': { x: 41, y: 63, width: 1454, height: 72, tolerance: 2 },
    '.sidebar': { x: 41, y: 135, width: 250, height: 826, tolerance: 2 },
    '.dashboard-hero': { x: 291, y: 135, width: 868, height: 298, tolerance: 3 },
    '.access-panel': { x: 291, y: 448, width: 427, height: 310, tolerance: 4 },
    '.connect-panel': { x: 732, y: 448, width: 427, height: 310, tolerance: 4 },
    '.recent-devices-panel': { x: 1170, y: 135, width: 314, height: 428, tolerance: 3 },
    '.network-panel': { x: 1170, y: 577, width: 314, height: 182, tolerance: 3 },
    '.dashboard-benefits': { x: 291, y: 773, width: 1193, height: 168, tolerance: 3 },
    '.local-device-card': { x: 54, y: 698, width: 223, height: 250, tolerance: 3 }
  }
  const differences = []
  for (const [selector, expected] of Object.entries(referenceBounds)) {
    const actual = result[selector]
    if (!actual) {
      differences.push({ selector, issue: 'element missing' })
      continue
    }
    for (const key of ['x', 'y', 'width', 'height']) {
      const delta = Math.abs(actual[key] - expected[key])
      if (delta > expected.tolerance) differences.push({
        selector, property: key, expected: expected[key], actual: actual[key], delta, tolerance: expected.tolerance
      })
    }
  }
  await page.screenshot({ path: resolve(out, 'opendesk-after.png'), fullPage: false })
  await writeFile(resolve(out, 'layout-measurements.json'), JSON.stringify({
    viewport: { width: 1536, height: 1024 },
    note: 'Renderer screenshot uses a visual-only bridge. Device identity, signaling, sessions, and native capabilities are intentionally unavailable; sample rows are not live devices.',
    comparison: { reference: referenceBounds, differences, passed: differences.length === 0 },
    elements: result
  }, null, 2) + '\n')
  console.log(JSON.stringify({ screenshot: 'artifacts/visual-validation/opendesk-after.png', comparison: { passed: differences.length === 0, differences }, measurements: result }, null, 2))
  if (differences.length) process.exitCode = 1
} finally {
  if (browser) await browser.close()
  server.kill('SIGTERM')
}
