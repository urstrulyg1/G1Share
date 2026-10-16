import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences
} from 'electron'
import type { WebContents } from 'electron'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signMessage,
  verify as verifySignature
} from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rename, unlink, writeFile, mkdir, chmod, rm, readdir } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostname, homedir } from 'node:os'
import { spawn } from 'node:child_process'
import type { DeviceInfo, DeviceSummary, DesktopCapabilities, EventBatch, IncomingFileHandle, IncomingFileRequest, OpenDeskBridge, PeerSignalVerification, RemoteSession, SessionDecisionRequest, SessionPermission, SignalingRequest, TrustedDevice } from '../shared/types'
import { isSessionPermission, permissionLabel, SESSION_PERMISSIONS } from '../shared/permissions'
import { parseRemoteInputMessage } from '../shared/remote-input'
import { loadLibnutBackend, RemoteInputController, remoteInputSupport } from './remote-input'
import type { InputSupport, NativeInputBackend } from './remote-input'
import { formatDeviceId, isValidDeviceId, normalizeDeviceId } from '../shared/device-id'
import { readBoundedResponse } from './http-response'
import { IncomingFileStore } from './incoming-file-store'
import { AutoSignalingManager } from './embedded-signaling'

const currentDir = dirname(fileURLToPath(import.meta.url))
const PROJECT_URL = 'https://github.com/urstrulyg1/G1Viewer'
const MAX_SIGNALING_BODY = 512 * 1024
const MAX_SIGNALING_RESPONSE = 1024 * 1024
const MAX_CLIPBOARD_TEXT = 64 * 1024
const settingsPath = () => join(app.getPath('userData'), 'settings.json')
const identityPath = () => join(app.getPath('userData'), 'identity', 'device.json')
const trustedDevicesPath = () => join(app.getPath('userData'), 'trusted-devices.json')

interface StoredIdentity {
  version: 1
  deviceId: string
  publicKey: string
  encryptedPrivateKey: string
}

interface SecureIdentity extends StoredIdentity {
  privateKey: ReturnType<typeof createPrivateKey>
}

interface AppSettings {
  signalingUrl: string
  /** An optional local device label, never a user profile or account. */
  deviceName?: string
}

interface SignalingErrorResponse {
  error?: { code?: string; message?: string }
}

class SignalingRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message)
    this.name = 'SignalingRequestError'
  }
}

let mainWindow: BrowserWindow | null = null
let identityPromise: Promise<SecureIdentity> | null = null
let settingsPromise: Promise<AppSettings> | null = null
let autoSignalingManager: AutoSignalingManager | null = null
let autoSignalingUrlPromise: Promise<string> | null = null

async function getAutomaticSignalingUrl(): Promise<string> {
  if (!autoSignalingManager) {
    autoSignalingManager = new AutoSignalingManager()
    autoSignalingUrlPromise = autoSignalingManager.start().catch(err => {
      console.error('Failed to start automatic signaling manager:', err)
      return 'http://127.0.0.1:8787'
    })
  }
  return autoSignalingUrlPromise!
}
/** A screen capture is permitted only after the host approved the session and before the picker is used. */
let captureArm: { sessionId: string; audio: boolean; until: number } | null = null
/** The display the host actually picked for the current capture; remote input may only target this display. */
let activeCapture: { sessionId: string; displayId: string } | null = null
/** Permissions the host approved for each session, recorded from the local approval dialog. */
const approvedSessions = new Map<string, ReadonlySet<SessionPermission>>()
const CAPTURE_ARM_MS = 15 * 60 * 1000
const MAX_APPROVED_SESSIONS = 50
let nativeInput: { backend: NativeInputBackend } | { error: string } | null = null
let inputController: RemoteInputController | null = null
let lastClipboardPrompt = 0
let quitCleanupComplete = false
let quitCleanupPromise: Promise<void> | null = null
const incomingFileStore = new IncomingFileStore()

function secureStorageBackend(): string {
  if (process.platform !== 'linux') return process.platform === 'darwin' ? 'macOS Keychain' : 'Windows DPAPI'
  try {
    return safeStorage.getSelectedStorageBackend()
  } catch {
    return 'unknown'
  }
}

function requireSecureStorage(): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('The operating-system credential store is unavailable. Install and unlock your desktop keyring, then restart G1Viewer.')
  const backend = secureStorageBackend()
  if (process.platform === 'linux' && (backend === 'basic_text' || backend === 'unknown')) {
    throw new Error('G1Viewer refuses to store the device key without a real Linux secret store. Install and unlock GNOME Keyring/libsecret or KWallet, then restart.')
  }
  return backend
}

function deriveDeviceId(publicKey: string): string {
  const hash = createHash('sha256').update(publicKey, 'utf8').digest()
  const num = (hash.readBigUInt64BE(0) % 900_000_000n + 100_000_000n).toString()
  return formatDeviceId(num)
}

function peerMatchesPublicKey(peerDeviceId: string, publicKey: string): boolean {
  const normalized = normalizeDeviceId(peerDeviceId)
  if (deriveDeviceId(publicKey) === normalized) return true
  const hash = createHash('sha256').update(publicKey, 'utf8').digest().subarray(0, 16).toString('hex').toUpperCase()
  if (hash.match(/.{8}/g)!.join('-') === normalized) return true
  if (hash.slice(0, 12).match(/.{4}/g)!.join('-') === normalized) return true
  return false
}

function rawEd25519PublicKey(privateKey: ReturnType<typeof createPrivateKey>): string {
  const encoded = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  return Buffer.from(encoded).subarray(-32).toString('base64url')
}

async function atomicWrite(path: string, contents: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, contents, { encoding: 'utf8', mode })
  if (process.platform !== 'win32') await chmod(temporary, mode)
  await rename(temporary, path)
}

