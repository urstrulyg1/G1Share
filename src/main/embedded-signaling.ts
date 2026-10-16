import http from 'node:http'
import dgram from 'node:dgram'
import os from 'node:os'
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto'
import { normalizeDeviceId } from '../shared/device-id'

export interface ServerEvent {
  sequence: number
  type: string
  sessionId?: string
  session?: unknown
  peer?: unknown
  message?: unknown
}

export interface DeviceRecord {
  id: string
  publicKey: string
  name: string
  platform: string
  appVersion: string
  registeredAt: string
  lastSeenAt: string
  revoked?: boolean
}

export interface SessionRecord {
  id: string
  fromDeviceId: string
  toDeviceId: string
  requestedPermissions: string[]
  permissions: string[]
  status: 'pending' | 'active' | 'rejected' | 'closed'
  createdAt: string
  expiresAt: string
  route?: 'local' | 'lan' | 'wan'
  lanPeerUrl?: string
}

const PROTOCOL_VERSION = 'v1'
const SERVICE_VERSION = '0.2.0'
const WAN_PROTOCOL = 'g1viewer-wan-v1'
const WAN_MAX_CLOCK_SKEW_MS = 2 * 60 * 1000
const WAN_REPLAY_WINDOW_MS = 2 * 60 * 1000
const WAN_MAX_MESSAGE_BYTES = 64 * 1024
const WAN_MAX_REPLAY_ENTRIES = 10_000
const VALID_SESSION_PERMISSIONS = new Set(['view', 'files', 'clipboard', 'input', 'audio'])

function normalizedPermissions(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > VALID_SESSION_PERMISSIONS.size) return null
  if (!value.every((permission): permission is string => typeof permission === 'string' && VALID_SESSION_PERMISSIONS.has(permission))) return null
  const permissions = Array.from(new Set(value))
  return permissions.includes('view') ? permissions : null
}

function deviceIdMatchesPublicKey(deviceId: string, publicKey: string): boolean {
  const normalized = normalizeDeviceId(deviceId)
  const hash = createHash('sha256').update(publicKey, 'utf8').digest()
  const numeric = (hash.readBigUInt64BE(0) % 900_000_000n + 100_000_000n).toString()
  const modern = `${numeric.slice(0, 3)}-${numeric.slice(3, 6)}-${numeric.slice(6, 9)}`
  if (modern === normalized) return true
  const legacy = hash.subarray(0, 16).toString('hex').toUpperCase()
  if (legacy.match(/.{8}/g)!.join('-') === normalized) return true
  return legacy.slice(0, 12).match(/.{4}/g)!.join('-') === normalized
}

interface SignedWanEnvelope {
  protocol: string
  fromDeviceId: string
  publicKey: string
  issuedAt: number
  nonce: string
  payload: WanRelayMessage
  signature: string
}

function wanCanonical(envelope: Omit<SignedWanEnvelope, 'signature' | 'publicKey'>): Buffer {
  const payload = JSON.stringify(envelope.payload)
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex')
  return Buffer.from(`${envelope.protocol}\n${envelope.fromDeviceId}\n${envelope.issuedAt}\n${envelope.nonce}\n${digest}`, 'utf8')
}
const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
  'stun:stun.cloudflare.com:3478'
]

export function deriveWanTopic(deviceId: string): string {
  const clean = normalizeDeviceId(deviceId).replace(/[^0-9A-Za-z]/g, '')
  const hash = createHash('sha256').update(`g1viewer-wan-v1:${clean}`).digest('hex').slice(0, 24)
  return `g1v_wan_${hash}`
}

export class EmbeddedSignalingBroker {
  private devices = new Map<string, DeviceRecord>()
  private sessions = new Map<string, SessionRecord>()
  private events = new Map<string, ServerEvent[]>()
  private sequences = new Map<string, number>()
  private challenges = new Map<string, { deviceId: string; expiresAt: number }>()
  private eventWaiters = new Map<string, Set<(event: ServerEvent) => void>>()

  issueChallenge(deviceId: string): { nonce: string; protocolVersion: string; expiresAt: string } {
    const nonce = randomBytes(32).toString('hex')
    const expiresAtMs = Date.now() + 60_000
    this.challenges.set(nonce, { deviceId, expiresAt: expiresAtMs })
    return { nonce, protocolVersion: PROTOCOL_VERSION, expiresAt: new Date(expiresAtMs).toISOString() }
  }

  consumeChallenge(nonce: string, deviceId: string): boolean {
    const record = this.challenges.get(nonce)
    if (!record) return false
    this.challenges.delete(nonce)
    if (record.deviceId !== deviceId || Date.now() > record.expiresAt) return false
    return true
  }

