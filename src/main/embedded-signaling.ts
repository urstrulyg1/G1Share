import http from 'node:http'
import dgram from 'node:dgram'
import os from 'node:os'
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'

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
}

const PROTOCOL_VERSION = 'v1'
const SERVICE_VERSION = '0.2.0'
const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302'
]

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
      requestedPermissions,
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

  decideSession(sessionId: string, actorDeviceId: string, accepted: boolean, permissions: string[]): SessionRecord | null {
    const session = this.sessions.get(sessionId)
    if (!session || session.toDeviceId !== actorDeviceId || session.status !== 'pending') return null

    const toDevice = this.getDeviceSummary(actorDeviceId)
    if (accepted) {
      session.status = 'active'
      session.permissions = permissions
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
    if (!session || (session.status !== 'pending' && session.status !== 'active')) return false
    const destDeviceId = session.fromDeviceId === fromDeviceId ? session.toDeviceId : session.fromDeviceId
    this.pushEvent(destDeviceId, {
      type: 'signal',
      sessionId,
      message
    })
    return true
  }

  closeSession(sessionId: string, fromDeviceId: string, _reason: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.status = 'closed'
    const destDeviceId = session.fromDeviceId === fromDeviceId ? session.toDeviceId : session.fromDeviceId
    this.pushEvent(destDeviceId, {
      type: 'session.closed',
      sessionId
    })
    return true
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

export function createSignalingHttpServer(broker: EmbeddedSignalingBroker): http.Server {
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
      const devices = broker.listOnlineDevices()
      res.writeHead(200)
      res.end(JSON.stringify({ devices }))
      return
    }

    if (req.method === 'GET' && path.startsWith('/api/v1/devices/')) {
      const targetId = path.slice('/api/v1/devices/'.length)
      const device = broker.getDeviceSummary(targetId)
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
      const result = broker.createSession(deviceId, data.toDeviceId, data.permissions || ['view'])
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
      const session = broker.getSession(sessionId)
      if (!session) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: { code: 'not_found', message: 'Session not found.' } }))
        return
      }
      res.writeHead(200)
      res.end(JSON.stringify(session))
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
      res.writeHead(200)
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    const closeMatch = path.match(/^\/api\/v1\/sessions\/([a-f0-9]{32})\/close$/)
    if (req.method === 'POST' && closeMatch) {
      const sessionId = closeMatch[1]
      const data = bodyText ? JSON.parse(bodyText) as { reason?: string } : {}
      broker.closeSession(sessionId, deviceId, data.reason || 'user closed')
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
      res.writeHead(200)
      res.end(JSON.stringify({ iceServers: [{ urls: DEFAULT_STUN_URLS }] }))
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'Endpoint not found.' } }))
  })
}

export function getLanIpv4Addresses(): string[] {
  const addresses: string[] = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address)
      }
    }
  }
  return addresses
}

export function getSubnetBroadcastAddresses(): string[] {
  const broadcasts: string[] = ['255.255.255.255']
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

export class AutoSignalingManager {
  private broker = new EmbeddedSignalingBroker()
  private server: http.Server | null = null
  private udpSocket: dgram.Socket | null = null
  private serverPort = 8787
  private activeUrl = ''
  private isCoordinator = false
  private stopped = false

  async start(): Promise<string> {
    // 1. Try to start local HTTP server on port 8787, or next available port if taken.
    await this.startHttpServer()

    // 2. Discover if an existing coordinator is already on the LAN.
    const discovered = await this.probeLanCoordinator(400)
    if (discovered) {
      this.activeUrl = discovered
      this.isCoordinator = false
    } else {
      this.activeUrl = `http://127.0.0.1:${this.serverPort}`
      this.isCoordinator = true
    }

    // 3. Start UDP responder so other devices can discover this coordinator.
    this.startUdpListener()

    return this.activeUrl
  }

  getActiveUrl(): string {
    return this.activeUrl || `http://127.0.0.1:${this.serverPort}`
  }

  getCoordinatorLanUrl(): string {
    const lanIps = getLanIpv4Addresses()
    const ip = lanIps[0] || '127.0.0.1'
    return `http://${ip}:${this.serverPort}`
  }

  private startHttpServer(): Promise<number> {
    return new Promise(resolve => {
      this.server = createSignalingHttpServer(this.broker)

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

      probeSocket.on('message', (msg, rinfo) => {
        try {
          const text = msg.toString('utf8')
          if (text.startsWith('G1VIEWER_COORDINATOR:')) {
            const url = text.slice('G1VIEWER_COORDINATOR:'.length).trim()
            if (url && !resolved) {
              resolved = true
              clearTimeout(timer)
              try { probeSocket?.close() } catch { /* ignore */ }
              // If the coordinator announced itself from another machine or same, resolve
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
          for (const bcast of getSubnetBroadcastAddresses()) {
            probeSocket?.send(message, 0, message.length, 8789, bcast, () => {})
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
        }
      })
      this.udpSocket.on('error', () => { /* ignore */ })
      this.udpSocket.bind(8789, '0.0.0.0', () => {
        try { this.udpSocket?.setBroadcast(true) } catch { /* ignore */ }
      })
    } catch { /* ignore */ }
  }

  async stop(): Promise<void> {
    this.stopped = true
    try { this.udpSocket?.close() } catch { /* ignore */ }
    if (this.server) {
      await new Promise<void>(resolve => {
        this.server?.close(() => resolve())
      })
    }
  }
}