async function loadSecureIdentity(): Promise<SecureIdentity> {
  if (identityPromise) return identityPromise
  identityPromise = (async () => {
    const storageBackend = requireSecureStorage()
    const path = identityPath()
    let stored: StoredIdentity | null = null
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!parsed || typeof parsed !== 'object') throw new Error('Stored device identity is malformed.')
      const data = parsed as Partial<StoredIdentity>
      if (data.version !== 1 || typeof data.deviceId !== 'string' || !isValidDeviceId(data.deviceId) || typeof data.publicKey !== 'string' || typeof data.encryptedPrivateKey !== 'string') {
        throw new Error('Stored device identity is malformed. Open Settings and reset the identity before reconnecting.')
      }
      stored = data as StoredIdentity
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    if (stored) {
      let privatePem: string
      try {
        privatePem = safeStorage.decryptString(Buffer.from(stored.encryptedPrivateKey, 'base64'))
      } catch {
        throw new Error('The OS credential store could not unlock this device key. Restore access to the keyring or reset this device identity.')
      }
      let privateKey: ReturnType<typeof createPrivateKey>
      try {
        privateKey = createPrivateKey(privatePem)
      } catch {
        throw new Error('The stored device key is invalid. Reset the local identity before reconnecting.')
      }
      if (privateKey.asymmetricKeyType !== 'ed25519' || rawEd25519PublicKey(privateKey) !== stored.publicKey) {
        throw new Error('The stored device identity does not match its public key. Reset the local identity before reconnecting.')
      }
      const currentExpectedId = deriveDeviceId(stored.publicKey)
      if (stored.deviceId !== currentExpectedId) {
        stored.deviceId = currentExpectedId
        await atomicWrite(path, JSON.stringify(stored, null, 2) + '\n')
      }
      return { ...stored, privateKey }
    }

    const pair = generateKeyPairSync('ed25519')
    const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const publicKey = rawEd25519PublicKey(pair.privateKey)
    const identity: StoredIdentity = {
      version: 1,
      deviceId: deriveDeviceId(publicKey),
      publicKey,
      encryptedPrivateKey: safeStorage.encryptString(privatePem).toString('base64')
    }
    await atomicWrite(path, JSON.stringify(identity, null, 2) + '\n')
    return { ...identity, privateKey: pair.privateKey }
  })()
  return identityPromise
}

function cleanDeviceName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
  return cleaned || 'G1Viewer device'
}

async function getDeviceInfo(): Promise<DeviceInfo> {
  const name = cleanDeviceName((await loadSettings().catch(() => null))?.deviceName ?? hostname())
  try {
    const identity = await loadSecureIdentity()
    if (autoSignalingManager && identity.deviceId) {
      autoSignalingManager.setLocalIdentity(
        identity.deviceId,
        identity.publicKey,
        name,
        process.platform,
        app.getVersion(),
        identity.privateKey
      )
    }
    return {
      deviceId: identity.deviceId,
      deviceName: name,
      appVersion: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      identityReady: true,
      identityMessage: 'Device key is stored using the operating-system credential store.',
      secureStorageBackend: secureStorageBackend()
    }
  } catch (error) {
    // Do not invent a display-only ID or present an undecryptable/stale key as usable.
    return {
      deviceId: null,
      deviceName: name,
      appVersion: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      identityReady: false,
      identityMessage: error instanceof Error ? error.message : 'Secure device identity is unavailable.',
      secureStorageBackend: secureStorageBackend()
    }
  }
}

function isLanOrLoopback(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '127.0.0.1' || /^127(?:\.\d{1,3}){3}$/.test(host)) return true
  if (host.endsWith('.local')) return true
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true
  const m172 = host.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (m172) {
    const octet = parseInt(m172[1], 10)
    if (octet >= 16 && octet <= 31) return true
  }
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true
  if (/^169\.254(?:\.\d{1,3}){2}$/.test(host)) return true
  return false
}

function validateSignalingURL(input: string): string {
  if (typeof input !== 'string' || input.length > 512) throw new TypeError('Enter a valid signaling server URL.')
  let parsed: URL
  try { parsed = new URL(input.trim()) } catch { throw new TypeError('Enter a valid signaling server URL.') }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new TypeError('Use an HTTPS origin without a path, query string, or embedded credentials.')
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const lanOrLoopback = isLanOrLoopback(host)
  if (parsed.protocol === 'http:' && !lanOrLoopback) {
    throw new TypeError('Remote public signaling servers must use HTTPS. Plain HTTP is permitted for local network and loopback development.')
  }
  return parsed.origin
}

async function loadSettings(): Promise<AppSettings> {
  const currentAutoUrl = autoSignalingManager ? autoSignalingManager.getActiveUrl() : await getAutomaticSignalingUrl()
  let contents: string
  try {
    contents = await readFile(settingsPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const configured = (process.env.G1VIEWER_SIGNALING_URL || process.env.OPENDESK_SIGNALING_URL)?.trim()
    return { signalingUrl: configured ? validateSignalingURL(configured) : currentAutoUrl }
  }
  try {
    const data: unknown = JSON.parse(contents)
    if (!data || typeof data !== 'object') throw new Error('missing settings')
    const { signalingUrl, deviceName } = data as Partial<AppSettings>
    const configured = signalingUrl?.trim()
    const effectiveUrl = configured ? validateSignalingURL(configured) : currentAutoUrl
    if (deviceName !== undefined && (typeof deviceName !== 'string' || !deviceName.trim() || Buffer.byteLength(deviceName, 'utf8') > 80)) throw new Error('invalid device name')
    return { signalingUrl: effectiveUrl, ...(deviceName === undefined ? {} : { deviceName }) }
  } catch {
    return { signalingUrl: currentAutoUrl }
  }
}

async function setSignalingURL(value: string): Promise<string> {
  const trimmed = value.trim()
  const autoUrl = await getAutomaticSignalingUrl()
  const signalingUrl = trimmed ? validateSignalingURL(trimmed) : autoUrl
  const settings = await loadSettings().catch(() => ({ signalingUrl: autoUrl }))
  const updated = { ...settings, signalingUrl: trimmed ? signalingUrl : '' }
  await atomicWrite(settingsPath(), JSON.stringify(updated, null, 2) + '\n')
  settingsPromise = Promise.resolve({ ...settings, signalingUrl })
  return signalingUrl
}

async function renameLocalDevice(value: string): Promise<DeviceSummary> {
  const name = value.trim()
  if (!name || Buffer.byteLength(name, 'utf8') > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new TypeError('The device name must contain 1 to 80 bytes without control characters.')
  }
  const identity = await loadSecureIdentity()
  const summary = await authenticatedSignalingRequest({ method: 'POST', path: '/api/v1/devices/rename', body: { name } }, true) as DeviceSummary
  if (!summary || summary.id !== identity.deviceId || summary.name !== name) throw new Error('The signaling service did not confirm the new device name.')
  const settings = await loadSettings()
  const updated = { ...settings, deviceName: name }
  await atomicWrite(settingsPath(), JSON.stringify(updated, null, 2) + '\n')
  settingsPromise = Promise.resolve(updated)
  if (autoSignalingManager && identity.deviceId) {
    autoSignalingManager.setLocalIdentity(
      identity.deviceId,
      identity.publicKey,
      name,
      process.platform,
      app.getVersion(),
      identity.privateKey
    )
  }
  return summary
}

async function fetchJSON(url: string, init: RequestInit, timeoutMs = 15_000): Promise<{ status: number; value: unknown }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'error', cache: 'no-store' })
    const text = await readBoundedResponse(response, MAX_SIGNALING_RESPONSE)
    let value: unknown = {}
    if (text) {
      try { value = JSON.parse(text) } catch { throw new Error('Signaling server returned invalid JSON.') }
    }
    return { status: response.status, value }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Signaling request timed out. Check the server URL and network, then retry.')
    if (error instanceof TypeError) throw new Error('Could not reach the signaling server. Verify the HTTPS URL, DNS, and server health.')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function requestPathIsAllowed(path: string): boolean {
  if (!path.startsWith('/api/v1/') || path.includes('#') || path.includes('\\') || path.includes('%') || path.includes('\n') || path.includes('\r')) return false
  const route = path.split('?')[0]
  if (path.includes('?')) {
    if (route !== '/api/v1/events' || !/^\/api\/v1\/events\?after=\d+&wait=(?:0|[1-9]\d?)$/.test(path)) return false
  }
  return /^\/api\/v1\/(?:devices\/(?:register|heartbeat|me|rename|revoke|[A-F0-9-]{12,35})|sessions(?:\/[a-f0-9]{32}(?:\/(?:decision|signal|close))?)?|events|ice)$/.test(route)
}

