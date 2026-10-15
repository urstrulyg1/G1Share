import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
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
  randomBytes,
  randomUUID,
  sign as signMessage,
  verify as verifySignature
} from 'node:crypto'
import { readFile, rename, unlink, writeFile, mkdir, chmod } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostname } from 'node:os'
import type { DeviceInfo, DeviceSummary, DesktopCapabilities, IncomingFileHandle, IncomingFileRequest, OpenDeskBridge, PeerSignalVerification, RemoteSession, SessionDecisionRequest, SessionPermission, SignalingRequest, TrustedDevice } from '../shared/types'
import { isSessionPermission, permissionLabel, SESSION_PERMISSIONS } from '../shared/permissions'
import { parseRemoteInputMessage } from '../shared/remote-input'
import { loadLibnutBackend, RemoteInputController, remoteInputSupport } from './remote-input'
import type { InputSupport, NativeInputBackend } from './remote-input'
import { formatDeviceId, isValidDeviceId } from '../shared/device-id'
import { readBoundedResponse } from './http-response'
import { IncomingFileStore } from './incoming-file-store'

const currentDir = dirname(fileURLToPath(import.meta.url))
const PROJECT_URL = 'https://github.com/urstrulyg1/G1Share'
const MAX_SIGNALING_BODY = 512 * 1024
const MAX_SIGNALING_RESPONSE = 1024 * 1024
const MAX_CLIPBOARD_TEXT = 64 * 1024
const settingsPath = () => join(app.getPath('userData'), 'settings.json')
const identityPath = () => join(app.getPath('userData'), 'identity', 'device.json')
const legacyIdentityPath = () => join(app.getPath('userData'), 'identity', 'device-id')
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
  if (!safeStorage.isEncryptionAvailable()) throw new Error('The operating-system credential store is unavailable. Install and unlock your desktop keyring, then restart OpenDesk.')
  const backend = secureStorageBackend()
  if (process.platform === 'linux' && (backend === 'basic_text' || backend === 'unknown')) {
    throw new Error('OpenDesk refuses to store the device key without a real Linux secret store. Install and unlock GNOME Keyring/libsecret or KWallet, then restart.')
  }
  return backend
}

function deriveDeviceId(publicKey: string): string {
  const value = createHash('sha256').update(publicKey, 'utf8').digest().subarray(0, 16).toString('hex')
  return formatDeviceId(value)
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
      if (stored.deviceId.length > 14 && deriveDeviceId(stored.publicKey) !== stored.deviceId) {
        throw new Error('The stored device ID does not match its cryptographic identity. Reset the local identity before reconnecting.')
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
    const legacyPath = legacyIdentityPath()
    await writeFile(legacyPath, identity.deviceId + '\n', { encoding: 'utf8', mode: 0o600 }).catch(() => undefined)
    return { ...identity, privateKey: pair.privateKey }
  })()
  return identityPromise
}

async function fallbackDeviceId(): Promise<string> {
  try {
    const identity: unknown = JSON.parse(await readFile(identityPath(), 'utf8'))
    if (identity && typeof identity === 'object' && 'deviceId' in identity && typeof identity.deviceId === 'string' && isValidDeviceId(identity.deviceId)) return identity.deviceId
  } catch { /* Continue with the older ID file or create a display-only ID. */ }
  try {
    const legacyId = (await readFile(legacyIdentityPath(), 'utf8')).trim().toUpperCase()
    if (isValidDeviceId(legacyId)) return legacyId
  } catch { /* A keyring-less device can still display a non-authorizing local identifier. */ }
  const id = formatDeviceId(randomBytes(16).toString('hex'))
  await mkdir(dirname(legacyIdentityPath()), { recursive: true, mode: 0o700 })
  await writeFile(legacyIdentityPath(), id + '\n', { encoding: 'utf8', mode: 0o600 }).catch(() => undefined)
  return id
}

function cleanDeviceName(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
  return cleaned || 'OpenDesk device'
}

async function getDeviceInfo(): Promise<DeviceInfo> {
  try {
    const identity = await loadSecureIdentity()
    return {
      deviceId: identity.deviceId,
      deviceName: cleanDeviceName(hostname()),
      appVersion: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      identityReady: true,
      identityMessage: 'Device key is stored using the operating-system credential store.',
      secureStorageBackend: secureStorageBackend()
    }
  } catch (error) {
    return {
      deviceId: await fallbackDeviceId(),
      deviceName: cleanDeviceName(hostname()),
      appVersion: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
      identityReady: false,
      identityMessage: error instanceof Error ? error.message : 'Secure device identity is unavailable.',
      secureStorageBackend: secureStorageBackend()
    }
  }
}

function validateSignalingURL(input: string): string {
  if (typeof input !== 'string' || input.length > 512) throw new TypeError('Enter a valid signaling server URL.')
  let parsed: URL
  try { parsed = new URL(input.trim()) } catch { throw new TypeError('Enter a valid signaling server URL.') }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new TypeError('Use an HTTPS origin without a path, query string, or embedded credentials.')
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopback = host === 'localhost' || host === '::1' || host === '127.0.0.1' || /^127(?:\.\d{1,3}){3}$/.test(host)
  if (parsed.protocol === 'http:' && !loopback) throw new TypeError('Remote signaling servers must use HTTPS. Plain HTTP is permitted only for localhost development.')
  return parsed.origin
}