  verifyRequest(
    method: string,
    path: string,
    bodyText: string,
    deviceId: string,
    nonce: string,
    signatureBase64url: string,
    registrationPublicKey?: string
  ): boolean {
    if (!this.consumeChallenge(nonce, deviceId)) return false

    let pubKeyB64 = registrationPublicKey
    if (!pubKeyB64) {
      const record = this.devices.get(deviceId)
      if (!record || record.revoked) return false
      pubKeyB64 = record.publicKey
    }

    try {
      const rawPub = Buffer.from(pubKeyB64, 'base64url')
      if (rawPub.length !== 32) return false
      const sig = Buffer.from(signatureBase64url, 'base64url')
      if (sig.length !== 64) return false

      const digest = createHash('sha256').update(bodyText, 'utf8').digest('hex')
      const canonical = `opendesk-signaling-v1\n${method}\n${path}\n${digest}\n${nonce}`

      const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawPub])
      const keyObj = createPublicKey({ key: spki, format: 'der', type: 'spki' })
      return verify(null, Buffer.from(canonical, 'utf8'), keyObj, sig)
    } catch {
      return false
    }
  }

  registerDevice(id: string, publicKey: string, name: string, platform: string, appVersion: string): DeviceRecord {
    const now = new Date().toISOString()
    const existing = this.devices.get(id)
    if (existing) {
      existing.name = name || existing.name
      existing.platform = platform || existing.platform
      existing.appVersion = appVersion || existing.appVersion
      existing.lastSeenAt = now
      return existing
    }
    const record: DeviceRecord = { id, publicKey, name, platform, appVersion, registeredAt: now, lastSeenAt: now }
    this.devices.set(id, record)
    return record
  }

  touchDevice(id: string): boolean {
    const record = this.devices.get(id)
    if (!record || record.revoked) return false
    record.lastSeenAt = new Date().toISOString()
    return true
  }

  getDeviceSummary(id: string): (DeviceRecord & { online: boolean }) | null {
    const record = this.devices.get(id)
    if (!record || record.revoked) return null
    const online = Date.now() - new Date(record.lastSeenAt).getTime() < 60_000
    return { ...record, online }
  }

  listOnlineDevices(): (DeviceRecord & { online: boolean })[] {
    const now = Date.now()
    const list: (DeviceRecord & { online: boolean })[] = []
    for (const record of this.devices.values()) {
      if (!record.revoked) {
        const online = now - new Date(record.lastSeenAt).getTime() < 60_000
        list.push({ ...record, online })
      }
    }
    return list
  }

  renameDevice(id: string, name: string): DeviceRecord | null {
    const record = this.devices.get(id)
    if (!record || record.revoked) return null
    record.name = name
    record.lastSeenAt = new Date().toISOString()
    return record
  }

  revokeDevice(id: string): boolean {
    const record = this.devices.get(id)
    if (!record) return false
    record.revoked = true
    return true
  }

  createSession(fromDeviceId: string, toDeviceId: string, requestedPermissions: string[]): { session: SessionRecord; peer: DeviceRecord & { online: boolean } } | null {
    const validatedPermissions = normalizedPermissions(requestedPermissions)
    if (!validatedPermissions || fromDeviceId === toDeviceId) return null
    const toDevice = this.getDeviceSummary(toDeviceId)
    if (!toDevice || !toDevice.online) return null
    const fromDevice = this.getDeviceSummary(fromDeviceId)
    if (!fromDevice) return null

    const sessionId = randomBytes(16).toString('hex')
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 90_000).toISOString()

    const session: SessionRecord = {
      id: sessionId,
      fromDeviceId,
      toDeviceId,
      requestedPermissions: validatedPermissions,
      permissions: [],
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt
    }
    this.sessions.set(sessionId, session)

    this.pushEvent(toDeviceId, {
      type: 'session.request',
      sessionId,
      session,
      peer: fromDevice
    })

    return { session, peer: toDevice }
  }

  getSession(sessionId: string): SessionRecord | null {
    return this.sessions.get(sessionId) || null
  }

  getSessionDetails(sessionId: string, actorDeviceId: string): { session: SessionRecord; peer: DeviceRecord & { online: boolean } } | null {
    const session = this.sessions.get(sessionId)
    if (!session || (session.fromDeviceId !== actorDeviceId && session.toDeviceId !== actorDeviceId)) return null
    const peerId = session.fromDeviceId === actorDeviceId ? session.toDeviceId : session.fromDeviceId
    const peer = this.getDeviceSummary(peerId)
    return peer ? { session, peer } : null
  }

  decideSession(sessionId: string, actorDeviceId: string, accepted: boolean, permissions: string[]): SessionRecord | null {
    const session = this.sessions.get(sessionId)
    if (!session || session.toDeviceId !== actorDeviceId || session.status !== 'pending' || Date.parse(session.expiresAt) <= Date.now()) return null

    const grantedPermissions = accepted ? normalizedPermissions(permissions) : []
    if (accepted && (!grantedPermissions || grantedPermissions.some(permission => !session.requestedPermissions.includes(permission)))) return null
    const toDevice = this.getDeviceSummary(actorDeviceId)
    if (accepted) {
      session.status = 'active'
      session.permissions = grantedPermissions!
      this.pushEvent(session.fromDeviceId, {
        type: 'session.accepted',
        sessionId,
        session,
        peer: toDevice
      })
    } else {
      session.status = 'rejected'
      this.pushEvent(session.fromDeviceId, {
        type: 'session.rejected',
        sessionId
      })
    }
    return session
  }

  forwardSignal(sessionId: string, fromDeviceId: string, message: unknown): boolean {
    const session = this.sessions.get(sessionId)
    if (!session || (session.status !== 'pending' && session.status !== 'active') ||
        Date.parse(session.expiresAt) <= Date.now() ||
        (fromDeviceId !== session.fromDeviceId && fromDeviceId !== session.toDeviceId)) return false
    const destDeviceId = session.fromDeviceId === fromDeviceId ? session.toDeviceId : session.fromDeviceId
    this.pushEvent(destDeviceId, { type: 'signal', sessionId, message })
    return true
  }

  closeSession(sessionId: string, fromDeviceId: string, _reason: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session || (session.status !== 'pending' && session.status !== 'active') ||
        (fromDeviceId !== session.fromDeviceId && fromDeviceId !== session.toDeviceId)) return false
    session.status = 'closed'
    const destDeviceId = session.fromDeviceId === fromDeviceId ? session.toDeviceId : session.fromDeviceId
    this.pushEvent(destDeviceId, { type: 'session.closed', sessionId })
    return true
  }

  closeSessionLocally(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.status = 'closed'
    }
  }

  injectSession(session: SessionRecord): void {
    this.sessions.set(session.id, session)
  }

  registerRemoteDevice(record: DeviceRecord & { online: boolean }): void {
    const existing = this.devices.get(record.id)
    if (existing) {
      existing.name = record.name || existing.name
      existing.platform = record.platform || existing.platform
      existing.appVersion = record.appVersion || existing.appVersion
      existing.lastSeenAt = new Date().toISOString()
      return
    }
    this.devices.set(record.id, {
      id: record.id,
      publicKey: record.publicKey,
      name: record.name,
      platform: record.platform,
      appVersion: record.appVersion,
      registeredAt: record.registeredAt || new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    })
  }

  pushEvent(targetDeviceId: string, eventData: Omit<ServerEvent, 'sequence'>): void {
    const seq = (this.sequences.get(targetDeviceId) || 0) + 1
    this.sequences.set(targetDeviceId, seq)
    const event: ServerEvent = { ...eventData, sequence: seq }

    let list = this.events.get(targetDeviceId)
    if (!list) {
      list = []
      this.events.set(targetDeviceId, list)
    }
    list.push(event)
    if (list.length > 256) list.splice(0, list.length - 256)

    const waiters = this.eventWaiters.get(targetDeviceId)
    if (waiters && waiters.size > 0) {
      for (const waiter of waiters) {
        waiter(event)
      }
      waiters.clear()
    }
  }

  pollEvents(
    deviceId: string,
    cursor: number,
    limit: number,
    timeoutMs: number
  ): Promise<{ events: ServerEvent[]; cursor: number; overflow: boolean }> {
    const list = this.events.get(deviceId) || []
    const pending = list.filter(e => e.sequence > cursor).slice(0, limit)

    if (pending.length > 0) {
      const maxSeq = pending[pending.length - 1].sequence
      return Promise.resolve({ events: pending, cursor: maxSeq, overflow: false })
    }

    if (timeoutMs <= 0) {
      return Promise.resolve({ events: [], cursor, overflow: false })
    }

    return new Promise(resolve => {
      let waiters = this.eventWaiters.get(deviceId)
      if (!waiters) {
        waiters = new Set()
        this.eventWaiters.set(deviceId, waiters)
      }

      let timer: ReturnType<typeof setTimeout> | null = null
      const listener = (event: ServerEvent) => {
        if (timer) clearTimeout(timer)
        resolve({ events: [event], cursor: event.sequence, overflow: false })
      }

      timer = setTimeout(() => {
        const set = this.eventWaiters.get(deviceId)
        if (set) set.delete(listener)
        resolve({ events: [], cursor, overflow: false })
      }, timeoutMs)

      waiters.add(listener)
    })
  }
}