function peerSignalCanonical(sessionId: string, fromDeviceId: string, messageType: string, payload: unknown): string {
  const payloadJSON = JSON.stringify(payload)
  if (payloadJSON === undefined) throw new TypeError('Peer signal payload must be JSON serializable.')
  const digest = createHash('sha256').update(payloadJSON, 'utf8').digest('hex')
  return `opendesk-peer-signal-v1\n${sessionId}\n${fromDeviceId}\n${messageType}\n${digest}`
}

async function verifyPeerSignal(input: PeerSignalVerification): Promise<boolean> {
  if (!input || !/^[a-f0-9]{32}$/.test(input.sessionId) || !isValidDeviceId(input.peerDeviceId) || input.fromDeviceId !== input.peerDeviceId || !['offer', 'answer', 'hangup'].includes(input.type)) return false
  if (typeof input.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(input.signature)) return false
  try {
    const fingerprint = trustedFingerprint(input.peerPublicKey)
    if (!peerMatchesPublicKey(input.peerDeviceId, input.peerPublicKey)) return false
    const trusted = await loadTrustedDevices()
    if (!trusted.some(device => device.id === input.peerDeviceId && device.fingerprint === fingerprint)) return false
    const rawKey = Buffer.from(input.peerPublicKey, 'base64url')
    if (rawKey.length !== 32 || rawKey.toString('base64url') !== input.peerPublicKey) return false
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
    const publicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, rawKey]), type: 'spki', format: 'der' })
    const canonical = peerSignalCanonical(input.sessionId, input.fromDeviceId, input.type, input.payload)
    const signature = Buffer.from(input.signature, 'base64url')
    return signature.length === 64 && verifySignature(null, Buffer.from(canonical, 'utf8'), publicKey, signature)
  } catch {
    return false
  }
}

async function authenticatedSignalingRequest(input: SignalingRequest, allowPrivileged = false): Promise<unknown> {
  const path = input && typeof input.path === 'string' ? input.path : ''
  const privilegedPath = path === '/api/v1/devices/revoke' || path === '/api/v1/devices/rename' || /\/api\/v1\/sessions\/[a-f0-9]{32}\/decision$/.test(path)
  if (!input || (input.method !== 'GET' && input.method !== 'POST') || typeof input.path !== 'string' || !requestPathIsAllowed(input.path) || (privilegedPath && !allowPrivileged)) {
    throw new TypeError('The requested signaling operation is not allowed.')
  }
  if (input.method === 'GET' && input.body !== undefined) throw new TypeError('GET signaling requests cannot include a body.')
  const identity = await loadSecureIdentity()
  const settings = await loadSettings()
  if (!settings.signalingUrl) throw new Error('Signaling server not configured. Set a self-hosted HTTPS origin in Settings before connecting.')
  let bodyText = input.body === undefined ? '' : JSON.stringify(input.body)
  if (bodyText === undefined) bodyText = ''

  if (input.path === '/api/v1/devices/register') {
    const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {}
    if (body.id !== identity.deviceId) throw new TypeError('Registration ID does not match this local identity.')
    body.publicKey = identity.publicKey
    bodyText = JSON.stringify(body)
  }

  const signalMatch = input.path.match(/^\/api\/v1\/sessions\/([a-f0-9]{32})\/signal$/)
  if (signalMatch) {
    const body = bodyText ? JSON.parse(bodyText) as { message?: Record<string, unknown> } : {}
    const message = body.message
    if (!message || typeof message.type !== 'string' || !['offer', 'answer'].includes(message.type) || !('payload' in message)) {
      throw new TypeError('A valid WebRTC offer or answer is required.')
    }
    message.fromDeviceId = identity.deviceId
    const canonical = peerSignalCanonical(signalMatch[1], identity.deviceId, message.type, message.payload)
    message.signature = signMessage(null, Buffer.from(canonical, 'utf8'), identity.privateKey).toString('base64url')
    bodyText = JSON.stringify(body)
  }

  if (Buffer.byteLength(bodyText, 'utf8') > MAX_SIGNALING_BODY) throw new TypeError('Signaling request exceeds the 512 KiB safety limit.')
  const challengeBody = JSON.stringify({ deviceId: identity.deviceId })
  const challengeResult = await fetchJSON(settings.signalingUrl + '/api/v1/challenge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: challengeBody
  }, 10_000)
  if (challengeResult.status < 200 || challengeResult.status >= 300 || !challengeResult.value || typeof challengeResult.value !== 'object') {
    throw new Error('The signaling service did not issue an authentication challenge. Check its health and client compatibility.')
  }
  const challenge = challengeResult.value as { nonce?: unknown; protocolVersion?: unknown }
  if (typeof challenge.nonce !== 'string' || challenge.protocolVersion !== 'v1') throw new Error('The signaling service uses an incompatible protocol version.')

  const digest = createHash('sha256').update(bodyText, 'utf8').digest('hex')
  const canonical = `opendesk-signaling-v1\n${input.method}\n${input.path}\n${digest}\n${challenge.nonce}`
  const signature = signMessage(null, Buffer.from(canonical, 'utf8'), identity.privateKey).toString('base64url')
  const headers: Record<string, string> = {
    'X-OD-Device-ID': identity.deviceId,
    'X-OD-Nonce': challenge.nonce,
    'X-OD-Signature': signature,
    Accept: 'application/json'
  }
  if (bodyText) headers['Content-Type'] = 'application/json'
  const timeout = input.path.startsWith('/api/v1/events?') ? 30_000 : 15_000
  const result = await fetchJSON(settings.signalingUrl + input.path, {
    method: input.method,
    headers,
    body: bodyText || undefined
  }, timeout)
  if (result.status < 200 || result.status >= 300) {
    const error = result.value as SignalingErrorResponse | null
    const code = typeof error?.error?.code === 'string' ? error.error.code : 'request_failed'
    const message = typeof error?.error?.message === 'string' ? error.error.message : `Signaling request failed with HTTP ${result.status}.`
    throw new SignalingRequestError(message, code, result.status)
  }
  const closed = input.path.match(/^\/api\/v1\/sessions\/([a-f0-9]{32})\/close$/)
  if (closed) forgetApprovedSession(closed[1])
  if (input.path.startsWith('/api/v1/events?')) {
    const events = (result.value as EventBatch | null)?.events
    if (Array.isArray(events)) for (const event of events) {
      if (event.sessionId && ['session.closed', 'session.rejected', 'session.expired'].includes(event.type)) forgetApprovedSession(event.sessionId)
    }
  }
  return result.value
}

