// Browser-side harness for the two-client end-to-end test. It runs the real renderer services
// (SignalingClient, RemoteSessionController, ViewerInputForwarder) and the real host-side
// RemoteInputController. Only the Electron-only pieces are substituted:
//   - the preload bridge is replaced by an in-page implementation that signs requests exactly like the main process;
//   - display capture is replaced by a canvas stream (no screen is available in CI);
//   - the native input library is replaced by a recording backend.
import { formatDeviceId } from '../../src/shared/device-id'
import type { DeviceInfo, DeviceSummary, OpenDeskBridge, PeerSignalVerification, RemoteSession, SessionDecisionRequest, SessionPermission, SignalingEvent, SignalingRequest } from '../../src/shared/types'
import type { RemoteInputMessage } from '../../src/shared/remote-input'
import { SignalingClient } from '../../src/renderer/src/services/signaling-client'
import { RemoteSessionController } from '../../src/renderer/src/services/remote-session'
import type { ConnectionState, RemoteControlState } from '../../src/renderer/src/services/remote-session'
import { ViewerInputForwarder } from '../../src/renderer/src/services/remote-input'
import { RemoteInputController } from '../../src/main/remote-input'
import type { NativeInputBackend } from '../../src/main/remote-input'
import { FileTransferManager } from '../../src/renderer/src/services/file-transfer'
import type { TransferRecord } from '../../src/renderer/src/services/file-transfer'
import { VideoFrameProbe } from '../../src/renderer/src/services/video-probe'
import type { ProbeSnapshot } from '../../src/renderer/src/services/video-probe'
import type { SessionMetrics } from '../../src/renderer/src/services/remote-session'
import { sha256 } from '@noble/hashes/sha256'

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const text = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index)
  return bytes
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

function peerSignalCanonical(sessionId: string, fromDeviceId: string, messageType: string, payload: unknown, digest: string): string {
  return `opendesk-peer-signal-v1\n${sessionId}\n${fromDeviceId}\n${messageType}\n${digest}`
}

async function peerDigest(payload: unknown): Promise<string> {
  const json = JSON.stringify(payload)
  if (json === undefined) throw new TypeError('Peer signal payload must be JSON serializable.')
  return sha256Hex(json)
}

interface Identity {
  deviceId: string
  publicKey: string
  privateKey: CryptoKey
}

let identity: Identity | null = null
let client: SignalingClient | null = null
let localDevice: DeviceInfo | null = null
let controller: RemoteSessionController | null = null
let controllerRole: 'host' | 'viewer' | null = null
let controllerSessionId: string | null = null
let cursor = 0
let pumping = false
let autoAccept = false
let remoteStream: MediaStream | null = null
let remoteState: ConnectionState = 'disconnected'
let remoteControlState: RemoteControlState = 'off'
let remoteControlReason = ''
let viewerForwarder: ViewerInputForwarder | null = null
const pendingSignals = new Map<string, SignalingEvent[]>()
const loadWorkers: Worker[] = []
const errors: string[] = []
const transferRecords: TransferRecord[] = []
let activePermissions: SessionPermission[] = []

// Native input path: the real RemoteInputController records every operation the OS would receive.
const nativeLog: Array<Array<string | number | boolean>> = []
// Benchmark marker: every key-down the host injects flips a patch of the synthetic display. The viewer
// samples that patch on each presented frame, which gives an input-to-visible time without reading the screen.
let markerOn = false
const nativeBackend: NativeInputBackend = {
  name: 'recording',
  moveMouse: (x, y) => nativeLog.push(['move', x, y]),
  toggleMouse: (button, down) => nativeLog.push(['mouse', button, down]),
  scroll: (x, y) => nativeLog.push(['scroll', x, y]),
  toggleKey: (key, down) => {
    nativeLog.push(['key', key, down])
    if (down) markerOn = !markerOn
  }
}
const hostDisplay = { bounds: { x: 0, y: 0, width: 800, height: 450 }, scaleFactor: 1 }
const remoteInput = new RemoteInputController(nativeBackend, 'win32')
let enabledSession: string | null = null

async function createIdentity(): Promise<Identity> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
  const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  const deviceId = formatDeviceId((await sha256Hex(publicKey)).slice(0, 32))
  return { deviceId, publicKey, privateKey: pair.privateKey }
}

