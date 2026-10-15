// Loopback latency benchmark for the remote-control pipeline.
//
// What is real: the Go signaling broker, both renderer services (RemoteSessionController, ViewerInputForwarder,
// FileTransferManager, VideoFrameProbe), the real host RemoteInputController, WebRTC media and data channels
// (DTLS-SRTP/SCTP) between two headless Chromium pages on this machine.
//
// What is substituted, and therefore NOT measured here: OS screen capture (a canvas whose frame rate follows the
// capture constraint), OS input injection (a recording backend), display scan-out, and physical input devices.
// Input-to-visible is therefore "viewer event -> host controller -> synthetic display -> encode -> loopback -> decode
// -> presented frame". It is a pipeline measurement, not photon-to-photon latency.
//
// Output: docs/performance/results/<BENCH_LABEL>.json plus a text table on stdout. Set BENCH_QUICK=1 for a short run.
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChromePath, launchBrowser, sleep, startHarnessServer, startSignaling, waitFor } from '../lib/rig.mjs'

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const chromePath = findChromePath()
if (!chromePath) throw new Error('Set CHROME_PATH to a Chrome or Chromium executable to run the latency benchmark.')
const goCommand = process.env.GO_BIN || 'go'
const label = process.env.BENCH_LABEL || 'run'
const quick = process.env.BENCH_QUICK === '1'
const signalingPort = Number(process.env.E2E_SIGNALING_PORT || 18788)
const vitePort = Number(process.env.E2E_VITE_PORT || 5180)
const sizes = quick
  ? { idleMs: 1000, moves: 60, taps: 12, tapPeriodMs: 150, fileMiB: 8 }
  : { idleMs: 3000, moves: 300, taps: 40, tapPeriodMs: 150, fileMiB: 48 }

// Produces the same statistics the product uses (src/shared/latency-stats.ts), loaded through Vite so the code is shared.
let stats = null

function summary(values) {
  return stats.summarize(values.filter(Number.isFinite))
}

function round(value) {
  return value === null || value === undefined || Number.isNaN(value) ? null : Math.round(value * 100) / 100
}

function roundSummary(value) {
  if (!value) return null
  return { count: value.count, p50: round(value.p50), p95: round(value.p95), p99: round(value.p99), max: round(value.max) }
}

function analyzePointer(viewer, host) {
  const dispatched = viewer.dispatches.filter(entry => entry.type === 'input:move')
  const sent = viewer.sends.filter(entry => entry.type === 'input:move')
  const injected = host.injects.filter(entry => entry.type === 'input:move')
  const coalesce = []
  const transit = []
  const endToEnd = []
  let index = 0
  for (const event of dispatched) {
    while (index < sent.length && sent[index].at < event.at) index += 1
    if (index >= sent.length) break
    coalesce.push(sent[index].at - event.at)
    if (injected[index]) {
      endToEnd.push(injected[index].at - event.at)
    }
  }
  for (let position = 0; position < Math.min(sent.length, injected.length); position += 1) transit.push(injected[position].at - sent[position].at)
  return {
    dispatched: dispatched.length,
    sent: sent.length,
    injected: injected.length,
    // Dispatched moves that never reached a later send (not counted as successes; reported so they stay visible).
    unsent: dispatched.length - coalesce.length,
    coalesceMs: roundSummary(summary(coalesce)),
    viewerToHostMs: roundSummary(summary(transit)),
    dispatchToHostMs: roundSummary(summary(endToEnd))
  }
}

function analyzeKeys(viewer, host) {
  const dispatched = viewer.dispatches.filter(entry => entry.type === 'input:key')
  const sent = viewer.sends.filter(entry => entry.type === 'input:key' && entry.down === true)
  const injected = host.injects.filter(entry => entry.type === 'input:key' && entry.down === true)
  const transit = []
  const visible = []
  let missed = 0
  let markerIndex = 0
  const markers = viewer.markers
  for (let position = 0; position < dispatched.length; position += 1) {
    const event = dispatched[position]
    const send = sent[position]
    const inject = injected[position]
    if (!send || !inject) {
      missed += 1
      continue
    }
    transit.push(inject.at - send.at)
    while (markerIndex < markers.length && markers[markerIndex].at < event.at) markerIndex += 1
    let found = null
    for (let cursor = markerIndex; cursor < markers.length; cursor += 1) {
      if (markers[cursor].on === inject.marker) {
        found = markers[cursor]
        break
      }
      if (markers[cursor].at - event.at > 2000) break
    }
    if (found) visible.push(found.at - event.at)
    else missed += 1
  }
  return {
    keyDownsDispatched: dispatched.length,
    keyDownsInjected: injected.length,
    missed,
    viewerToHostMs: roundSummary(summary(transit)),
    inputToVisibleMs: roundSummary(summary(visible))
  }
}

function pick(object, keys) {
  const result = {}
  for (const key of keys) if (object && object[key] !== undefined) result[key] = typeof object[key] === 'number' ? round(object[key]) : object[key]
  return result
}

const workDir = await mkdtemp(join(tmpdir(), 'opendesk-bench-'))
let server = null
let vite = null
let browser = null
const scenarios = {}
let environment = {}