function assertTrustedIPC(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('This operation is available only to the G1Viewer application window.')
  }
}

function assertString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum) throw new TypeError(`${name} must be a string of at most ${maximum} characters.`)
  return value
}

function trustedFingerprint(encodedPublicKey: string): string {
  const bytes = Buffer.from(encodedPublicKey, 'base64url')
  if (bytes.length !== 32 || bytes.toString('base64url') !== encodedPublicKey) throw new TypeError('Peer public key is invalid.')
  const fingerprint = createHash('sha256').update(bytes).digest('hex').toUpperCase()
  return fingerprint.match(/.{1,4}/g)!.join(':')
}

async function loadTrustedDevices(): Promise<TrustedDevice[]> {
  let contents: string
  try { contents = await readFile(trustedDevicesPath(), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(contents)
    if (!Array.isArray(parsed) || !parsed.every((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false
      const device = entry as TrustedDevice
      return typeof device.id === 'string' && isValidDeviceId(device.id) && typeof device.name === 'string' &&
        typeof device.fingerprint === 'string' && /^[A-F0-9]{4}(?::[A-F0-9]{4}){15}$/.test(device.fingerprint) && typeof device.trustedAt === 'string'
    })) throw new Error('invalid trust records')
    return parsed as TrustedDevice[]
  } catch {
    // Treat corruption as an error, not as an empty trust store that permits silent re-pairing.
    throw new Error('Local trusted-device records are invalid. Restore the trust store or resolve the issue before pairing.')
  }
}

async function trustPeer(peer: { id: string; name: string; publicKey: string }): Promise<boolean> {
  if (!peer || !isValidDeviceId(peer.id)) throw new TypeError('Peer device ID is invalid.')
  const publicKey = assertString(peer.publicKey, 'Peer public key', 128)
  const fingerprint = trustedFingerprint(publicKey)
  if (!peerMatchesPublicKey(peer.id, publicKey)) throw new TypeError('Peer device ID does not match its public-key fingerprint.')
  const trusted = await loadTrustedDevices()
  const existing = trusted.find(item => item.id === peer.id)
  if (existing && existing.fingerprint === fingerprint) return true
  if (existing) {
    await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: 'Trusted device key changed',
      message: `The identity key for ${peer.name || peer.id} changed. Open Devices and remove the old trust only after verifying the new fingerprint through a separate trusted channel.`,
      detail: `Device ID: ${peer.id}\nPreviously trusted fingerprint: ${existing.fingerprint}\nCurrent fingerprint: ${fingerprint}`,
      buttons: ['OK'],
      noLink: true
    })
    return false
  }
  const answer = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    title: 'Verify this device identity',
    message: `This is the first connection to ${peer.name || peer.id}. Confirm the fingerprint with the remote user using a separate trusted channel before trusting it.`,
    detail: `Device ID: ${peer.id}\nPublic-key fingerprint: ${fingerprint}\n\nA device ID is not a password. The remote computer must still approve every session.`,
    buttons: ['Cancel', 'Trust device'],
    cancelId: 0,
    defaultId: 0,
    noLink: true
  })
  if (answer.response !== 1) return false
  trusted.push({ id: peer.id, name: cleanDeviceName(peer.name), fingerprint, trustedAt: new Date().toISOString() })
  await atomicWrite(trustedDevicesPath(), JSON.stringify(trusted, null, 2) + '\n')
  return true
}

function audioLoopbackSupported(): boolean {
  // Electron's loopback audio capture is Windows-only in this build; macOS and Linux hosts share video only.
  return process.platform === 'win32'
}

function nativeInputBackend(): { backend: NativeInputBackend } | { error: string } {
  if (!nativeInput) {
    try {
      nativeInput = { backend: loadLibnutBackend() }
    } catch (error) {
      nativeInput = { error: error instanceof Error ? error.message : 'the native input library is unavailable' }
    }
  }
  return nativeInput
}

function inputSupport(): InputSupport {
  const native = nativeInputBackend()
  return remoteInputSupport({
    platform: process.platform,
    env: process.env,
    accessibilityTrusted: process.platform === 'darwin' ? systemPreferences.isTrustedAccessibilityClient(false) : undefined,
    backendError: 'error' in native ? native.error : undefined
  })
}

function inputControllerOrThrow(): RemoteInputController {
  const support = inputSupport()
  if (!support.supported) throw new Error(support.reason)
  const native = nativeInputBackend()
  if (!('backend' in native)) throw new Error('The native input library is unavailable.')
  inputController ??= new RemoteInputController(native.backend, process.platform)
  return inputController
}

function assertSessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new TypeError('Session ID is invalid.')
  return value
}

function rememberApprovedSession(sessionId: string, permissions: readonly SessionPermission[]): void {
  approvedSessions.delete(sessionId)
  approvedSessions.set(sessionId, new Set(permissions))
  while (approvedSessions.size > MAX_APPROVED_SESSIONS) {
    const oldest = approvedSessions.keys().next().value
    if (oldest === undefined) break
    approvedSessions.delete(oldest)
  }
}

function stopRemoteInputFor(sessionId: string): void {
  if (inputController?.activeSessionId === sessionId) inputController.stop()
  if (activeCapture?.sessionId === sessionId) activeCapture = null
}

function forgetApprovedSession(sessionId: string): void {
  approvedSessions.delete(sessionId)
  if (captureArm?.sessionId === sessionId) captureArm = null
  stopRemoteInputFor(sessionId)
}

function releaseRemoteInput(): void {
  try {
    inputController?.stop()
  } catch (error) {
    console.error('Could not release remote input.', error instanceof Error ? error.message : error)
  }
  activeCapture = null
}