export function createSignalingHttpServer(broker: EmbeddedSignalingBroker, manager?: AutoSignalingManager): http.Server {
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname

    const readBody = async (): Promise<string> => {
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let total = 0
        req.on('data', chunk => {
          total += chunk.length
          if (total > 512 * 1024) {
            reject(new Error('Request body too large'))
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
    }

    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200)
      res.end(JSON.stringify({ status: 'ok', service: 'opendesk-signaling', version: SERVICE_VERSION }))
      return
    }

    if (req.method === 'GET' && path === '/readyz') {
      res.writeHead(200)
      res.end(JSON.stringify({ status: 'ready', service: 'opendesk-signaling', version: SERVICE_VERSION }))
      return
    }

    if (req.method === 'GET' && path === '/api/v1/coordinator') {
      res.writeHead(200)
      res.end(JSON.stringify({
        status: 'ready',
        service: 'opendesk-signaling',
        version: SERVICE_VERSION,
        isCoordinator: manager ? manager.getIsCoordinator() : true,
        activeUrl: manager ? manager.getActiveUrl() : 'http://127.0.0.1:8787'
      }))
      return
    }

    if (req.method === 'POST' && path === '/api/v1/challenge') {
      try {
        const bodyText = await readBody()
        const data = bodyText ? JSON.parse(bodyText) as { deviceId?: string } : {}
        if (!data.deviceId) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: { code: 'missing_device_id', message: 'Device ID required.' } }))
          return
        }
        const challenge = broker.issueChallenge(data.deviceId)
        res.writeHead(200)
        res.end(JSON.stringify(challenge))
      } catch (err) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: { code: 'bad_request', message: String(err) } }))
      }
      return
    }

    // Authenticated API routes
    const deviceId = req.headers['x-od-device-id'] as string | undefined
    const nonce = req.headers['x-od-nonce'] as string | undefined
    const signature = req.headers['x-od-signature'] as string | undefined

    if (!deviceId || !nonce || !signature) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'Authentication required.' } }))
      return
    }

    let bodyText = ''
    try {
      bodyText = await readBody()
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: { code: 'bad_request', message: 'Failed to read request body.' } }))
      return
    }

    let registrationPublicKey: string | undefined
    if (path === '/api/v1/devices/register' && req.method === 'POST') {
      try {
        const parsed = JSON.parse(bodyText) as { publicKey?: string }
        registrationPublicKey = parsed.publicKey
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({ error: { code: 'bad_request', message: 'Malformed registration.' } }))
        return
      }
    }

    const fullPathWithQuery = (req.url || '/')
    if (!broker.verifyRequest(req.method || 'GET', fullPathWithQuery, bodyText, deviceId, nonce, signature, registrationPublicKey)) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: { code: 'invalid_signature', message: 'Request verification failed.' } }))
      return
    }

    broker.touchDevice(deviceId)

    // Handlers
    if (req.method === 'POST' && path === '/api/v1/devices/register') {
      const data = JSON.parse(bodyText) as { id: string; publicKey: string; name: string; platform: string; appVersion: string }
      const device = broker.registerDevice(data.id, data.publicKey, data.name, data.platform, data.appVersion)
      if (manager) {
        manager.setLocalDevice(device)
      }
      res.writeHead(200)
      res.end(JSON.stringify({ ...device, online: true }))
      return
    }

    if (req.method === 'POST' && path === '/api/v1/devices/heartbeat') {
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, serverTime: new Date().toISOString() }))
      return
    }

    if (req.method === 'GET' && path === '/api/v1/devices/me') {
      const device = broker.getDeviceSummary(deviceId)
      if (!device) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: { code: 'not_found', message: 'Device not found.' } }))
        return
      }
      res.writeHead(200)
      res.end(JSON.stringify(device))
      return
    }

    if (req.method === 'GET' && path === '/api/v1/devices') {
      const devices = manager ? await manager.listAllOnlineDevices() : broker.listOnlineDevices()
      res.writeHead(200)
      res.end(JSON.stringify({ devices }))
      return
    }

    if (req.method === 'GET' && path.startsWith('/api/v1/devices/')) {
      const targetId = path.slice('/api/v1/devices/'.length)
      let device = broker.getDeviceSummary(targetId)
      if (!device && manager) {
        device = await manager.findDeviceAcrossPeers(targetId)
      }
      if (!device) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: { code: 'not_found', message: 'Target device not found.' } }))
        return
      }
      res.writeHead(200)
      res.end(JSON.stringify(device))
      return
    }

    if (req.method === 'POST' && path === '/api/v1/devices/rename') {
      const data = JSON.parse(bodyText) as { name: string }
      const device = broker.renameDevice(deviceId, data.name)
      if (manager && device) {
        manager.setLocalDevice(device)
      }
      res.writeHead(200)
      res.end(JSON.stringify(device))
      return
    }

    if (req.method === 'POST' && path === '/api/v1/devices/revoke') {
      broker.revokeDevice(deviceId)
      res.writeHead(200)
      res.end(JSON.stringify({ revoked: true }))
      return
    }

    if (req.method === 'POST' && path === '/api/v1/sessions') {
      const data = JSON.parse(bodyText) as { toDeviceId: string; permissions: string[] }
      let result = broker.createSession(deviceId, data.toDeviceId, data.permissions || ['view'])
      if (!result && manager) {
        result = await manager.createSessionAcrossNetwork(deviceId, data.toDeviceId, data.permissions || ['view'])
      }
      if (!result) {
        res.writeHead(409)
        res.end(JSON.stringify({ error: { code: 'device_offline', message: 'The target device is offline.' } }))
        return
      }
      res.writeHead(201)
      res.end(JSON.stringify(result))
      return
    }

    if (req.method === 'GET' && path.startsWith('/api/v1/sessions/')) {
      const sessionId = path.split('/')[4]
      const details = broker.getSessionDetails(sessionId, deviceId)
      if (!details) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: { code: 'not_found', message: 'Session not found.' } }))
        return
      }
      res.writeHead(200)
      res.end(JSON.stringify(details))
      return
    }

    const decisionMatch = path.match(/^\/api\/v1\/sessions\/([a-f0-9]{32})\/decision$/)
    if (req.method === 'POST' && decisionMatch) {
      const sessionId = decisionMatch[1]
      const data = JSON.parse(bodyText) as { accepted: boolean; permissions: string[] }
      const session = broker.decideSession(sessionId, deviceId, data.accepted, data.permissions || ['view'])
      if (!session) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: { code: 'invalid_session', message: 'Session not available.' } }))
        return
      }
      if (manager) {
        void manager.handleSessionDecision(session, deviceId, data.accepted, data.permissions || ['view'])
      }
      res.writeHead(200)
      res.end(JSON.stringify(session))
      return
    }

    const signalMatch = path.match(/^\/api\/v1\/sessions\/([a-f0-9]{32})\/signal$/)
    if (req.method === 'POST' && signalMatch) {
      const sessionId = signalMatch[1]
      const data = JSON.parse(bodyText) as { message: unknown }
      const ok = broker.forwardSignal(sessionId, deviceId, data.message)
      if (!ok) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: { code: 'invalid_session', message: 'Could not forward signal.' } }))
        return
      }
      const session = broker.getSession(sessionId)!
      if (manager && session) {
        void manager.forwardSignal(session, deviceId, data.message)
      }
      res.writeHead(200)
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    const closeMatch = path.match(/^\/api\/v1\/sessions\/([a-f0-9]{32})\/close$/)
    if (req.method === 'POST' && closeMatch) {
      const sessionId = closeMatch[1]
      const data = bodyText ? JSON.parse(bodyText) as { reason?: string } : {}
      const closed = broker.closeSession(sessionId, deviceId, data.reason || 'user closed')
      if (!closed) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: { code: 'invalid_session', message: 'Session not available to this device.' } }))
        return
      }
      const session = broker.getSession(sessionId)
      if (manager && session) {
        void manager.closeSession(session, deviceId, data.reason || 'user closed')
      }
      res.writeHead(200)
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    if (req.method === 'GET' && path === '/api/v1/events') {
      const cursor = parseInt(url.searchParams.get('cursor') || '0', 10) || 0
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 50)
      const batch = await broker.pollEvents(deviceId, cursor, limit, 20_000)
      res.writeHead(200)
      res.end(JSON.stringify(batch))
      return
    }

    if (req.method === 'GET' && path === '/api/v1/ice') {
      const stunList = [...DEFAULT_STUN_URLS]
      const envStun = (process.env.G1VIEWER_STUN_URLS || process.env.OPENDESK_STUN_URLS)?.trim()
      if (envStun) {
        for (const u of envStun.split(',')) {
          const t = u.trim()
          if (t && !stunList.includes(t)) stunList.push(t)
        }
      }
      const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
        { urls: stunList }
      ]
      const envTurn = (process.env.G1VIEWER_TURN_URLS || process.env.OPENDESK_TURN_URLS)?.trim()
      if (envTurn) {
        const turnUrls = envTurn.split(',').map(s => s.trim()).filter(Boolean)
        const username = (process.env.G1VIEWER_TURN_USERNAME || process.env.OPENDESK_TURN_USERNAME || '').trim()
        const credential = (process.env.G1VIEWER_TURN_CREDENTIAL || process.env.OPENDESK_TURN_CREDENTIAL || '').trim()
        // Never publish static/default TURN credentials. If credentials are missing, keep STUN
        // available and omit TURN rather than silently shipping a shared public credential.
        if (turnUrls.length > 0 && username && credential) {
          iceServers.push({ urls: turnUrls, username, credential })
        }
      }
      res.writeHead(200)
      res.end(JSON.stringify({ iceServers }))
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'Endpoint not found.' } }))
  })
}