try {
  server = await startSignaling({ repoRoot, goCommand, port: signalingPort, workDir })
  vite = await startHarnessServer({ repoRoot, port: vitePort, signalingPort })
  stats = await vite.ssrLoadModule(join(repoRoot, 'src/shared/latency-stats.ts'))
  const origin = `http://127.0.0.1:${vitePort}`

  browser = await launchBrowser(chromePath)
  const host = await (await browser.createBrowserContext()).newPage()
  const viewer = await (await browser.createBrowserContext()).newPage()
  for (const page of [host, viewer]) {
    await page.goto(origin, { waitUntil: 'load' })
    await page.waitForFunction(() => document.title === 'harness-ready', { timeout: 30_000 })
  }
  const hostId = await host.evaluate(() => window.harness.start('Bench Host', true))
  await viewer.evaluate(() => window.harness.start('Bench Viewer', false))
  await viewer.evaluate(target => window.harness.requestSession(target, ['input', 'files']), hostId)
  await waitFor(host, state => state.role === 'host', 'host controller')
  await host.evaluate(() => window.harness.startShare())
  await waitFor(viewer, state => state.connection === 'connected' && state.video.width > 0, 'viewer video', 90_000)
  await host.evaluate(() => window.harness.enableRemoteControl())
  await waitFor(viewer, state => state.remoteControl === 'active', 'remote control active')
  await sleep(1500)

  environment = {
    label,
    recordedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim(),
    workingTreeChanged: execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot }).toString().trim().length > 0,
    node: process.version,
    chrome: await browser.version(),
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    quick,
    sizes,
    capture: 'canvas stream; frame rate follows the requested frameRate constraint (default 15 fps)',
    network: 'loopback (no shaping: tc netem/tbf are not available in this sandbox)'
  }

  async function scenario(name, action) {
    await host.evaluate(() => window.harness.benchReset())
    await viewer.evaluate(() => window.harness.benchReset())
    const extra = await action()
    await sleep(800)
    const viewerData = await viewer.evaluate(() => window.harness.benchViewerData())
    const hostData = await host.evaluate(() => window.harness.benchHostData())
    const metrics = viewerData.metrics
    const hostMetrics = hostData.metrics
    scenarios[name] = {
      pointer: analyzePointer(viewerData, hostData),
      keys: analyzeKeys(viewerData, hostData),
      presentation: {
        framesPresented: viewerData.presentation.framesPresented,
        presentedFps: round(viewerData.presentation.presentedFps),
        captureToScreenMs: roundSummary(viewerData.presentation.captureAgeMs),
        frameIntervalMs: roundSummary(viewerData.presentation.frameIntervalMs),
        droppedFrames: viewerData.presentation.droppedFrames
      },
      viewerMetrics: pick(metrics, ['framesPerSecond', 'width', 'height', 'bitrateKbps', 'availableBitrateKbps', 'roundTripTimeMs', 'packetLossPercent', 'jitterBufferMs', 'decodeMs', 'droppedFrames', 'transport']),
      hostMetrics: pick(hostMetrics, ['encodeMs', 'bitrateKbps', 'availableBitrateKbps', 'qualityLimitation', 'framesPerSecond', 'transport']),
      transfer: extra ?? null
    }
    const errorsSeen = [...(await host.evaluate(() => window.harness.snapshot())).errors, ...(await viewer.evaluate(() => window.harness.snapshot())).errors]
    if (errorsSeen.length > 0) scenarios[name].errors = errorsSeen.slice(-5)
    console.log(`done ${name}${errorsSeen.length ? ` (errors: ${errorsSeen.slice(-3).join(' | ')})` : ''}`)
  }

  await scenario('idle-video', async () => { await sleep(sizes.idleMs) })

  await scenario('pointer-sweep', async () => {
    await viewer.evaluate(frames => window.harness.benchPointerSweep(frames), sizes.moves)
  })

  await scenario('key-taps', async () => {
    await viewer.evaluate((count, period) => window.harness.benchKeyTaps(count, period), sizes.taps, sizes.tapPeriodMs)
  })

  await scenario('key-taps-cpu-load', async () => {
    await host.evaluate(() => window.harness.startCpuLoad(1))
    await viewer.evaluate(() => window.harness.startCpuLoad(1))
    try {
      await viewer.evaluate((count, period) => window.harness.benchKeyTaps(count, period), sizes.taps, sizes.tapPeriodMs)
    } finally {
      await host.evaluate(() => window.harness.stopCpuLoad())
      await viewer.evaluate(() => window.harness.stopCpuLoad())
    }
  })

  await scenario('key-taps-during-file-transfer', async () => {
    const bytes = sizes.fileMiB * 1024 * 1024
    const [transfer] = await Promise.all([
      viewer.evaluate(size => window.harness.benchSendFile(size), bytes),
      viewer.evaluate((count, period) => window.harness.benchKeyTaps(count, period), sizes.taps, sizes.tapPeriodMs)
    ])
    return { mebibytes: sizes.fileMiB, seconds: round(transfer.seconds), mebibytesPerSecond: round(sizes.fileMiB / transfer.seconds) }
  })

  const hostCumulative = (await host.evaluate(() => window.harness.benchHostData())).dispatchTiming
  // Sender profile notices seen by the viewer (candidate builds only; null where the harness has no such hook).
  const senderQualityNotices = await viewer.evaluate(() => typeof window.harness.qualityNotices === 'function' ? window.harness.qualityNotices() : null)
  const report = {
    environment,
    hostControllerDispatchMicros: roundSummary(hostCumulative),
    senderQualityNotices,
    scenarios
  }
  await mkdir(join(repoRoot, 'docs/performance/results'), { recursive: true })
  await writeFile(join(repoRoot, 'docs/performance/results', `${label}.json`), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser?.close().catch(() => undefined)
  await vite?.close().catch(() => undefined)
  server?.kill('SIGTERM')
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
}