async function signText(text: string): Promise<string> {
  if (!identity) throw new Error('identity missing')
  return base64url(new Uint8Array(await crypto.subtle.sign('Ed25519', identity.privateKey, encoder.encode(text))))
}

async function postJSON(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return response.json()
}

// Mirrors authenticatedSignalingRequest in src/main/index.ts.
async function signedRequest(input: SignalingRequest, privileged = false): Promise<unknown> {
  if (!identity) throw new Error('identity missing')
  const path = input.path
  const isPrivileged = /\/api\/v1\/sessions\/[a-f0-9]{32}\/decision$/.test(path)
  if (isPrivileged && !privileged) throw new TypeError('The requested signaling operation is not allowed.')
  let body: Record<string, unknown> | undefined = input.body === undefined ? undefined : JSON.parse(JSON.stringify(input.body)) as Record<string, unknown>
  if (path === '/api/v1/devices/register' && body) {
    body.publicKey = identity.publicKey
  }
  const signalMatch = path.match(/^\/api\/v1\/sessions\/([a-f0-9]{32})\/signal$/)
  if (signalMatch && body) {
    const message = body.message as { type: string; payload: unknown; fromDeviceId?: string; signature?: string }
    message.fromDeviceId = identity.deviceId
    const digest = await peerDigest(message.payload)
    message.signature = await signText(peerSignalCanonical(signalMatch[1], identity.deviceId, message.type, message.payload, digest))
  }
  const bodyText = body === undefined ? '' : JSON.stringify(body)
  const challenge = await postJSON('/api/v1/challenge', { deviceId: identity.deviceId }) as { nonce?: string; protocolVersion?: string }
  if (typeof challenge.nonce !== 'string' || challenge.protocolVersion !== 'v1') throw new Error('incompatible challenge')
  const digest = await sha256Hex(bodyText)
  const canonical = `opendesk-signaling-v1\n${input.method}\n${path}\n${digest}\n${challenge.nonce}`
  const headers: Record<string, string> = {
    'X-OD-Device-ID': identity.deviceId,
    'X-OD-Nonce': challenge.nonce,
    'X-OD-Signature': await signText(canonical),
    Accept: 'application/json'
  }
  if (bodyText) headers['Content-Type'] = 'application/json'
  const response = await fetch(path, { method: input.method, headers, body: bodyText || undefined })
  const value = await response.json().catch(() => null) as { error?: { message?: string } } | null
  if (!response.ok) throw new Error(value?.error?.message || `Signaling request failed with HTTP ${response.status}.`)
  return value
}

async function verifyPeer(input: PeerSignalVerification): Promise<boolean> {
  try {
    if (formatDeviceId((await sha256Hex(input.peerPublicKey)).slice(0, 32)) !== input.peerDeviceId) return false
    const key = await crypto.subtle.importKey('raw', fromBase64url(input.peerPublicKey), { name: 'Ed25519' }, false, ['verify'])
    const digest = await peerDigest(input.payload)
    return await crypto.subtle.verify('Ed25519', key, fromBase64url(input.signature), encoder.encode(peerSignalCanonical(input.sessionId, input.fromDeviceId, input.type, input.payload, digest)))
  } catch {
    return false
  }
}