async function decideSession(request: SessionDecisionRequest): Promise<RemoteSession> {
  if (!request || typeof request !== 'object' || typeof request.sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(request.sessionId) || typeof request.accepted !== 'boolean' || !Array.isArray(request.permissions) || request.permissions.length > SESSION_PERMISSIONS.length) {
    throw new TypeError('Session decision is invalid.')
  }
  if (request.permissions.some(permission => !isSessionPermission(permission)) || new Set(request.permissions).size !== request.permissions.length) {
    throw new TypeError('Session permission selection is invalid.')
  }
  if (!request.accepted && request.permissions.length > 0) throw new TypeError('A rejected session cannot grant permissions.')

  const identity = await loadSecureIdentity()
  const response = await authenticatedSignalingRequest({ method: 'GET', path: `/api/v1/sessions/${request.sessionId}` })
  if (!response || typeof response !== 'object') throw new Error('The session request could not be verified with the signaling service.')
  const details = response as { session?: unknown; peer?: unknown }
  if (!details.session || typeof details.session !== 'object' || !details.peer || typeof details.peer !== 'object') {
    throw new Error('The signaling service returned incomplete session details.')
  }
  const session = details.session as RemoteSession
  const peer = details.peer as DeviceSummary
  if (session.id !== request.sessionId || session.toDeviceId !== identity.deviceId || session.status !== 'pending' || !isValidDeviceId(session.fromDeviceId)) {
    throw new Error('This incoming session is no longer pending for this device.')
  }
  if (!peer || !isValidDeviceId(peer.id) || peer.id !== session.fromDeviceId || typeof peer.name !== 'string' || typeof peer.publicKey !== 'string') {
    throw new Error('The signaling service returned an invalid peer identity.')
  }
  if (!Array.isArray(session.requestedPermissions) || session.requestedPermissions.length > SESSION_PERMISSIONS.length || !session.requestedPermissions.every(isSessionPermission) || new Set(session.requestedPermissions).size !== session.requestedPermissions.length || !session.requestedPermissions.includes('view')) {
    throw new Error('The incoming session contains invalid permission requests.')
  }

  if (request.accepted) {
    const requested = new Set(session.requestedPermissions)
    if (!request.permissions.includes('view') || request.permissions.some(permission => !requested.has(permission))) {
      throw new TypeError('Only the requested permissions, including screen viewing, can be approved.')
    }
    if (request.permissions.includes('input')) {
      const support = inputSupport()
      if (!support.supported) throw new Error(support.reason)
    }
    if (request.permissions.includes('audio') && !audioLoopbackSupported()) {
      throw new Error('System audio can only be shared from a Windows host in this build. Approve the session without audio.')
    }
    const trusted = await trustPeer({ id: peer.id, name: peer.name, publicKey: peer.publicKey })
    if (!trusted) throw new Error('Peer identity was not trusted. The incoming session was not approved.')
    const permissionLabels = request.permissions.map(permissionLabel)
    const answer = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: 'Approve remote session',
      message: `Allow ${cleanDeviceName(peer.name)} (${peer.id}) to view this device?`,
      detail: `Granted permissions: ${permissionLabels.join(', ')}. No other capabilities are enabled. This local confirmation is required before the signaling service can accept the session.`,
      buttons: ['Cancel', 'Approve selected permissions'],
      cancelId: 0,
      defaultId: 0,
      noLink: true
    })
    if (answer.response !== 1) throw new Error('Session approval was cancelled. No remote access was granted.')
  }

  const decided = await authenticatedSignalingRequest({
    method: 'POST',
    path: `/api/v1/sessions/${request.sessionId}/decision`,
    body: { accepted: request.accepted, permissions: request.accepted ? request.permissions : [] }
  }, true)
  if (!decided || typeof decided !== 'object' || (decided as RemoteSession).id !== request.sessionId) {
    throw new Error('The signaling service returned an invalid session decision.')
  }
  if (request.accepted) rememberApprovedSession(request.sessionId, request.permissions)
  return decided as RemoteSession
}

async function forgetTrustedDevice(deviceId: string): Promise<boolean> {
  if (!isValidDeviceId(deviceId)) throw new TypeError('Device ID is invalid.')
  const trusted = await loadTrustedDevices()
  const existing = trusted.find(item => item.id === deviceId)
  if (!existing) return true
  const answer = await dialog.showMessageBox(mainWindow!, {
    type: 'warning', title: 'Remove trusted device',
    message: `Remove trust for ${existing.name}?`,
    detail: 'The next connection will require a new fingerprint verification. This does not revoke the identity on the signaling server.',
    buttons: ['Cancel', 'Remove trust'], cancelId: 0, defaultId: 0, noLink: true
  })
  if (answer.response !== 1) return false
  await atomicWrite(trustedDevicesPath(), JSON.stringify(trusted.filter(item => item.id !== deviceId), null, 2) + '\n')
  return true
}

async function resetDeviceIdentity(): Promise<DeviceInfo | null> {
  const identity = await loadSecureIdentity()
  const answer = await dialog.showMessageBox(mainWindow!, {
    type: 'warning', title: 'Revoke and replace this device identity',
    message: `Permanently revoke ${identity.deviceId} and create a new local identity?`,
    detail: 'The signaling service will close active sessions and reject this key. Other devices will need the new device ID and must verify its new fingerprint. If this device has never registered, only the local identity is reset.',
    buttons: ['Cancel', 'Revoke and reset'], cancelId: 0, defaultId: 0, noLink: true
  })
  if (answer.response !== 1) return null

  const path = identityPath()
  const backupPath = `${path}.revoked-${randomUUID()}.bak`
  await rename(path, backupPath)
  try {
    await authenticatedSignalingRequest({ method: 'POST', path: '/api/v1/devices/revoke', body: {} }, true)
  } catch (error) {
    const alreadyRevokedOrUnregistered = error instanceof SignalingRequestError && ['device_revoked', 'device_not_registered'].includes(error.code)
    if (!alreadyRevokedOrUnregistered) {
      await rename(backupPath, path).catch(() => undefined)
      throw error
    }
  }

  await unlink(backupPath).catch(error => console.error('Could not remove the encrypted backup of the revoked device key.', error))
  // Previous builds wrote a display-only ID file. Remove it on reset; it is never an identity key.
  await unlink(join(dirname(path), 'device-id')).catch(() => undefined)
  approvedSessions.clear()
  captureArm = null
  releaseRemoteInput()
  identityPromise = null
  return getDeviceInfo()
}

