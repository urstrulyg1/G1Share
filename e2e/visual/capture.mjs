import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
    '.local-device-card': { x: 54, y: 697, width: 209, height: 250, tolerance: 3 }
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
  const screenshotBuffer = await page.screenshot({ path: resolve(out, 'opendesk-after.png'), fullPage: false })
  await page.screenshot({ path: resolve(out, 'opendesk-preview.jpg'), type: 'jpeg', quality: 72, fullPage: false })
  const previewBase64 = (await readFile(resolve(out, 'opendesk-preview.jpg'))).toString('base64')
  console.log('VISUAL_PREVIEW_BASE64_START')
  console.log(previewBase64)
  console.log('VISUAL_PREVIEW_BASE64_END')

  const referenceBase64 = (await readFile(resolve(here, 'reference-192.jpg'))).toString('base64')
  const pixelComparison = await page.evaluate(async (currentPngDataUrl, referenceDataUrl) => {
    const loadImage = (src) => new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error(`Image decode failed for ${src.slice(0, 32)} (source length ${src.length}).`))
      image.src = src
    })
    const [currentImage, referenceImage] = await Promise.all([
      loadImage(currentPngDataUrl),
      loadImage(referenceDataUrl)
    ])
      const width = 192
      const height = 128
      const currentCanvas = document.createElement('canvas')
      const referenceCanvas = document.createElement('canvas')
      const diffCanvas = document.createElement('canvas')
      for (const canvas of [currentCanvas, referenceCanvas, diffCanvas]) {
        canvas.width = width
        canvas.height = height
      }
      const currentContext = currentCanvas.getContext('2d', { willReadFrequently: true })
      const referenceContext = referenceCanvas.getContext('2d', { willReadFrequently: true })
      const diffContext = diffCanvas.getContext('2d', { willReadFrequently: true })
      if (!currentContext || !referenceContext || !diffContext) throw new Error('Canvas pixel comparison is unavailable.')
      currentContext.drawImage(currentImage, 0, 0, width, height)
      referenceContext.drawImage(referenceImage, 0, 0, width, height)
      const currentPixels = currentContext.getImageData(0, 0, width, height).data
      const referencePixels = referenceContext.getImageData(0, 0, width, height).data
      const diffPixels = diffContext.createImageData(width, height)
      let totalAbsoluteDifference = 0
      let changedPixels = 0
      for (let offset = 0; offset < currentPixels.length; offset += 4) {
        const red = Math.abs(currentPixels[offset] - referencePixels[offset])
        const green = Math.abs(currentPixels[offset + 1] - referencePixels[offset + 1])
        const blue = Math.abs(currentPixels[offset + 2] - referencePixels[offset + 2])
        const difference = (red + green + blue) / 3
        totalAbsoluteDifference += red + green + blue
        if (difference > 32) changedPixels++
        diffPixels.data[offset] = Math.min(255, difference * 3)
        diffPixels.data[offset + 1] = Math.max(0, 80 - difference * 2)
        diffPixels.data[offset + 2] = Math.max(0, 80 - difference * 2)
        diffPixels.data[offset + 3] = 255
      }
      diffContext.putImageData(diffPixels, 0, 0)
      return {
        comparisonResolution: { width, height },
        meanAbsoluteError: Number((totalAbsoluteDifference / (width * height * 3)).toFixed(2)),
        pixelsAbove32Difference: changedPixels,
        totalPixels: width * height,
        changedPixelRatio: Number((changedPixels / (width * height)).toFixed(4)),
        diffPngDataUrl: diffCanvas.toDataURL('image/png')
      }
  }, 'data:image/png;base64,' + screenshotBuffer.toString('base64'), 'data:image/jpeg;base64,' + referenceBase64)
  const diffBase64 = pixelComparison.diffPngDataUrl.split(',')[1]
  await writeFile(resolve(out, 'pixel-diff-192.png'), Buffer.from(diffBase64, 'base64'))
  delete pixelComparison.diffPngDataUrl
  await writeFile(resolve(out, 'pixel-comparison.json'), JSON.stringify({
    method: 'Downsample current and supplied reference screenshots to 192×128, compare every RGB pixel, and report mean absolute channel error plus the fraction of pixels whose average channel difference exceeds 32.',
    ...pixelComparison
  }, null, 2) + '\n')
  await writeFile(resolve(out, 'layout-measurements.json'), JSON.stringify({
    viewport: { width: 1536, height: 1024 },
    note: 'Renderer screenshot uses a visual-only bridge. Fixture device IDs, sample recent-device rows, and simulated signaling are only for visual validation; they are not live devices or production data.',
    geometryComparison: { reference: referenceBounds, differences, passed: differences.length === 0 },
    pixelComparison,
    elements: result
  }, null, 2) + '\n')
  console.log(JSON.stringify({
    screenshot: 'artifacts/visual-validation/opendesk-after.png',
    geometryComparison: { passed: differences.length === 0, differences },
    pixelComparison,
    measurements: result
  }, null, 2))
  if (differences.length) process.exitCode = 1
} finally {
  if (browser) await browser.close()
  server.kill('SIGTERM')
}