const bridge = {
  signalingRequest: (request: SignalingRequest) => signedRequest(request),
  decideSession: async (request: SessionDecisionRequest) => signedRequest({
    method: 'POST',
    path: `/api/v1/sessions/${request.sessionId}/decision`,
    body: { accepted: request.accepted, permissions: request.accepted ? request.permissions : [] }
  }, true) as Promise<RemoteSession>,
  verifyPeerSignal: verifyPeer,
  trustPeer: async () => true,
  armScreenCapture: async () => undefined,
  startRemoteInput: async (sessionId: string) => {
    remoteInput.start(sessionId, hostDisplay)
    enabledSession = sessionId
  },
  stopRemoteInput: async (sessionId: string) => {
    if (remoteInput.activeSessionId === sessionId) remoteInput.stop()
    if (enabledSession === sessionId) enabledSession = null
  },
  injectRemoteInput: async (message: RemoteInputMessage) => {
    const at = absoluteNow()
    remoteInput.inject(message)
    injectLog.push({ type: message.type, at, down: 'down' in message ? message.down : undefined, marker: markerOn })
  },
  prepareIncomingFile: async (request: { name: string; size: number }) => {
    const transferToken = crypto.randomUUID()
    incomingFiles.set(transferToken, { hash: sha256.create(), bytes: 0 })
    return { transferToken, destinationName: request.name }
  },
  writeIncomingFile: async (transferToken: string, chunk: Uint8Array) => {
    const entry = incomingFiles.get(transferToken)
    if (!entry) throw new Error('unknown transfer')
    entry.hash.update(chunk)
    entry.bytes += chunk.byteLength
  },
  finishIncomingFile: async (transferToken: string) => {
    const entry = incomingFiles.get(transferToken)
    if (!entry) throw new Error('unknown transfer')
    incomingFiles.delete(transferToken)
    return { sha256: Array.from(entry.hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('') }
  },
  cancelIncomingFile: async (transferToken: string) => { incomingFiles.delete(transferToken) }
} as unknown as Pick<OpenDeskBridge, 'signalingRequest' | 'decideSession' | 'verifyPeerSignal' | 'trustPeer' | 'armScreenCapture' | 'startRemoteInput' | 'stopRemoteInput' | 'injectRemoteInput'>

// Replaces Electron's display capture with an animated canvas so frames flow without a screen. The frame rate
// follows the capture constraint the renderer requests, defaulting to 15 fps. This is an assumption about the
// desktop capturer, recorded in the benchmark output.
let drawTimer: ReturnType<typeof setInterval> | null = null
function startFakeDisplay(fps: number): MediaStream {
  const canvas = document.createElement('canvas')
  canvas.width = 800
  canvas.height = 450
  const context = canvas.getContext('2d')!
  let frame = 0
  if (drawTimer) clearInterval(drawTimer)
  const draw = () => {
    frame += 1
    context.fillStyle = `hsl(${frame % 360} 70% 45%)`
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#fff'
    context.fillRect((frame * 7) % 760, 180, 40, 40)
    context.fillStyle = markerOn ? '#fff' : '#000'
    context.fillRect(8, 8, 40, 40)
  }
  draw()
  drawTimer = setInterval(draw, 1000 / fps)
  return canvas.captureStream(fps)
}

function installFakeDisplayCapture(): void {
  Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
    configurable: true,
    value: async (constraints?: { video?: boolean | { frameRate?: { max?: number; ideal?: number } } }) => {
      const video = typeof constraints?.video === 'object' ? constraints.video : undefined
      // Chromium selects the format closest to `ideal` that does not exceed `max`; mirror that rule.
      const requested = video?.frameRate?.ideal ?? video?.frameRate?.max ?? 15
      const fps = Math.max(1, Math.min(60, requested, video?.frameRate?.max ?? requested))
      return startFakeDisplay(fps)
    }
  })
}

// Benchmark instrumentation. Times are absolute milliseconds (performance.timeOrigin + performance.now()) so that
// the viewer and host pages, which run in the same browser on one clock, can be correlated.
const absoluteNow = () => performance.timeOrigin + performance.now()
interface TimedInput { type: string; at: number; down?: boolean; marker?: boolean }
interface MarkerSample { at: number; on: boolean }
const dispatchLog: TimedInput[] = []
const sendLog: TimedInput[] = []
const injectLog: TimedInput[] = []
const markerSamples: MarkerSample[] = []
let lastMetrics: SessionMetrics = {}
const qualityNotices: string[] = []
let probeSnapshot: ProbeSnapshot | null = null
const markerCanvas = document.createElement('canvas')
markerCanvas.width = 1
markerCanvas.height = 1
const markerContext = markerCanvas.getContext('2d', { willReadFrequently: true })!
const probe = new VideoFrameProbe({
  onFrame: frame => {
    const video = remoteVideo()
    if (!video.videoWidth) return
    // Sample the centre of the marker patch (drawn at 8..48 in the 800x450 source frame).
    markerContext.drawImage(video, 16, 16, 24, 24, 0, 0, 1, 1)
    const [red, green, blue] = markerContext.getImageData(0, 0, 1, 1).data
    markerSamples.push({ at: frame.presentedAt + performance.timeOrigin, on: 0.299 * red + 0.587 * green + 0.114 * blue > 128 })
    if (markerSamples.length > 20_000) markerSamples.splice(0, 10_000)
  }
})
let fileTransfers: FileTransferManager | null = null
const incomingFiles = new Map<string, { hash: ReturnType<typeof sha256.create>; bytes: number }>()