async function uninstallApplication(): Promise<boolean> {
  if (!mainWindow) return false
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Uninstall G1Viewer & Clean Leftovers',
    message: 'Completely uninstall G1Viewer and erase all local data?',
    detail: 'This will revoke this device identity from the network, delete all settings, trusted peer keys, cached sessions, files, and credentials, and remove G1Viewer user data from this computer.',
    buttons: ['Cancel', 'Uninstall & Wipe Everything'],
    cancelId: 0,
    defaultId: 0,
    noLink: true
  })
  if (answer.response !== 1) return false

  try {
    await authenticatedSignalingRequest({ method: 'POST', path: '/api/v1/devices/revoke', body: {} }, true)
  } catch { /* best effort */ }

  if (autoSignalingManager) {
    try { await autoSignalingManager.stop() } catch { /* ignore */ }
    autoSignalingManager = null
  }
  approvedSessions.clear()
  captureArm = null
  releaseRemoteInput()
  try { await incomingFileStore.closeAll() } catch { /* ignore */ }

  try {
    await session.defaultSession.clearStorageData()
    await session.defaultSession.clearCache()
  } catch { /* ignore */ }

  const userData = app.getPath('userData')
  try {
    const entries = await readdir(userData).catch(() => [] as string[])
    for (const entry of entries) {
      try {
        await rm(join(userData, entry), { recursive: true, force: true })
      } catch { /* ignore locked active files */ }
    }
  } catch { /* ignore */ }

  if (process.platform === 'win32') {
    const uninstaller = join(dirname(process.execPath), 'Uninstall G1Viewer.exe')
    if (existsSync(uninstaller)) {
      spawn(uninstaller, [], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('cmd.exe', ['/c', 'timeout /t 1 /nobreak > nul & rd /s /q "' + userData + '"'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref()
    }
  } else if (process.platform === 'darwin') {
    spawn('sh', ['-c', `sleep 1 && rm -rf "${userData}" ~/Library/Caches/com.urstrulyg1.g1viewer ~/Library/Saved\\ Application\\ State/com.urstrulyg1.g1viewer.savedState ~/Library/Preferences/com.urstrulyg1.g1viewer.plist`], {
      detached: true,
      stdio: 'ignore'
    }).unref()
  } else {
    const configDir = join(homedir(), '.config', 'G1Viewer')
    const cacheDir = join(homedir(), '.cache', 'G1Viewer')
    spawn('sh', ['-c', `sleep 1 && rm -rf "${userData}" "${configDir}" "${cacheDir}"`], {
      detached: true,
      stdio: 'ignore'
    }).unref()
  }

  dialog.showMessageBoxSync({
    type: 'info',
    title: 'G1Viewer Uninstalled',
    message: 'All local data, credentials, and settings have been cleaned up.',
    detail: 'G1Viewer will now exit.'
  })

  app.exit(0)
  return true
}

function safeIncomingFilename(value: string): string {
  const name = basename(value.replace(/[\\/]/g, '_')).replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim()
  if (!name || name === '.' || name === '..') throw new TypeError('Incoming file name is invalid; the transfer was not accepted.')
  return name.slice(0, 240)
}

async function prepareIncomingFile(request: IncomingFileRequest): Promise<IncomingFileHandle | null> {
  const name = safeIncomingFilename(assertString(request?.name, 'File name', 512))
  if (!Number.isSafeInteger(request.size) || request.size < 0 || request.size > 1024 * 1024 * 1024) throw new TypeError('File exceeds the configured 1 GiB transfer limit.')
  const prompt = await dialog.showMessageBox(mainWindow!, {
    type: 'question', title: 'Incoming file transfer',
    message: `Accept “${name}”?`,
    detail: `The remote user is sending ${formatBytes(request.size)}. Choose a destination. G1Viewer will not overwrite an existing file.`,
    buttons: ['Choose destination', 'Decline'], cancelId: 1, defaultId: 1, noLink: true
  })
  if (prompt.response !== 0) return null
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Choose where to save the incoming file',
    defaultPath: join(app.getPath('downloads'), name),
    buttonLabel: 'Receive file',
    properties: []
  })
  if (result.canceled || !result.filePath) return null
  return incomingFileStore.prepare(result.filePath, request.size)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

async function shareClipboardText(): Promise<string | null> {
  const now = Date.now()
  if (now - lastClipboardPrompt < 1000) throw new Error('Please wait before sending another clipboard item.')
  lastClipboardPrompt = now
  const answer = await dialog.showMessageBox(mainWindow!, {
    type: 'question', title: 'Share clipboard text',
    message: 'Send the current local clipboard text to the remote device?',
    detail: 'Clipboard content is sensitive. G1Viewer reads it only after you confirm this action, and never logs the text.',
    buttons: ['Cancel', 'Share text'], cancelId: 0, defaultId: 0, noLink: true
  })
  if (answer.response !== 1) return null
  const text = await clipboard.readText()
  if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_TEXT) throw new Error('Clipboard text exceeds the 64 KiB transfer limit.')
  return text
}

async function receiveClipboardText(text: string): Promise<boolean> {
  assertString(text, 'Clipboard text', MAX_CLIPBOARD_TEXT)
  const answer = await dialog.showMessageBox(mainWindow!, {
    type: 'warning', title: 'Remote clipboard update',
    message: 'Allow the remote device to replace your local clipboard text?',
    detail: `The received text is ${formatBytes(Buffer.byteLength(text, 'utf8'))}. G1Viewer will not show or log its contents.`,
    buttons: ['Keep current clipboard', 'Replace clipboard'], cancelId: 0, defaultId: 0, noLink: true
  })
  if (answer.response !== 1) return false
  clipboard.writeText(text)
  return true
}

async function getCapabilities(): Promise<DesktopCapabilities> {
  let screenCapture = 'Electron screen capture is configured; OS permission and source selection are required. Availability is confirmed when sharing starts.'
  if (process.platform === 'darwin') {
    try {
      const status = systemPreferences.getMediaAccessStatus('screen')
      screenCapture = status === 'granted' ? 'Screen Recording permission granted.' : `Screen Recording permission: ${status}.`
    } catch {
      screenCapture = 'Screen Recording requires macOS privacy permission; status is not available from this OS version.'
    }
  } else if (process.platform === 'linux') {
    screenCapture = 'Electron capture requires an active display. Wayland needs a working desktop portal/PipeWire picker; X11 uses the display session. Availability is confirmed when sharing starts.'
  }
  const input = inputSupport()
  const audioSupported = audioLoopbackSupported()
  return {
    platform: process.platform,
    architecture: process.arch,
    screenCapture,
    secureStorage: secureStorageBackend(),
    remoteInput: input.supported
      ? 'Available. The host enables remote keyboard and mouse per session after screen sharing starts.'
      : input.reason,
    remoteInputSupported: input.supported,
    audioCapture: audioSupported
      ? 'Available on Windows. System audio is shared only when the session approves the audio permission.'
      : 'Not available on this OS. System audio sharing is supported from Windows hosts only.',
    audioCaptureSupported: audioSupported,
    clipboard: 'User-confirmed one-time text transfer; continuous clipboard synchronization is not implemented.'
  }
}

/** Denies every browser permission except the one-time display capture for an armed, approved session. */
function permissionAllowed(webContents: WebContents | null, permission: string): boolean {
  if (permission !== 'display-capture' || !captureArm || Date.now() > captureArm.until) return false
  return !!mainWindow && webContents?.id === mainWindow.webContents.id
}

function installPermissionPolicy(): void {
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => permissionAllowed(webContents, permission))
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(permissionAllowed(webContents, permission)))
  session.defaultSession.setDevicePermissionHandler(() => false)
}

function installDisplayCaptureHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const trustedFrame = !!mainWindow && request.frame === mainWindow.webContents.mainFrame
    const arm = captureArm
    captureArm = null
    activeCapture = null
    if (!arm || Date.now() > arm.until || !trustedFrame || !request.userGesture || !request.videoRequested) {
      callback(null)
      return
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false })
      if (sources.length === 0) {
        callback(null)
        return
      }
      const buttons = sources.map((source, index) => `Share ${index + 1}: ${source.name}`).concat('Cancel')
      const answer = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: 'Choose a screen to share',
        message: 'Select the display that the approved remote session may view.',
        detail: 'Screen sharing starts only after you select a source. G1Viewer never captures in the background.',
        buttons, cancelId: buttons.length - 1, defaultId: buttons.length - 1, noLink: true
      })
      if (answer.response < 0 || answer.response >= sources.length) {
        callback(null)
        return
      }
      const source = sources[answer.response]
      activeCapture = { sessionId: arm.sessionId, displayId: source.display_id }
      callback({ video: source, audio: arm.audio && audioLoopbackSupported() ? 'loopback' : undefined })
    } catch {
      callback(null)
    }
  }, { useSystemPicker: process.platform === 'darwin' })
}

function registerIpcHandlers(): void {
  ipcMain.handle('device:get-info', async event => {
    assertTrustedIPC(event)
    return getDeviceInfo()
  })
  ipcMain.handle('settings:get-signaling-url', async event => {
    assertTrustedIPC(event)
    return (await loadSettings()).signalingUrl
  })
  ipcMain.handle('settings:set-signaling-url', async (event, value: unknown) => {
    assertTrustedIPC(event)
    return setSignalingURL(assertString(value, 'Signaling URL', 512))
  })
  ipcMain.handle('device:rename', async (event, value: unknown) => {
    assertTrustedIPC(event)
    return renameLocalDevice(assertString(value, 'Device name', 80))
  })
  ipcMain.handle('signaling:request', async (event, value: unknown) => {
    assertTrustedIPC(event)
    if (!value || typeof value !== 'object') throw new TypeError('Signaling request is invalid.')
    return authenticatedSignalingRequest(value as SignalingRequest)
  })
  ipcMain.handle('session:decide', async (event, value: unknown) => {
    assertTrustedIPC(event)
    if (!value || typeof value !== 'object') throw new TypeError('Session decision is invalid.')
    return decideSession(value as SessionDecisionRequest)
  })
  ipcMain.handle('signaling:verify-peer-signal', (event, value: unknown) => {
    assertTrustedIPC(event)
    if (!value || typeof value !== 'object') return false
    return verifyPeerSignal(value as PeerSignalVerification)
  })
  ipcMain.handle('devices:trust-peer', async (event, value: unknown) => {
    assertTrustedIPC(event)
    if (!value || typeof value !== 'object') throw new TypeError('Peer device information is invalid.')
    return trustPeer(value as { id: string; name: string; publicKey: string })
  })
  ipcMain.handle('devices:list-trusted', async event => {
    assertTrustedIPC(event)
    return loadTrustedDevices()
  })
  ipcMain.handle('devices:forget-trusted', async (event, value: unknown) => {
    assertTrustedIPC(event)
    return forgetTrustedDevice(assertString(value, 'Device ID', 40))
  })
  ipcMain.handle('identity:reset', async event => {
    assertTrustedIPC(event)
    return resetDeviceIdentity()
  })
  ipcMain.handle('app:uninstall', async event => {
    assertTrustedIPC(event)
    return uninstallApplication()
  })
  ipcMain.handle('system:copy-text', (event, value: unknown) => {
    assertTrustedIPC(event)
    clipboard.writeText(assertString(value, 'Clipboard text', 10000))
  })
  ipcMain.handle('system:read-text', async event => {
    assertTrustedIPC(event)
    // This read is reached only from the explicit Paste button in the renderer.
    return (await clipboard.readText()).slice(0, 10000)
  })
  ipcMain.handle('window:minimize', event => {
    assertTrustedIPC(event)
    if (!mainWindow) throw new Error('The G1Viewer window is unavailable.')
    if (process.platform === 'darwin' && mainWindow.isFullScreen()) {
      mainWindow.once('leave-full-screen', () => {
        mainWindow?.minimize()
      })
      mainWindow.setFullScreen(false)
      return
    }
    mainWindow.minimize()
  })
  ipcMain.handle('window:toggle-maximize', (event, options?: unknown) => {
    assertTrustedIPC(event)
    if (!mainWindow) throw new Error('The G1Viewer window is unavailable.')
    const altKey = Boolean(options && typeof options === 'object' && (options as { altKey?: boolean }).altKey)
    if (process.platform === 'darwin') {
      if (altKey) {
        if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false)
        if (mainWindow.isMaximized()) mainWindow.unmaximize()
        else mainWindow.maximize()
        return mainWindow.isMaximized()
      }
      const nextFullScreen = !mainWindow.isFullScreen()
      mainWindow.setFullScreen(nextFullScreen)
      return nextFullScreen || mainWindow.isMaximized()
    }
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('window:get-maximized', event => {
    assertTrustedIPC(event)
    if (!mainWindow) throw new Error('The G1Viewer window is unavailable.')
    return mainWindow.isFullScreen() || mainWindow.isMaximized()
  })
  ipcMain.handle('window:close', event => {
    assertTrustedIPC(event)
    if (!mainWindow) throw new Error('The G1Viewer window is unavailable.')
    mainWindow.close()
  })
  ipcMain.handle('clipboard:share-text', async event => {
    assertTrustedIPC(event)
    return shareClipboardText()
  })
  ipcMain.handle('clipboard:receive-text', async (event, value: unknown) => {
    assertTrustedIPC(event)
    return receiveClipboardText(assertString(value, 'Clipboard text', MAX_CLIPBOARD_TEXT))
  })
  ipcMain.handle('files:prepare-incoming', async (event, value: unknown) => {
    assertTrustedIPC(event)
    if (!value || typeof value !== 'object') throw new TypeError('Incoming file request is invalid.')
    return prepareIncomingFile(value as IncomingFileRequest)
  })
  ipcMain.handle('files:write-incoming', async (event, token: unknown, value: unknown) => {
    assertTrustedIPC(event)
    const transferToken = assertString(token, 'Transfer token', 64)
    if (!(value instanceof Uint8Array)) throw new TypeError('Incoming file data must be a byte array.')
    await incomingFileStore.write(transferToken, value)
  })
  ipcMain.handle('files:finish-incoming', async (event, token: unknown, hash: unknown) => {
    assertTrustedIPC(event)
    return incomingFileStore.finish(assertString(token, 'Transfer token', 64), assertString(hash, 'SHA-256', 64))
  })
  ipcMain.handle('files:cancel-incoming', async (event, token: unknown) => {
    assertTrustedIPC(event)
    await incomingFileStore.cancel(assertString(token, 'Transfer token', 64))
  })
  ipcMain.handle('capture:arm', (event, value: unknown) => {
    assertTrustedIPC(event)
    if (!value || typeof value !== 'object') throw new TypeError('Capture request is invalid.')
    const request = value as { sessionId?: unknown; audio?: unknown }
    const sessionId = assertSessionId(request.sessionId)
    if (typeof request.audio !== 'boolean') throw new TypeError('Capture request is invalid.')
    const approved = approvedSessions.get(sessionId)
    if (!approved?.has('view')) throw new Error('Screen capture is available only for an approved session.')
    if (request.audio && (!approved.has('audio') || !audioLoopbackSupported())) {
      throw new Error('System audio was not approved for this session on this platform.')
    }
    activeCapture = null
    captureArm = { sessionId, audio: request.audio, until: Date.now() + CAPTURE_ARM_MS }
  })
  ipcMain.handle('input:start', (event, value: unknown) => {
    assertTrustedIPC(event)
    const sessionId = assertSessionId(value)
    if (!approvedSessions.get(sessionId)?.has('input')) throw new Error('Remote keyboard and mouse were not approved for this session.')
    if (!activeCapture || activeCapture.sessionId !== sessionId) throw new Error('Start screen sharing for this session before enabling remote control.')
    const capturedId = activeCapture.displayId
    const display = screen.getAllDisplays().find(candidate => String(candidate.id) === capturedId)
    if (!display) throw new Error('The shared display could not be matched to a physical display, so remote control was not enabled.')
    inputControllerOrThrow().start(sessionId, { bounds: display.bounds, scaleFactor: display.scaleFactor })
  })
  ipcMain.handle('input:inject', (event, value: unknown) => {
    assertTrustedIPC(event)
    if (!inputController?.active) throw new Error('Remote control is not active.')
    if (!parseRemoteInputMessage(value)) throw new TypeError('Remote input message is invalid.')
    inputController.inject(value)
  })
  ipcMain.handle('input:stop', (event, value: unknown) => {
    assertTrustedIPC(event)
    stopRemoteInputFor(assertSessionId(value))
  })
  ipcMain.handle('capture:open-settings', async event => {
    assertTrustedIPC(event)
    if (process.platform !== 'darwin') throw new Error('Open screen-capture permissions in your operating system settings. This shortcut is available on macOS only.')
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  })
  ipcMain.handle('system:get-capabilities', event => {
    assertTrustedIPC(event)
    return getCapabilities()
  })
  ipcMain.handle('project:open', async event => {
    assertTrustedIPC(event)
    await shell.openExternal(PROJECT_URL)
  })
}

function getAppIcon(): Electron.NativeImage | undefined {
  const candidateDirs = [
    join(currentDir, '../../build'),
    join(app.getAppPath(), 'build'),
    join(process.resourcesPath, 'build'),
    process.resourcesPath
  ]
  const candidateFiles = process.platform === 'win32'
    ? ['icon.ico', 'icon.png']
    : process.platform === 'darwin'
      ? ['icon.png', 'icon.icns']
      : ['icon.png', 'icons/256x256.png', 'icons/128x128.png']

  for (const dir of candidateDirs) {
    for (const file of candidateFiles) {
      const fullPath = join(dir, file)
      if (existsSync(fullPath)) {
        try {
          const img = nativeImage.createFromPath(fullPath)
          if (!img.isEmpty()) return img
        } catch { /* Try next candidate */ }
      }
    }
  }
  return undefined
}

function getAppIconPath(): string | undefined {
  const buildDir = join(currentDir, '../../build')
  if (process.platform === 'darwin') {
    const icns = join(buildDir, 'icon.icns')
    if (existsSync(icns)) return icns
  }
  if (process.platform === 'win32') {
    const ico = join(buildDir, 'icon.ico')
    if (existsSync(ico)) return ico
  }
  const png = join(buildDir, 'icon.png')
  if (existsSync(png)) return png
  return undefined
}

function setupApplicationMenu(): void {
  if (process.platform === 'darwin') {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'G1Viewer',
        submenu: [
          { role: 'about', label: 'About G1Viewer' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide', label: 'Hide G1Viewer' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: 'Quit G1Viewer' }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'front' }
        ]
      }
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }
}

function createWindow(): void {
  const { size } = screen.getPrimaryDisplay()
  const width = Math.min(1536, size.width)
  const height = Math.min(1024, size.height)
  const appIcon = getAppIcon()
  if (process.platform === 'darwin' && app.dock && appIcon) {
    try {
      app.dock.setIcon(appIcon)
    } catch { /* Dock icon update is best-effort. */ }
  }
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(900, width),
    minHeight: Math.min(640, height),
    center: true,
    frame: false,
    resizable: true,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#09111d',
    title: 'G1Viewer',
    icon: appIcon ?? getAppIconPath(),
    webPreferences: {
      preload: join(currentDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.maximize()
  })
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-changed', mainWindow?.isFullScreen() ?? false))
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('window:maximized-changed', true))
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('window:maximized-changed', mainWindow?.isMaximized() ?? false))
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, targetURL) => {
    const devURL = process.env.ELECTRON_RENDERER_URL
    if (devURL) {
      try {
        if (new URL(targetURL).origin === new URL(devURL).origin) return
      } catch { /* Reject malformed navigation. */ }
    }
    if (!targetURL.startsWith('file://')) event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(currentDir, '../renderer/index.html'))
  // Keys and buttons held through G1Viewer must never outlive the window that is driving them.
  mainWindow.webContents.on('render-process-gone', () => {
    releaseRemoteInput()
    captureArm = null
    approvedSessions.clear()
  })
  mainWindow.on('closed', () => {
    releaseRemoteInput()
    captureArm = null
    approvedSessions.clear()
    mainWindow = null
  })
}

app.setName('G1Viewer')
if (process.platform === 'win32') {
  app.setAppUserModelId('com.urstrulyg1.g1viewer')
}

app.whenReady().then(() => {
  setupApplicationMenu()
  registerIpcHandlers()
  installPermissionPolicy()
  installDisplayCaptureHandler()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('before-quit', event => {
  captureArm = null
  approvedSessions.clear()
  releaseRemoteInput()
  if (autoSignalingManager) {
    void autoSignalingManager.stop()
    autoSignalingManager = null
  }
  if (quitCleanupComplete) return
  event.preventDefault()
  if (quitCleanupPromise) return
  quitCleanupPromise = incomingFileStore.closeAll()
    .catch(error => console.error('Could not clean up an incomplete incoming file transfer.', error))
    .finally(() => {
      quitCleanupComplete = true
      app.quit()
    })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