export function getLanIpv4Addresses(): string[] {
  const addresses: string[] = []
  const ifaces = os.networkInterfaces()
  const names = Object.keys(ifaces).sort((a, b) => {
    const isVirtualA = /docker|vbox|vmnet|tailscale|utun|tun|tap|virbr|bridge/i.test(a)
    const isVirtualB = /docker|vbox|vmnet|tailscale|utun|tun|tap|virbr|bridge/i.test(b)
    if (isVirtualA && !isVirtualB) return 1
    if (!isVirtualA && isVirtualB) return -1
    return 0
  })
  for (const name of names) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (!iface.address.startsWith('169.254.')) {
          addresses.push(iface.address)
        }
      }
    }
  }
  return addresses
}

export function getSubnetBroadcastAddresses(): string[] {
  const broadcasts: string[] = ['127.0.0.1', '255.255.255.255']
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && iface.netmask) {
        try {
          const ipParts = iface.address.split('.').map(Number)
          const maskParts = iface.netmask.split('.').map(Number)
          if (ipParts.length === 4 && maskParts.length === 4) {
            const bcastParts = ipParts.map((b, i) => (b | (~maskParts[i] & 255)))
            broadcasts.push(bcastParts.join('.'))
          }
        } catch { /* ignore */ }
      }
    }
  }
  return Array.from(new Set(broadcasts))
}

export interface WanRelayMessage {
  action: 'query' | 'device_info' | 'session_request' | 'session_decision' | 'signal' | 'session_close'
  fromDeviceId?: string
  toDeviceId?: string
  replyTopic?: string
  device?: DeviceRecord & { online: boolean }
  sessionId?: string
  session?: SessionRecord
  peer?: unknown
  accepted?: boolean
  permissions?: string[]
  message?: unknown
  reason?: string
}

export class WanRelayBridge {
  private localDeviceId: string | null = null
  private localSummary: (DeviceRecord & { online: boolean }) | null = null
  private localPrivateKey: ReturnType<typeof createPrivateKey> | null = null
  private ws: WebSocket | null = null
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pendingQueries = new Map<string, (device: (DeviceRecord & { online: boolean }) | null) => void>()
  private remoteDevicesCache = new Map<string, DeviceRecord & { online: boolean }>()
  private seenNonces = new Map<string, number>()
  private relayBaseUrl = (process.env.G1VIEWER_RELAY_URL || process.env.OPENDESK_RELAY_URL || 'https://ntfy.sh').replace(/\/+$/, '')

  constructor(
    private readonly broker: EmbeddedSignalingBroker,
    private readonly manager: AutoSignalingManager
  ) {}

  setLocalDevice(device: DeviceRecord): void {
    const normalized = normalizeDeviceId(device.id)
    this.localDeviceId = normalized
    this.localSummary = { ...device, id: normalized, online: true }
    this.ensureConnected()
  }

  setSigningKey(privateKey: ReturnType<typeof createPrivateKey> | null): void {
    this.localPrivateKey = privateKey
  }