async function loadSettings(): Promise<AppSettings> {
  if (settingsPromise) return settingsPromise
  settingsPromise = (async () => {
    const fallback = process.env.OPENDESK_SIGNALING_URL || 'http://127.0.0.1:8787'
    try {
      const data = JSON.parse(await readFile(settingsPath(), 'utf8')) as { signalingUrl?: unknown }
      if (typeof data.signalingUrl === 'string') return { signalingUrl: validateSignalingURL(data.signalingUrl) }
    } catch { /* First launch uses the loopback development default. */ }
    return { signalingUrl: validateSignalingURL(fallback) }
  })()
  return settingsPromise
}

async function setSignalingURL(value: string): Promise<string> {
  const signalingUrl = validateSignalingURL(value)
  const settings = await loadSettings()
  settings.signalingUrl = signalingUrl
  await atomicWrite(settingsPath(), JSON.stringify(settings, null, 2) + '\n')
  return signalingUrl
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
    if (deriveDeviceId(input.peerPublicKey) !== input.peerDeviceId) return false
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
  const privilegedPath = path === '/api/v1/devices/revoke' || /\/api\/v1\/sessions\/[a-f0-9]{32}\/decision$/.test(path)
  if (!input || (input.method !== 'GET' && input.method !== 'POST') || typeof input.path !== 'string' || !requestPathIsAllowed(input.path) || (privilegedPath && !allowPrivileged)) {
    throw new TypeError('The requested signaling operation is not allowed.')
  }
  if (input.method === 'GET' && input.body !== undefined) throw new TypeError('GET signaling requests cannot include a body.')
  const identity = await loadSecureIdentity()
  const settings = await loadSettings()
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
  return result.value
}

function assertTrustedIPC(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('This operation is available only to the OpenDesk application window.')
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
  try {
    const parsed: unknown = JSON.parse(await readFile(trustedDevicesPath(), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is TrustedDevice => !!entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.fingerprint === 'string' && typeof entry.trustedAt === 'string')
  } catch {
    return []
  }
}

async function trustPeer(peer: { id: string; name: string; publicKey: string }): Promise<boolean> {
  if (!peer || !isValidDeviceId(peer.id)) throw new TypeError('Peer device ID is invalid.')
  const publicKey = assertString(peer.publicKey, 'Peer public key', 128)
  const fingerprint = trustedFingerprint(publicKey)
  if (deriveDeviceId(publicKey) !== peer.id.toUpperCase()) throw new TypeError('Peer device ID does not match its public-key fingerprint.')
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
  await unlink(legacyIdentityPath()).catch(() => undefined)
  identityPromise = null
  return getDeviceInfo()
}

function safeIncomingFilename(value: string): string {
  const name = basename(value.replace(/[\\/]/g, '_')).replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim()
  if (!name || name === '.' || name === '..') return 'received-file'
  return name.slice(0, 240)
}

async function prepareIncomingFile(request: IncomingFileRequest): Promise<IncomingFileHandle | null> {
  const name = safeIncomingFilename(assertString(request?.name, 'File name', 512))
  if (!Number.isSafeInteger(request.size) || request.size < 0 || request.size > 1024 * 1024 * 1024) throw new TypeError('File exceeds the configured 1 GiB transfer limit.')
  const prompt = await dialog.showMessageBox(mainWindow!, {
    type: 'question', title: 'Incoming file transfer',
    message: `Accept “${name}”?`,
    detail: `The remote user is sending ${formatBytes(request.size)}. Choose a destination. OpenDesk will not overwrite an existing file.`,
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
    detail: 'Clipboard content is sensitive. OpenDesk reads it only after you confirm this action, and never logs the text.',
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
    detail: `The received text is ${formatBytes(Buffer.byteLength(text, 'utf8'))}. OpenDesk will not show or log its contents.`,
    buttons: ['Keep current clipboard', 'Replace clipboard'], cancelId: 0, defaultId: 0, noLink: true
  })
  if (answer.response !== 1) return false
  clipboard.writeText(text)
  return true
}

async function getCapabilities(): Promise<DesktopCapabilities> {
  let screenCapture = 'Electron screen capture API available; permission and source selection are required per session.'
  if (process.platform === 'darwin') {
    try {
      const status = systemPreferences.getMediaAccessStatus('screen')
      screenCapture = status === 'granted' ? 'Screen Recording permission granted.' : `Screen Recording permission: ${status}.`
    } catch {
      screenCapture = 'Screen Recording requires macOS privacy permission; status is not available from this OS version.'
    }
  } else if (process.platform === 'linux') {
    screenCapture = 'Electron capture is available; Wayland requires an active desktop portal/PipeWire picker, while X11 uses the active display session.'
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
        detail: 'Screen sharing starts only after you select a source. OpenDesk never captures in the background.',
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
  ipcMain.handle('system:copy-text', (event, value: unknown) => {
    assertTrustedIPC(event)
    clipboard.writeText(assertString(value, 'Clipboard text', 10000))
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
    if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b1020',
    title: 'OpenDesk',
    webPreferences: {
      preload: join(currentDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
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
  // Keys and buttons held through OpenDesk must never outlive the window that is driving them.
  mainWindow.webContents.on('render-process-gone', () => releaseRemoteInput())
  mainWindow.on('closed', () => {
    releaseRemoteInput()
    captureArm = null
    mainWindow = null
  })
}

app.whenReady().then(() => {
  registerIpcHandlers()
  installPermissionPolicy()
  installDisplayCaptureHandler()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('before-quit', event => {
  captureArm = null
  releaseRemoteInput()
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
