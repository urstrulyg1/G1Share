// Two-client end-to-end test. Runs the real Go signaling broker and two isolated headless Chromium
// pages that execute the renderer services (see e2e/harness). Requires CHROME_PATH and a Go toolchain.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChromePath, launchBrowser, startHarnessServer, startSignaling, waitFor } from './lib/rig.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const chromePath = findChromePath()
if (!chromePath) throw new Error('Set CHROME_PATH to a Chrome or Chromium executable to run the two-client end-to-end test.')
const goCommand = process.env.GO_BIN || 'go'
const signalingPort = Number(process.env.E2E_SIGNALING_PORT || 18787)
const vitePort = Number(process.env.E2E_VITE_PORT || 5179)
const externalSignalingUrl = process.env.G1VIEWER_WAN_SIGNALING_URL?.trim() || ''
const iceTransportPolicy = process.env.E2E_ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all'
if (externalSignalingUrl) {
  const parsed = new URL(externalSignalingUrl)
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error('G1VIEWER_WAN_SIGNALING_URL must use HTTPS unless it points to localhost.')
  }
}
const results = []

function check(name, passed, detail = '') {
  results.push({ name, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const workDir = await mkdtemp(join(tmpdir(), 'opendesk-e2e-'))
let server = null
let vite = null
let browser = null

try {
  if (!externalSignalingUrl) {
    server = await startSignaling({ repoRoot, goCommand, port: signalingPort, workDir, verbose: Boolean(process.env.E2E_VERBOSE) })
    check('local signaling broker starts and reports healthy', true, `127.0.0.1:${signalingPort}`)
  } else {
    check('using deployed signaling service for WAN smoke test', true, new URL(externalSignalingUrl).origin)
  }

  vite = await startHarnessServer({ repoRoot, port: vitePort, signalingPort, signalingUrl: externalSignalingUrl || undefined })
  const origin = `http://127.0.0.1:${vitePort}/?iceTransportPolicy=${iceTransportPolicy}`

  browser = await launchBrowser(chromePath)
  const hostContext = await browser.createBrowserContext()
  const viewerContext = await browser.createBrowserContext()
  const host = await hostContext.newPage()
  const viewer = await viewerContext.newPage()
  host.on('pageerror', error => console.error('[host page error]', error.message))
  viewer.on('pageerror', error => console.error('[viewer page error]', error.message))
  for (const page of [host, viewer]) {
    await page.goto(origin, { waitUntil: 'load' })
    await page.waitForFunction(() => document.title === 'harness-ready', { timeout: 30_000 })
  }

  const hostId = await host.evaluate(() => window.harness.start('E2E Host', true))
  const viewerId = await viewer.evaluate(() => window.harness.start('E2E Viewer', false))
  check('both devices register with the real broker', /^[A-F0-9]{8}(-[A-F0-9]{8}){3}$/.test(hostId) && hostId !== viewerId, `${hostId} / ${viewerId}`)

  await viewer.evaluate(target => window.harness.requestSession(target, ['input', 'files']), hostId)
  await waitFor(host, state => state.role === 'host', 'host controller to be created from the session request')
  await host.evaluate(() => window.harness.startShare())
  const connected = await waitFor(viewer, state => state.connection === 'connected' && state.video.width > 0, 'viewer to receive video', 90_000)
  check('viewer receives a live screen stream over WebRTC', connected.video.width > 0, `${connected.video.width}x${connected.video.height}`)

  await waitFor(host, state => state.dataChannelReady, 'host secure data channel to open')
  await waitFor(viewer, state => state.dataChannelReady, 'viewer secure data channel to open')
  check('secure data channel opens on both peers', true)

  const hostTransport = await host.evaluate(() => window.harness.transportSnapshot())
  const viewerTransport = await viewer.evaluate(() => window.harness.transportSnapshot())
  const hasSelectedPair = values => values.some(value => value.pairState === 'succeeded' && value.connectionState === 'connected')
  check('both peers report a selected, successful ICE candidate pair', hasSelectedPair(hostTransport) && hasSelectedPair(viewerTransport), JSON.stringify({ host: hostTransport, viewer: viewerTransport }))
  if (iceTransportPolicy === 'relay') {
    const relayOnly = values => values.length > 0 && values.every(value => value.localCandidateType === 'relay' && value.remoteCandidateType === 'relay')
    check('relay-only mode selected TURN relay candidates on both peers', relayOnly(hostTransport) && relayOnly(viewerTransport), JSON.stringify({ host: hostTransport, viewer: viewerTransport }))
  }

  const transferResult = await viewer.evaluate(() => window.harness.benchSendFile(256 * 1024))
  const receivedTransfer = await waitFor(host, state => state.transfers.some(record => record.direction === 'receiving' && record.name === 'benchmark.bin' && record.size === 256 * 1024 && record.status === 'complete'), 'host to verify a 256 KiB peer-to-peer data-channel file transfer', 30_000)
  check('data channel transfers and verifies a file end to end', transferResult.bytes === 256 * 1024 && transferResult.seconds > 0 && receivedTransfer.transfers.some(record => record.direction === 'receiving' && record.name === 'benchmark.bin' && record.size === 256 * 1024 && record.status === 'complete'), `${transferResult.bytes} bytes in ${transferResult.seconds.toFixed(3)}s`)

  const hostStateOffset = (await host.evaluate(() => window.harness.snapshot())).connectionStates.length
  const viewerStateOffset = (await viewer.evaluate(() => window.harness.snapshot())).connectionStates.length
  await host.evaluate(() => window.harness.simulateIceDisconnect())
  let recoveredHost
  try {
    recoveredHost = await waitFor(host, state => state.connection === 'connected' && state.connectionStates.slice(hostStateOffset).includes('reconnecting'), 'host to recover through the ICE restart path', 35_000)
  } catch (error) {
    const diagnostics = {
      host: await host.evaluate(() => window.harness.snapshot()),
      viewer: await viewer.evaluate(() => window.harness.snapshot()),
      hostTransport: await host.evaluate(() => window.harness.transportSnapshot()),
      viewerTransport: await viewer.evaluate(() => window.harness.transportSnapshot())
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}; recovery diagnostics: ${JSON.stringify(diagnostics)}`)
  }
  const recoveredViewer = await waitFor(viewer, state => state.connection === 'connected' && state.video.width > 0 && state.connectionStates.slice(viewerStateOffset).includes('negotiating'), 'viewer to renegotiate and resume video after ICE restart', 35_000)
  check('host ICE disconnect recovery returns to connected', recoveredHost.connection === 'connected', recoveredHost.connectionStates.slice(hostStateOffset).join(' -> '))
  check('viewer renegotiates and continues receiving video after ICE restart', recoveredViewer.connection === 'connected' && recoveredViewer.video.width > 0, `${recoveredViewer.video.width}x${recoveredViewer.video.height}; ${recoveredViewer.connectionStates.slice(viewerStateOffset).join(' -> ')}`)

  const pending = await viewer.evaluate(() => window.harness.snapshot())
  check('input permission starts as pending until the host enables control', pending.remoteControl === 'pending', pending.remoteControl)

  // Input before the host enables control must not reach the host.
  await viewer.evaluate(() => window.harness.viewerKey('keydown', 'KeyX'))
  await viewer.evaluate(() => window.harness.viewerKey('keyup', 'KeyX'))
  await new Promise(resolve => setTimeout(resolve, 300))
  const beforeEnable = await host.evaluate(() => window.harness.snapshot())
  check('host ignores input while remote control is not enabled', beforeEnable.nativeLog.length === 0 && !beforeEnable.remoteInputActive, JSON.stringify(beforeEnable.nativeLog))

  await host.evaluate(() => window.harness.enableRemoteControl())
  await waitFor(viewer, state => state.remoteControl === 'active', 'viewer to observe remote control becoming active')
  check('host enables remote control and the viewer is notified', true)

  await viewer.evaluate(() => window.harness.viewerPointer('pointermove', 0.25, 0.5))
  await waitFor(host, state => state.nativeLog.some(entry => entry[0] === 'move'), 'pointer move on the host')
  const moved = await host.evaluate(() => window.harness.snapshot())
  const move = moved.nativeLog.find(entry => entry[0] === 'move')
  check('pointer position is mapped to the shared display', move && move[1] === 200 && move[2] === 225, JSON.stringify(move))

  await host.evaluate(() => window.harness.clearNativeLog())
  await viewer.evaluate(() => window.harness.viewerKey('keydown', 'KeyA'))
  await viewer.evaluate(() => window.harness.viewerKey('keyup', 'KeyA'))
  await waitFor(host, state => state.nativeLog.length >= 2, 'key press on the host')
  const keyLog = (await host.evaluate(() => window.harness.snapshot())).nativeLog
  check('key press is delivered as down then up', JSON.stringify(keyLog.slice(0, 2)) === JSON.stringify([['key', 'a', true], ['key', 'a', false]]), JSON.stringify(keyLog))

  await viewer.evaluate(() => window.harness.viewerPointer('pointerdown', 0.5, 0.5, 0))
  await viewer.evaluate(() => window.harness.viewerPointer('pointerup', 0.5, 0.5, 0))
  await waitFor(host, state => state.nativeLog.some(entry => entry[0] === 'mouse' && entry[2] === false), 'mouse button release on the host')
  const buttonLog = (await host.evaluate(() => window.harness.snapshot())).nativeLog.filter(entry => entry[0] === 'mouse')
  check('left click is delivered as press then release', JSON.stringify(buttonLog) === JSON.stringify([['mouse', 'left', true], ['mouse', 'left', false]]), JSON.stringify(buttonLog))

  // Host revokes: keys held on the viewer must be released on the host and further input must stop.
  await viewer.evaluate(() => window.harness.viewerKey('keydown', 'ShiftLeft'))
  await viewer.evaluate(() => window.harness.viewerKey('keydown', 'KeyB'))
  await waitFor(host, state => state.heldKeys === 2, 'two keys held on the host')
  await host.evaluate(() => window.harness.revokeRemoteControl())
  const revoked = await waitFor(host, state => !state.remoteInputActive && state.heldKeys === 0, 'host to release held keys on revoke')
  const releases = revoked.nativeLog.filter(entry => entry[0] === 'key' && entry[2] === false).map(entry => entry[1])
  check('revoking control releases every held key on the host', releases.includes('shift') && releases.includes('b'), JSON.stringify(releases))
  await waitFor(viewer, state => state.remoteControl === 'revoked', 'viewer to observe the revocation')
  check('viewer observes the revocation', true)

  await host.evaluate(() => window.harness.clearNativeLog())
  await viewer.evaluate(() => window.harness.viewerKey('keydown', 'KeyC'))
  await viewer.evaluate(() => window.harness.viewerKey('keyup', 'KeyC'))
  await new Promise(resolve => setTimeout(resolve, 300))
  const afterRevoke = (await host.evaluate(() => window.harness.snapshot())).nativeLog
  check('input after revocation is not delivered', afterRevoke.length === 0, JSON.stringify(afterRevoke))

  // Re-enable, hold a key on the viewer, then disconnect: the host must release it.
  await host.evaluate(() => window.harness.enableRemoteControl())
  await waitFor(viewer, state => state.remoteControl === 'active', 'viewer to observe re-enabled control')
  await viewer.evaluate(() => window.harness.viewerKey('keydown', 'KeyZ'))
  await waitFor(host, state => state.heldKeys === 1, 'key held on the host before disconnect')
  await host.evaluate(() => window.harness.clearNativeLog())
  await viewer.evaluate(() => window.harness.closeLocal())
  const closed = await waitFor(host, state => state.role === null && state.heldKeys === 0 && !state.remoteInputActive, 'host to tear down after the session closes')
  const released = closed.nativeLog.some(entry => entry[0] === 'key' && entry[1] === 'z' && entry[2] === false)
  check('disconnecting releases keys still held on the host', released, JSON.stringify(closed.nativeLog))

  // A session approved for viewing only must never accept remote control, even when the viewer sends input.
  await viewer.evaluate(target => window.harness.requestSession(target, []), hostId)
  await waitFor(host, state => state.role === 'host', 'host controller for the view-only session')
  await host.evaluate(() => window.harness.startShare())
  await waitFor(viewer, state => state.connection === 'connected' && state.video.width > 0, 'viewer video in the view-only session', 90_000)
  const refusal = await host.evaluate(() => window.harness.enableRemoteControl())
  check('host refuses remote control when only viewing was approved', refusal.startsWith('refused:') && refusal.includes('not approved'), refusal)
  await host.evaluate(() => window.harness.clearNativeLog())
  await viewer.evaluate(() => window.harness.viewerKey('keydown', 'KeyV'))
  await viewer.evaluate(() => window.harness.viewerKey('keyup', 'KeyV'))
  await new Promise(resolve => setTimeout(resolve, 300))
  const viewOnlyLog = (await host.evaluate(() => window.harness.snapshot())).nativeLog
  check('view-only session delivers no input to the host', viewOnlyLog.length === 0, JSON.stringify(viewOnlyLog))
  const filePermissionResult = await viewer.evaluate(async () => {
    try { await window.harness.benchSendFile(1024); return 'unexpected-success' }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  })
  check('view-only session cannot initiate file transfer without permission', filePermissionResult.includes('File transfer permission was not approved'), filePermissionResult)
  await viewer.evaluate(() => window.harness.closeLocal())
  await waitFor(host, state => state.role === null, 'host to close the view-only session')

  if (process.env.E2E_VERBOSE) {
    console.log('host errors', JSON.stringify((await host.evaluate(() => window.harness.snapshot())).errors))
    console.log('viewer errors', JSON.stringify((await viewer.evaluate(() => window.harness.snapshot())).errors))
  }
  const errorsSeen = [
    ...(await host.evaluate(() => window.harness.snapshot())).errors,
    ...(await viewer.evaluate(() => window.harness.snapshot())).errors
  ].filter(message => !/rate limit/i.test(message))
  check('no unexpected runtime errors were reported by the renderer services', errorsSeen.length === 0, errorsSeen.join(' | '))
} catch (error) {
  check('two-client scenario completed', false, error instanceof Error ? error.message : String(error))
} finally {
  await browser?.close().catch(() => undefined)
  await vite?.close().catch(() => undefined)
  server?.kill('SIGTERM')
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
}

const failed = results.filter(result => !result.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