  private verifyEnvelope(value: unknown): value is SignedWanEnvelope {
    if (!value || typeof value !== 'object') return false
    const envelope = value as Partial<SignedWanEnvelope>
    if (envelope.protocol !== WAN_PROTOCOL || typeof envelope.fromDeviceId !== 'string' ||
        typeof envelope.publicKey !== 'string' || typeof envelope.issuedAt !== 'number' ||
        !Number.isSafeInteger(envelope.issuedAt) || Math.abs(Date.now() - envelope.issuedAt) > WAN_MAX_CLOCK_SKEW_MS ||
        typeof envelope.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(envelope.nonce) ||
        typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature) ||
        !envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) return false
    const fromDeviceId = normalizeDeviceId(envelope.fromDeviceId)
    if (!fromDeviceId || !deviceIdMatchesPublicKey(fromDeviceId, envelope.publicKey)) return false
    if (envelope.payload.fromDeviceId && normalizeDeviceId(envelope.payload.fromDeviceId) !== fromDeviceId) return false
    const payloadText = JSON.stringify(envelope.payload)
    if (Buffer.byteLength(payloadText, 'utf8') > WAN_MAX_MESSAGE_BYTES) return false
    try {
      const rawKey = Buffer.from(envelope.publicKey, 'base64url')
      const signature = Buffer.from(envelope.signature, 'base64url')
      if (rawKey.length !== 32 || rawKey.toString('base64url') !== envelope.publicKey ||
          signature.length !== 64 || signature.toString('base64url') !== envelope.signature) return false
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), type: 'spki', format: 'der' })
      const canonical = wanCanonical({
        protocol: envelope.protocol,
        fromDeviceId,
        issuedAt: envelope.issuedAt,
        nonce: envelope.nonce,
        payload: envelope.payload
      })
      if (!verify(null, canonical, key, signature)) return false
    } catch {
      return false
    }

    const now = Date.now()
    for (const [key, seenAt] of this.seenNonces) {
      if (now - seenAt > WAN_REPLAY_WINDOW_MS) this.seenNonces.delete(key)
    }
    const replayKey = `${fromDeviceId}:${envelope.nonce}`
    if (this.seenNonces.has(replayKey)) return false
    if (this.seenNonces.size >= WAN_MAX_REPLAY_ENTRIES) return false
    this.seenNonces.set(replayKey, now)
    return true
  }

  ensureConnected(): void {
    if (this.stopped || !this.localDeviceId) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    try {
      const topic = deriveWanTopic(this.localDeviceId)
      const wsUrl = this.relayBaseUrl.replace(/^http/i, 'ws') + `/${topic}/ws`
      this.ws = new WebSocket(wsUrl)

      this.ws.onmessage = (event) => {
        this.handleIncomingRawMessage(event.data)
      }

      this.ws.onerror = () => {
        // Suppress unhandled WebSocket error
      }

      this.ws.onclose = () => {
        this.ws = null
        if (!this.stopped) {
          this.scheduleReconnect()
        }
      }
    } catch {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.ensureConnected()
    }, 5000)
  }

  private handleIncomingRawMessage(rawData: unknown): void {
    try {
      const text = typeof rawData === 'string' ? rawData : String(rawData)
      const envelope = JSON.parse(text) as { event?: string; message?: string }
      if (envelope.event !== 'message' || !envelope.message) return

      const signed = JSON.parse(envelope.message) as unknown
      if (!this.verifyEnvelope(signed)) return
      this.handleRelayMessage(signed.payload, signed.publicKey)
    } catch {
      // ignore parse errors
    }
  }

  private handleRelayMessage(payload: WanRelayMessage, signerPublicKey: string): void {
    if (!payload || typeof payload.action !== 'string') return

    if (payload.action === 'query') {
      if (this.localDeviceId && this.localSummary) {
        const dest = payload.fromDeviceId ? normalizeDeviceId(payload.fromDeviceId) : null
        if (dest) {
          void this.publishToDevice(dest, {
            action: 'device_info',
            fromDeviceId: this.localDeviceId,
            toDeviceId: dest,
            device: this.localSummary
          })
        }
      }
      return
    }

    if (payload.action === 'device_info') {
      if (payload.device && payload.device.id && payload.fromDeviceId &&
          normalizeDeviceId(payload.device.id) === normalizeDeviceId(payload.fromDeviceId) &&
          payload.device.publicKey === signerPublicKey && deviceIdMatchesPublicKey(payload.device.id, payload.device.publicKey) &&
          payload.toDeviceId && normalizeDeviceId(payload.toDeviceId) === this.localDeviceId) {
        const dev = { ...payload.device, id: normalizeDeviceId(payload.device.id), online: true }
        this.remoteDevicesCache.set(dev.id, dev)
        this.broker.registerRemoteDevice(dev)
        const waiter = this.pendingQueries.get(dev.id)
        if (waiter) {
          this.pendingQueries.delete(dev.id)
          waiter(dev)
        }
      }
      return
    }

    if (payload.action === 'session_request') {
      if (payload.session && payload.sessionId && /^[a-f0-9]{32}$/.test(payload.sessionId) && payload.fromDeviceId && payload.toDeviceId) {
        const normalizedFrom = normalizeDeviceId(payload.fromDeviceId)
        const normalizedTo = normalizeDeviceId(payload.toDeviceId)
        const permissions = normalizedPermissions(payload.session.requestedPermissions)
        const expiresAt = Date.parse(payload.session.expiresAt)
        if (this.localDeviceId && normalizedTo === this.localDeviceId && normalizedFrom !== normalizedTo &&
            payload.session.id === payload.sessionId && payload.session.fromDeviceId === normalizedFrom &&
            !!payload.peer && typeof payload.peer === 'object' &&
            normalizeDeviceId((payload.peer as DeviceRecord).id) === normalizedFrom &&
            (payload.peer as DeviceRecord).publicKey === signerPublicKey &&
            payload.session.toDeviceId === normalizedTo && permissions && Number.isFinite(expiresAt) &&
            expiresAt > Date.now() && expiresAt <= Date.now() + 90_000) {
          const existing = this.broker.getSession(payload.sessionId)
          if (existing) return
          const session: SessionRecord = {
            ...payload.session,
            requestedPermissions: permissions,
            id: payload.sessionId,
            fromDeviceId: normalizedFrom,
            toDeviceId: normalizedTo,
            permissions: [],
            status: 'pending',
            route: 'wan'
          }
          this.broker.registerRemoteDevice({ ...(payload.peer as DeviceRecord), online: true })
          this.broker.injectSession(session)
          this.broker.pushEvent(normalizedTo, {
            type: 'session.request',
            sessionId: payload.sessionId,
            session,
            peer: payload.peer
          })
        }
      }
      return
    }

    if (payload.action === 'session_decision') {
      if (payload.sessionId && /^[a-f0-9]{32}$/.test(payload.sessionId) && payload.toDeviceId && payload.fromDeviceId && typeof payload.accepted === 'boolean') {
        const normalizedFrom = normalizeDeviceId(payload.fromDeviceId)
        const normalizedTo = normalizeDeviceId(payload.toDeviceId)
        const session = this.broker.getSession(payload.sessionId)
        const permissions = payload.accepted ? normalizedPermissions(payload.permissions) : []
        if (this.localDeviceId && normalizedTo === this.localDeviceId && session &&
            session.fromDeviceId === normalizedTo && session.toDeviceId === normalizedFrom &&
            session.status === 'pending' && Date.parse(session.expiresAt) > Date.now() &&
            !!payload.peer && typeof payload.peer === 'object' &&
            normalizeDeviceId((payload.peer as DeviceRecord).id) === normalizedFrom &&
            (payload.peer as DeviceRecord).publicKey === signerPublicKey &&
            (!payload.accepted || (permissions && permissions.every(p => session.requestedPermissions.includes(p))))) {
          const accepted = payload.accepted
          session.status = accepted ? 'active' : 'rejected'
          session.permissions = permissions || []
          this.broker.pushEvent(normalizedTo, {
            type: accepted ? 'session.accepted' : 'session.rejected',
            sessionId: payload.sessionId,
            session,
            peer: payload.peer
          })
        }
      }
      return
    }

    if (payload.action === 'signal') {
      if (payload.sessionId && /^[a-f0-9]{32}$/.test(payload.sessionId) && payload.toDeviceId && payload.fromDeviceId && payload.message) {
        const normalizedFrom = normalizeDeviceId(payload.fromDeviceId)
        const normalizedTo = normalizeDeviceId(payload.toDeviceId)
        const session = this.broker.getSession(payload.sessionId)
        if (this.localDeviceId && normalizedTo === this.localDeviceId && session &&
            (session.status === 'active' || session.status === 'pending') && Date.parse(session.expiresAt) > Date.now() &&
            (session.fromDeviceId === normalizedFrom || session.toDeviceId === normalizedFrom) &&
            (session.fromDeviceId === normalizedTo || session.toDeviceId === normalizedTo) &&
            normalizedFrom !== normalizedTo) {
          this.broker.pushEvent(normalizedTo, {
            type: 'signal',
            sessionId: payload.sessionId,
            message: payload.message
          })
        }
      }
      return
    }

    if (payload.action === 'session_close') {
      if (payload.sessionId && /^[a-f0-9]{32}$/.test(payload.sessionId) && payload.toDeviceId && payload.fromDeviceId) {
        const normalizedFrom = normalizeDeviceId(payload.fromDeviceId)
        const normalizedTo = normalizeDeviceId(payload.toDeviceId)
        const session = this.broker.getSession(payload.sessionId)
        if (this.localDeviceId && normalizedTo === this.localDeviceId && session &&
            (session.status === 'active' || session.status === 'pending') &&
            (session.fromDeviceId === normalizedFrom || session.toDeviceId === normalizedFrom) &&
            (session.fromDeviceId === normalizedTo || session.toDeviceId === normalizedTo) &&
            normalizedFrom !== normalizedTo) {
          this.broker.closeSessionLocally(payload.sessionId)
          this.broker.pushEvent(normalizedTo, {
            type: 'session.closed',
            sessionId: payload.sessionId
          })
        }
      }
      return
    }
  }

  async publishToDevice(targetDeviceId: string, payload: unknown): Promise<boolean> {
    const normalized = normalizeDeviceId(targetDeviceId)
    const localId = this.localDeviceId
    const publicKey = this.localSummary?.publicKey
    const privateKey = this.localPrivateKey
    if (!localId || !publicKey || !privateKey || !deviceIdMatchesPublicKey(localId, publicKey) ||
        !payload || typeof payload !== 'object' || Array.isArray(payload)) return false
    const payloadText = JSON.stringify(payload)
    if (Buffer.byteLength(payloadText, 'utf8') > WAN_MAX_MESSAGE_BYTES) return false
    const issuedAt = Date.now()
    const unsigned = {
      protocol: WAN_PROTOCOL,
      fromDeviceId: localId,
      issuedAt,
      nonce: randomBytes(16).toString('hex'),
      payload: payload as WanRelayMessage
    }
    try {
      const signature = sign(null, wanCanonical(unsigned), privateKey).toString('base64url')
      const envelope: SignedWanEnvelope = { ...unsigned, publicKey, signature }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      try {
        const res = await fetch(`${this.relayBaseUrl}/${deriveWanTopic(normalized)}`, {
          method: 'POST',
          headers: { 'Title': 'G1V', 'Priority': 'high', 'Content-Type': 'application/json' },
          body: JSON.stringify(envelope),
          signal: controller.signal,
          redirect: 'error'
        })
        return res.ok
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return false
    }
  }

  async queryDevice(targetDeviceId: string, timeoutMs = 2500): Promise<(DeviceRecord & { online: boolean }) | null> {
    const normalized = normalizeDeviceId(targetDeviceId)
    const cached = this.remoteDevicesCache.get(normalized)
    if (cached && Date.now() - new Date(cached.lastSeenAt).getTime() < 30_000) {
      return cached
    }

    return new Promise(resolve => {
      let resolved = false
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.pendingQueries.delete(normalized)
          resolve(null)
        }
      }, timeoutMs)

      this.pendingQueries.set(normalized, (dev) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          this.pendingQueries.delete(normalized)
          resolve(dev)
        }
      })

      const myTopic = this.localDeviceId ? deriveWanTopic(this.localDeviceId) : undefined
      void this.publishToDevice(normalized, {
        action: 'query',
        fromDeviceId: this.localDeviceId,
        replyTopic: myTopic
      })
    })
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    this.pendingQueries.clear()
  }
}