function remoteVideo(): HTMLVideoElement {
  return document.getElementById('remote') as HTMLVideoElement
}

function attachControllerCallbacks(role: 'host' | 'viewer') {
  return {
    onState: (value: ConnectionState) => { remoteState = value },
    onRemoteStream: (stream: MediaStream | null) => {
      remoteStream = stream
      remoteVideo().srcObject = stream
      if (stream) probe.start(remoteVideo())
      else probe.stop()
      syncViewerForwarder()
    },
    onLocalStream: () => undefined,
    onDataChannel: (channel: RTCDataChannel | null) => {
      fileTransfers?.close()
      fileTransfers = channel ? new FileTransferManager(channel, bridge as never, {
        allowFiles: activePermissions.includes('files'),
        allowClipboard: activePermissions.includes('clipboard'),
        onIncomingOffer: async (name: string, size: number) => activePermissions.includes('files') ? bridge.prepareIncomingFile({ name, size }) : null,
        onClipboardText: async () => undefined,
        onTransfer: (record: TransferRecord) => {
          transferRecords.push(record)
          if (transferRecords.length > 1000) transferRecords.splice(0, transferRecords.length - 1000)
        },
        onError: (message: string) => { errors.push(message) }
      }) : null
    },
    onMetrics: (value: SessionMetrics) => { lastMetrics = value },
    onQualityProfile: (profile: string, mode: string) => { qualityNotices.push(`${mode}:${profile}`) },
    onPrepared: () => undefined,
    onSessionEnded: (reason: string) => { errors.push(`session ended: ${reason}`) },
    onError: (message: string) => { errors.push(message) },
    onRemoteControl: (state: RemoteControlState, reason?: string) => {
      if (role === 'viewer') {
        remoteControlState = state
        remoteControlReason = reason ?? ''
        syncViewerForwarder()
      }
    }
  }
}

function syncViewerForwarder(): void {
  const shouldAttach = controllerRole === 'viewer' && remoteControlState === 'active' && !!remoteStream && !!controller
  if (shouldAttach && !viewerForwarder) {
    viewerForwarder = new ViewerInputForwarder({
      element: remoteVideo(),
      send: message => {
        const accepted = controller?.sendRemoteInput(message) ?? false
        if (accepted) sendLog.push({ type: message.type, at: absoluteNow(), down: 'down' in message ? message.down : undefined })
        return accepted
      }
    })
    viewerForwarder.attach()
  } else if (!shouldAttach && viewerForwarder) {
    viewerForwarder.detach()
    viewerForwarder = null
  }
}

async function startController(role: 'host' | 'viewer', sessionId: string, peer: DeviceSummary, permissions: SessionPermission[]): Promise<void> {
  if (!client || !localDevice) throw new Error('not started')
  await controller?.close()
  // Reset before construction: the controller reports its initial remote-control state synchronously.
  remoteState = 'connecting'
  remoteControlState = 'off'
  activePermissions = [...permissions]
  controller = new RemoteSessionController(sessionId, role, peer, localDevice, client, bridge, attachControllerCallbacks(role), permissions)
  controllerRole = role
  controllerSessionId = sessionId
  syncViewerForwarder()
  const current = controller
  void current.prepare().then(async () => {
    for (const event of pendingSignals.get(sessionId) ?? []) {
      if (event.message) await current.handleSignal(event.message)
    }
    pendingSignals.delete(sessionId)
  }).catch(error => errors.push(`prepare: ${error instanceof Error ? error.message : String(error)}`))
}

