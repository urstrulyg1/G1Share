// Shared setup for the two-client end-to-end test and the latency benchmark: the real Go signaling broker,
// the Vite-served harness page, and a headless Chromium. Both scripts use these helpers so that they run
// the same startup path and the same timeouts.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

export const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}: ${output.slice(-2000)}`)))
  })
}

export async function waitForHTTP(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* not listening yet */ }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${url}`)
}

/** Polls the harness snapshot in `page` until `predicate` holds, or throws with the last snapshot. */
export async function waitFor(page, predicate, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await page.evaluate(() => window.harness.snapshot())
    if (predicate(last)) return last
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${description}; last snapshot: ${JSON.stringify(last)}`)
}

/** Builds the signaling broker from services/signaling and starts it on 127.0.0.1:`port`. */
export async function startSignaling({ repoRoot, goCommand, port, workDir, verbose = false }) {
  const serverBinary = join(workDir, 'opendesk-signaling')
  await run(goCommand, ['build', '-o', serverBinary, '.'], { cwd: join(repoRoot, 'services/signaling'), env: process.env })
  const server = spawn(serverBinary, [], {
    env: { ...process.env, OPENDESK_SIGNALING_ADDR: `127.0.0.1:${port}`, OPENDESK_DATA_DIR: join(workDir, 'data') },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (verbose) server.stderr.on('data', chunk => process.stderr.write(chunk))
  await waitForHTTP(`http://127.0.0.1:${port}/healthz`)
  return server
}

/** Serves e2e/harness on 127.0.0.1:`port`, proxying /api to the broker. */
export async function startHarnessServer({ repoRoot, port, signalingPort }) {
  const vite = await createServer({
    root: join(repoRoot, 'e2e/harness'),
    configFile: false,
    logLevel: 'warn',
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      fs: { allow: [repoRoot] },
      proxy: { '/api': { target: `http://127.0.0.1:${signalingPort}`, changeOrigin: false } }
    },
    resolve: { alias: [{ find: /^node:module$/, replacement: join(repoRoot, 'e2e/harness/node-module-stub.ts') }] }
  })
  await vite.listen()
  return vite
}

export function launchBrowser(chromePath) {
  return puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns'],
    env: process.env
  })
}