export class AutoSignalingManager {
  private broker = new EmbeddedSignalingBroker()
  private server: http.Server | null = null
  private udpSocket: dgram.Socket | null = null
  private serverPort = 8787
  private activeUrl = ''
  private isCoordinator = false
  private stopped = false
  private peerCoordinators = new Set<string>()
  private announceTimer: ReturnType<typeof setInterval> | null = null
  private wanRelay: WanRelayBridge | null = null

  async start(): Promise<string> {
    this.wanRelay = new WanRelayBridge(this.broker, this)

    // 1. Try to start local HTTP server on port 8787, or next available port if taken.
    await this.startHttpServer()

    // 2. Discover if an existing coordinator is already on the LAN or local host.
    const discovered = await this.discoverCoordinator(400)
    if (discovered && !this.isOwnCoordinatorUrl(discovered)) {
      this.activeUrl = discovered
      this.isCoordinator = false
      this.peerCoordinators.add(discovered)
    } else {
      this.activeUrl = `http://127.0.0.1:${this.serverPort}`
      this.isCoordinator = true
    }

    // 3. Start UDP responder so other devices can discover this coordinator.
    this.startUdpListener()

    // 4. Start periodic background announcer & peer discovery.
    this.startBackgroundTasks()

    return this.activeUrl
  }