async function handleEvent(event: SignalingEvent): Promise<void> {
  if (event.type === 'session.request' && event.session && event.peer && autoAccept) {
    const requested = event.session.requestedPermissions
    const session = await client!.decideSession(event.session.id, true, requested)
    await startController('host', session.id, event.peer, session.permissions ?? requested)
    return
  }
  if (event.type === 'session.accepted' && event.session && event.peer && controllerSessionId !== event.session.id && controllerRole === null) {
    await startController('viewer', event.session.id, event.peer, event.session.permissions ?? ['view'])
    return
  }
  if (event.type === 'signal' && event.sessionId && event.message) {
    if (controllerSessionId === event.sessionId && controller) {
      await controller.handleSignal(event.message)
    } else {
      pendingSignals.set(event.sessionId, [...(pendingSignals.get(event.sessionId) ?? []), event])
    }
    return
  }
  if ((event.type === 'session.closed' || event.type === 'session.rejected' || event.type === 'session.expired') && event.sessionId === controllerSessionId) {
    await controller?.close()
    controller = null
    controllerRole = null
    controllerSessionId = null
    syncViewerForwarder()
  }
}

async function pump(): Promise<void> {
  while (pumping) {
    try {
      const batch = await client!.pollEvents(cursor, 2)
      cursor = Math.max(cursor, batch.cursor)
      for (const event of batch.events) await handleEvent(event)
    } catch (error) {
      errors.push(`poll: ${error instanceof Error ? error.message : String(error)}`)
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
}

const harness = {
  async start(name: string, accept: boolean): Promise<string> {
    identity = await createIdentity()
    autoAccept = accept
    localDevice = {
      deviceId: identity.deviceId,
      deviceName: name,
      appVersion: 'e2e',
      platform: 'linux',
      architecture: 'x64',
      identityReady: true,
      identityMessage: 'ready',
      secureStorageBackend: 'test'
    }
    client = new SignalingClient(bridge as never, localDevice)
    await client.register()
    pumping = true
    void pump()
    return identity.deviceId
  },
  async requestSession(targetId: string, permissions: SessionPermission[]): Promise<string> {
    const peer = await client!.lookupDevice(targetId)
    const result = await client!.createSession(peer.id, ['view', ...permissions])
    return result.session.id
  },
  startShare(): Promise<void> {
    return controller!.startScreenShare()
  },
  /** Host: selects the quality profile (or auto). Viewer: asks the host for it. */
  setQuality(profile: 'auto' | 'ultra' | 'balanced' | 'high' | 'low'): void {
    controller!.requestQualityProfile(profile)
  },
  qualityNotices(): string[] {
    return qualityNotices.slice()
  },
  async enableRemoteControl(): Promise<string> {
    try {
      await controller!.enableRemoteControl()
      return 'enabled'
    } catch (error) {
      return `refused: ${error instanceof Error ? error.message : String(error)}`
    }
  },
  revokeRemoteControl(): Promise<void> {
    return controller!.revokeRemoteControl('The local user stopped remote control.')
  },
  viewerKey(type: 'keydown' | 'keyup', code: string): void {
    const event = Object.assign(new Event(type, { cancelable: true, bubbles: true }), { code, repeat: false })
    remoteVideo().dispatchEvent(event)
  },
  viewerPointer(type: 'pointermove' | 'pointerdown' | 'pointerup', fractionX: number, fractionY: number, button = 0): void {
    const box = remoteVideo().getBoundingClientRect()
    const clientX = box.left + fractionX * box.width
    const clientY = box.top + fractionY * box.height
    remoteVideo().dispatchEvent(new PointerEvent(type, { clientX, clientY, button, bubbles: true, cancelable: true }))
  },
  async closeLocal(): Promise<void> {
    // Same order as the app's disconnect(): tell signaling, then close the local controller.
    const sessionId = controllerSessionId
    if (sessionId && client) await client.closeSession(sessionId).catch(() => undefined)
    await controller?.close()
    controller = null
    controllerRole = null
    controllerSessionId = null
    syncViewerForwarder()
  },
  /** Viewer: schedules `count` taps (key down, then up) every `periodMs`; resolves after the last tap. */
  benchKeyTaps(count: number, periodMs: number): Promise<void> {
    return new Promise(resolve => {
      let index = 0
      const tap = () => {
        const code = index % 2 === 0 ? 'KeyA' : 'KeyB'
        const event = Object.assign(new Event('keydown', { cancelable: true, bubbles: true }), { code, repeat: false })
        dispatchLog.push({ type: 'input:key', at: absoluteNow() })
        remoteVideo().dispatchEvent(event)
        setTimeout(() => remoteVideo().dispatchEvent(Object.assign(new Event('keyup', { cancelable: true, bubbles: true }), { code, repeat: false })), 20)
        index += 1
        if (index < count) setTimeout(tap, periodMs)
        else setTimeout(resolve, periodMs)
      }
      tap()
    })
  },
  /** Viewer: one pointermove per animation frame for `frames` frames, sweeping across the display. */
  benchPointerSweep(frames: number): Promise<void> {
    return new Promise(resolve => {
      let index = 0
      const step = () => {
        const phase = index / Math.max(1, frames)
        const fractionX = 0.5 + 0.45 * Math.sin(phase * Math.PI * 4)
        const fractionY = 0.5 + 0.35 * Math.cos(phase * Math.PI * 6)
        const box = remoteVideo().getBoundingClientRect()
        dispatchLog.push({ type: 'input:move', at: absoluteNow() })
        remoteVideo().dispatchEvent(new PointerEvent('pointermove', { clientX: box.left + fractionX * box.width, clientY: box.top + fractionY * box.height, bubbles: true, cancelable: true }))
        index += 1
        if (index < frames) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
  },
  /** Viewer: sends a generated file to the host over the session's data channel. Resolves with bytes and seconds. */
  async benchSendFile(bytes: number): Promise<{ bytes: number; seconds: number }> {
    if (!fileTransfers) throw new Error('file transfer is not connected')
    const data = new Uint8Array(bytes)
    for (let offset = 0; offset < bytes; offset += 65536) crypto.getRandomValues(data.subarray(offset, Math.min(bytes, offset + 65536)))
    const file = new File([data], 'benchmark.bin', { type: 'application/octet-stream' })
    const started = performance.now()
    await fileTransfers.sendFiles([file])
    return { bytes, seconds: (performance.now() - started) / 1000 }
  },
  /** Busy-loops in dedicated workers to create CPU contention on this machine. */
  startCpuLoad(workers: number): void {
    const source = 'for (;;) { Math.sqrt(Math.random()) }'
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    for (let index = 0; index < workers; index += 1) loadWorkers.push(new Worker(url))
  },
  stopCpuLoad(): void {
    for (const worker of loadWorkers.splice(0)) worker.terminate()
  },
  /** Viewer: all timestamps and the probe snapshot recorded so far. */
  benchViewerData() {
    return { dispatches: dispatchLog.slice(), sends: sendLog.slice(), markers: markerSamples.slice(), metrics: lastMetrics, presentation: probe.snapshot() }
  },
  /** Host: injected messages and native dispatch timing recorded so far. */
  benchHostData() {
    return { injects: injectLog.slice(), dispatchTiming: remoteInput.dispatchTiming(), metrics: lastMetrics }
  },
  benchReset(): void {
    dispatchLog.length = 0
    sendLog.length = 0
    injectLog.length = 0
    markerSamples.length = 0
    nativeLog.length = 0
  },
  snapshot() {
    const video = remoteVideo()
    return {
      deviceId: identity?.deviceId ?? null,
      role: controllerRole,
      connection: remoteState,
      remoteControl: remoteControlState,
      remoteControlReason,
      remoteControlStateFromController: controller?.remoteControlState ?? null,
      video: { width: video.videoWidth, height: video.videoHeight, ready: video.readyState, hasStream: !!video.srcObject },
      nativeLog: nativeLog.slice(),
      heldKeys: remoteInput.heldKeyCount,
      heldButtons: remoteInput.heldButtonCount,
      remoteInputActive: remoteInput.active,
      dataChannelReady: !!fileTransfers,
      transfers: transferRecords.slice(-50),
      errors: errors.slice(-20)
    }
  },
  stopPumping(): void {
    pumping = false
  },
  clearNativeLog(): void {
    nativeLog.length = 0
  }
}

installFakeDisplayCapture()
;(window as unknown as { harness: typeof harness }).harness = harness
document.title = 'harness-ready'