  setLocalDevice(device: DeviceRecord): void {
    this.wanRelay?.setLocalDevice(device)
  }

  setLocalIdentity(deviceId: string, publicKey: string, name: string, platform: string, appVersion: string, privateKey?: ReturnType<typeof createPrivateKey>): void {
    if (!privateKey || !deviceIdMatchesPublicKey(deviceId, publicKey)) {
      this.wanRelay?.setSigningKey(null)
      return
    }
    const exported = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url')
    if (exported !== publicKey) throw new TypeError('WAN signing key does not match the local public identity.')
    const record = this.broker.registerDevice(deviceId, publicKey, name, platform, appVersion)
    this.wanRelay?.setSigningKey(privateKey)
    this.setLocalDevice(record)
  }

  getActiveUrl(): string {
    return this.activeUrl || `http://127.0.0.1:${this.serverPort}`
  }

  getIsCoordinator(): boolean {
    return this.isCoordinator
  }

  getServerPort(): number {
    return this.serverPort
  }

  getCoordinatorLanUrl(): string {
    const lanIps = getLanIpv4Addresses()
    const ip = lanIps[0] || '127.0.0.1'
    return `http://${ip}:${this.serverPort}`
  }

  isOwnCoordinatorUrl(url: string): boolean {
    try {
      const parsed = new URL(url)
      const port = parseInt(parsed.port || '80', 10)
      if (port === this.serverPort) {
        if (['127.0.0.1', 'localhost', '0.0.0.0'].includes(parsed.hostname)) return true
        const lanIps = getLanIpv4Addresses()
        if (lanIps.includes(parsed.hostname)) return true
      }
    } catch { /* ignore */ }
    return false
  }

  async checkHttpCoordinator(origin: string): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 300)
      const res = await fetch(`${origin}/readyz`, { signal: controller.signal })
      clearTimeout(timer)
      if (res.ok) {
        const body = (await res.json()) as { service?: string }
        return body.service === 'opendesk-signaling'
      }
    } catch {
      // not reachable
    }
    return false
  }

  private async discoverCoordinator(timeoutMs: number): Promise<string | null> {
    if (this.serverPort !== 8787) {
      const isLocalCoordinator = await this.checkHttpCoordinator('http://127.0.0.1:8787')
      if (isLocalCoordinator) return 'http://127.0.0.1:8787'
    }

    const udpFound = await this.probeLanCoordinator(timeoutMs)
    if (udpFound) return udpFound

    return null
  }

  private startHttpServer(): Promise<number> {
    return new Promise(resolve => {
      this.server = createSignalingHttpServer(this.broker, this)

      const tryPort = (port: number) => {
        this.server!.listen(port, '0.0.0.0', () => {
          this.serverPort = port
          resolve(port)
        })
        this.server!.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            if (port === 8787) tryPort(8788)
            else if (port === 8788) tryPort(8790)
            else tryPort(0) // dynamic port fallback
          } else {
            resolve(8787)
          }
        })
      }

      tryPort(8787)
    })
  }

  private probeLanCoordinator(timeoutMs: number): Promise<string | null> {
    return new Promise(resolve => {
      let resolved = false
      let probeSocket: dgram.Socket | null = null
      try {
        probeSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      } catch {
        resolve(null)
        return
      }

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          try { probeSocket?.close() } catch { /* ignore */ }
          resolve(null)
        }
      }, timeoutMs)

      probeSocket.on('message', (msg) => {
        try {
          const text = msg.toString('utf8')
          if (text.startsWith('G1VIEWER_COORDINATOR:')) {
            const url = text.slice('G1VIEWER_COORDINATOR:'.length).trim()
            if (url && !this.isOwnCoordinatorUrl(url) && !resolved) {
              resolved = true
              clearTimeout(timer)
              try { probeSocket?.close() } catch { /* ignore */ }
              resolve(url)
            }
          }
        } catch { /* ignore */ }
      })

      probeSocket.on('error', () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          try { probeSocket?.close() } catch { /* ignore */ }
          resolve(null)
        }
      })

      probeSocket.bind(0, () => {
        try {
          probeSocket?.setBroadcast(true)
          const message = Buffer.from('G1VIEWER_PING')
          const sendPings = () => {
            for (const bcast of getSubnetBroadcastAddresses()) {
              probeSocket?.send(message, 0, message.length, 8789, bcast, () => {})
            }
          }
          sendPings()
          if (timeoutMs > 200) {
            setTimeout(() => { if (!resolved) sendPings() }, 150)
          }
        } catch { /* ignore */ }
      })
    })
  }

  private startUdpListener(): void {
    try {
      this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      this.udpSocket.on('message', (msg, rinfo) => {
        if (this.stopped) return
        const text = msg.toString('utf8').trim()
        if (text === 'G1VIEWER_PING' && this.isCoordinator) {
          const lanUrl = this.getCoordinatorLanUrl()
          const reply = Buffer.from(`G1VIEWER_COORDINATOR:${lanUrl}`)
          this.udpSocket?.send(reply, 0, reply.length, rinfo.port, rinfo.address, () => {})
        } else if (text.startsWith('G1VIEWER_COORDINATOR:')) {
          const url = text.slice('G1VIEWER_COORDINATOR:'.length).trim()
          if (url && !this.isOwnCoordinatorUrl(url)) {
            this.peerCoordinators.add(url)
          }
        }
      })
      this.udpSocket.on('error', () => { /* ignore */ })
      this.udpSocket.bind(8789, '0.0.0.0', () => {
        try { this.udpSocket?.setBroadcast(true) } catch { /* ignore */ }
      })
    } catch { /* ignore */ }
  }

  private startBackgroundTasks(): void {
    if (this.stopped) return
    this.announceTimer = setInterval(() => {
      if (this.stopped) return
      void this.performPeriodicDiscovery()
    }, 10_000)

    setTimeout(() => {
      if (!this.stopped) void this.scanSubnetForCoordinators()
    }, 1500)
  }

  private async performPeriodicDiscovery(): Promise<void> {
    if (this.stopped) return
    try {
      if (this.udpSocket && this.isCoordinator) {
        const lanUrl = this.getCoordinatorLanUrl()
        const announceMsg = Buffer.from(`G1VIEWER_COORDINATOR:${lanUrl}`)
        for (const bcast of getSubnetBroadcastAddresses()) {
          this.udpSocket.send(announceMsg, 0, announceMsg.length, 8789, bcast, () => {})
        }
      }
    } catch { /* ignore */ }

    for (const peerUrl of Array.from(this.peerCoordinators)) {
      const ok = await this.checkHttpCoordinator(peerUrl)
      if (!ok) {
        this.peerCoordinators.delete(peerUrl)
      }
    }
  }

  private async scanSubnetForCoordinators(): Promise<void> {
    const lanIps = getLanIpv4Addresses()
    if (lanIps.length === 0) return
    const selfIps = new Set([...lanIps, '127.0.0.1', 'localhost'])

    for (const lanIp of lanIps) {
      if (this.stopped) return
      const parts = lanIp.split('.')
      if (parts.length !== 4) continue
      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`

      const targetIps: string[] = []
      const hostNum = parseInt(parts[3], 10)
      for (let i = Math.max(1, hostNum - 5); i <= Math.min(254, hostNum + 5); i++) {
        const ip = `${prefix}.${i}`
        if (!selfIps.has(ip)) targetIps.push(ip)
      }
      for (let i = 1; i <= 25; i++) {
        const ip = `${prefix}.${i}`
        if (!selfIps.has(ip) && !targetIps.includes(ip)) targetIps.push(ip)
      }

      for (let i = 0; i < targetIps.length; i += 16) {
        if (this.stopped) return
        const batch = targetIps.slice(i, i + 16)
        await Promise.all(
          batch.map(async ip => {
            const url = `http://${ip}:8787`
            if (this.peerCoordinators.has(url)) return
            const isCoordinator = await this.checkHttpCoordinator(url)
            if (isCoordinator && !this.isOwnCoordinatorUrl(url)) {
              this.peerCoordinators.add(url)
            }
          })
        )
      }
    }
  }

  async listAllOnlineDevices(): Promise<(DeviceRecord & { online: boolean })[]> {
    const local = this.broker.listOnlineDevices()
    const map = new Map<string, DeviceRecord & { online: boolean }>()
    for (const dev of local) map.set(dev.id, dev)

    for (const peerUrl of this.peerCoordinators) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 1000)
        const res = await fetch(`${peerUrl}/api/v1/devices`, {
          headers: { Accept: 'application/json' },
          signal: controller.signal
        })
        clearTimeout(timer)
        if (res.ok) {
          const body = (await res.json()) as { devices?: (DeviceRecord & { online: boolean })[] }
          if (Array.isArray(body?.devices)) {
            for (const dev of body.devices) {
              if (!map.has(dev.id)) map.set(dev.id, dev)
            }
          }
        }
      } catch { /* ignore */ }
    }
    return Array.from(map.values())
  }

  async findDeviceAcrossPeers(targetId: string): Promise<(DeviceRecord & { online: boolean }) | null> {
    const normalized = normalizeDeviceId(targetId)
    const local = this.broker.getDeviceSummary(normalized)
    if (local && local.online) return local

    if (this.peerCoordinators.size === 0) {
      await this.scanSubnetForCoordinators()
    }
    for (const peerUrl of this.peerCoordinators) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 1000)
        const res = await fetch(`${peerUrl}/api/v1/devices/${normalized}`, {
          headers: { Accept: 'application/json' },
          signal: controller.signal
        })
        clearTimeout(timer)
        if (res.ok) {
          const device = (await res.json()) as DeviceRecord & { online: boolean }
          if (device && normalizeDeviceId(device.id) === normalized) {
            this.broker.registerRemoteDevice(device)
            return device
          }
        }
      } catch { /* ignore */ }
    }

    if (this.wanRelay) {
      const wanDevice = await this.wanRelay.queryDevice(normalized)
      if (wanDevice) {
        this.broker.registerRemoteDevice(wanDevice)
        return wanDevice
      }
    }

    return null
  }

  async createSessionAcrossNetwork(
    fromDeviceId: string,
    toDeviceId: string,
    requestedPermissions: string[]
  ): Promise<{ session: SessionRecord; peer: DeviceRecord & { online: boolean } } | null> {
    const normalizedTo = normalizeDeviceId(toDeviceId)
    const normalizedFrom = normalizeDeviceId(fromDeviceId)

    let targetDevice = await this.findDeviceAcrossPeers(normalizedTo)
    if (!targetDevice) return null

    const fromDevice = this.broker.getDeviceSummary(normalizedFrom)
    if (!fromDevice) return null

    const sessionId = randomBytes(16).toString('hex')
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 90_000).toISOString()

    const session: SessionRecord = {
      id: sessionId,
      fromDeviceId: normalizedFrom,
      toDeviceId: normalizedTo,
      requestedPermissions,
      permissions: [],
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt,
      route: 'wan'
    }

    this.broker.injectSession(session)

    if (this.wanRelay) {
      await this.wanRelay.publishToDevice(normalizedTo, {
        action: 'session_request',
        sessionId,
        fromDeviceId: normalizedFrom,
        toDeviceId: normalizedTo,
        session,
        peer: fromDevice
      })
    }

    return { session, peer: targetDevice }
  }

  async handleSessionDecision(
    session: SessionRecord,
    actorDeviceId: string,
    accepted: boolean,
    permissions: string[]
  ): Promise<void> {
    if (session.route === 'wan' && this.wanRelay) {
      const mySummary = this.broker.getDeviceSummary(actorDeviceId)
      await this.wanRelay.publishToDevice(session.fromDeviceId, {
        action: 'session_decision',
        sessionId: session.id,
        fromDeviceId: actorDeviceId,
        toDeviceId: session.fromDeviceId,
        accepted,
        permissions,
        peer: mySummary
      })
    }
  }

  async forwardSignal(
    session: SessionRecord,
    fromDeviceId: string,
    message: unknown
  ): Promise<void> {
    if (session.route === 'wan' && this.wanRelay) {
      const destDeviceId = session.fromDeviceId === fromDeviceId ? session.toDeviceId : session.fromDeviceId
      await this.wanRelay.publishToDevice(destDeviceId, {
        action: 'signal',
        sessionId: session.id,
        fromDeviceId,
        toDeviceId: destDeviceId,
        message
      })
    }
  }

  async closeSession(
    session: SessionRecord,
    fromDeviceId: string,
    reason: string
  ): Promise<void> {
    if (session.route === 'wan' && this.wanRelay) {
      const destDeviceId = session.fromDeviceId === fromDeviceId ? session.toDeviceId : session.fromDeviceId
      await this.wanRelay.publishToDevice(destDeviceId, {
        action: 'session_close',
        sessionId: session.id,
        fromDeviceId,
        toDeviceId: destDeviceId,
        reason
      })
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.announceTimer) {
      clearInterval(this.announceTimer)
      this.announceTimer = null
    }
    if (this.wanRelay) {
      this.wanRelay.stop()
      this.wanRelay = null
    }
    try { this.udpSocket?.close() } catch { /* ignore */ }
    if (this.server) {
      await new Promise<void>(resolve => {
        this.server?.close(() => resolve())
      })
    }
  }
}

