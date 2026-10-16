import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { createServer } from 'node:http'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { EmbeddedSignalingBroker, AutoSignalingManager, deriveWanTopic } from './embedded-signaling'

describe('WAN Relay cross-network signaling integration', () => {
function signWanMessage(identity: ReturnType<typeof createTestIdentity>, payload: Record<string, unknown>) {
  const issuedAt = Date.now()
  const nonce = randomBytes(16).toString('hex')
  const digest = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
  const canonical = `g1viewer-wan-v1\\n${identity.deviceId}\\n${issuedAt}\\n${nonce}\\n${digest}`
  const signature = sign(null, Buffer.from(canonical, 'utf8'), identity.privateKey).toString('base64url')
  return {
    protocol: 'g1viewer-wan-v1',
    fromDeviceId: identity.deviceId,
    publicKey: identity.publicKey,
    issuedAt,
    nonce,
    payload,
    signature
  }
}


function createTestIdentity() {
  const pair = generateKeyPairSync('ed25519')
  const raw = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const publicKey = raw.toString('base64url')
  const hash = createHash('sha256').update(publicKey, 'utf8').digest()
  const numeric = (hash.readBigUInt64BE(0) % 900_000_000n + 100_000_000n).toString()
  const deviceId = `${numeric.slice(0, 3)}-${numeric.slice(3, 6)}-${numeric.slice(6, 9)}`
  return { deviceId, publicKey, privateKey: pair.privateKey }
}


  let mockRelayServer: http.Server
  let relayPort: number
  let relayUrl: string
  const topicSubscribers = new Map<string, Set<(data: string) => void>>()

  beforeAll(async () => {
    // Spin up an in-process mock relay server (matching ntfy.sh protocol)
    mockRelayServer = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${relayPort}`)
      const parts = url.pathname.slice(1).split('/')
      const topic = parts[0]

      if (req.method === 'POST' && topic) {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))

          const subscribers = topicSubscribers.get(topic)
          if (subscribers) {
            const envelope = JSON.stringify({ event: 'message', topic, message: body })
            for (const sub of subscribers) {
              sub(envelope)
            }
          }
        })
        return
      }

      res.writeHead(404)
      res.end()
    })

    await new Promise<void>(resolve => {
      mockRelayServer.listen(0, '127.0.0.1', () => {
        const addr = mockRelayServer.address() as { port: number }
        relayPort = addr.port
        relayUrl = `http://127.0.0.1:${relayPort}`
        process.env.G1VIEWER_RELAY_URL = relayUrl
        resolve()
      })
    })
  })

  afterAll(async () => {
    delete process.env.G1VIEWER_RELAY_URL
    await new Promise<void>(resolve => mockRelayServer.close(() => resolve()))
  })

  it('connects two AutoSignalingManager instances across separate simulated networks', async () => {
    const identityA = createTestIdentity()
    const identityB = createTestIdentity()
    const devAId = identityA.deviceId
    const devBId = identityB.deviceId

    const topicA = deriveWanTopic(devAId)
    const topicB = deriveWanTopic(devBId)

    const managerA = new AutoSignalingManager()
    const managerB = new AutoSignalingManager()

    // Attach mock relay pub/sub listeners directly for test determinism
    const attachMockSub = (topic: string, bridge: any) => {
      let subs = topicSubscribers.get(topic)
      if (!subs) {
        subs = new Set()
        topicSubscribers.set(topic, subs)
      }
      subs.add((envelope: string) => {
        bridge.handleIncomingRawMessage(envelope)
      })
    }

    await managerA.start()
    await managerB.start()

    managerA.setLocalIdentity(devAId, identityA.publicKey, 'Device A (Home)', 'darwin', '0.1.5', identityA.privateKey)
    managerB.setLocalIdentity(devBId, identityB.publicKey, 'Device B (Office)', 'win32', '0.1.5', identityB.privateKey)

    attachMockSub(topicA, (managerA as any).wanRelay)
    attachMockSub(topicB, (managerB as any).wanRelay)

    // 1. Manager A looks up Device B across WAN relay
    const foundB = await managerA.findDeviceAcrossPeers(devBId)
    expect(foundB).not.toBeNull()
    expect(foundB?.id).toBe(devBId)
    expect(foundB?.name).toBe('Device B (Office)')
    expect(foundB?.online).toBe(true)

    // 2. Manager A initiates a session to Device B
    const sessionRes = await managerA.createSessionAcrossNetwork(devAId, devBId, ['view'])
    expect(sessionRes).not.toBeNull()
    expect(sessionRes?.session.status).toBe('pending')
    expect(sessionRes?.session.route).toBe('wan')

    const sessionId = sessionRes!.session.id

    // 3. Manager B receives the session request event
    const bEvents = await (managerB as any).broker.pollEvents(devBId, 0, 10, 0)
    expect(bEvents.events.length).toBeGreaterThan(0)
    const reqEvent = bEvents.events.find((e: any) => e.type === 'session.request')
    expect(reqEvent).toBeDefined()
    expect(reqEvent.sessionId).toBe(sessionId)

    // 4. Manager B accepts the session
    const bSession = (managerB as any).broker.getSession(sessionId)
    expect(bSession).toBeDefined()
    await managerB.handleSessionDecision(bSession, devBId, true, ['view'])

    // 5. Manager A receives the acceptance event
    const aEvents = await (managerA as any).broker.pollEvents(devAId, 0, 10, 0)
    const accEvent = aEvents.events.find((e: any) => e.type === 'session.accepted')
    expect(accEvent).toBeDefined()
    expect(accEvent.sessionId).toBe(sessionId)

    // 6. Manager A sends a WebRTC signal offer
    const offerPayload = { type: 'offer', sdp: 'v=0...' }
    const aSession = (managerA as any).broker.getSession(sessionId)
    await managerA.forwardSignal(aSession, devAId, offerPayload)

    // 7. Manager B receives the signal
    const bSigEvents = await (managerB as any).broker.pollEvents(devBId, bEvents.cursor, 10, 0)
    const sigEvent = bSigEvents.events.find((e: any) => e.type === 'signal')
    expect(sigEvent).toBeDefined()
    expect(sigEvent.message).toEqual(offerPayload)

    // 8. Close session
    await managerA.closeSession(aSession, devAId, 'done')
    const bCloseEvents = await (managerB as any).broker.pollEvents(devBId, bSigEvents.cursor, 10, 0)
    const closeEvent = bCloseEvents.events.find((e: any) => e.type === 'session.closed')
    expect(closeEvent).toBeDefined()

    await managerA.stop()
    await managerB.stop()
  })
  it('authenticates WAN requests, rejects tampering and replay, and enforces participants', async () => {
    const sender = createTestIdentity()
    const receiver = createTestIdentity()
    const attacker = createTestIdentity()
    const manager = new AutoSignalingManager()
    await manager.start()
    try {
      manager.setLocalIdentity(receiver.deviceId, receiver.publicKey, 'Receiver', 'darwin', '0.1.0', receiver.privateKey)
      const bridge = (manager as any).wanRelay
      const sessionId = 'a'.repeat(32)
      const now = Date.now()
      const session = {
        id: sessionId,
        fromDeviceId: sender.deviceId,
        toDeviceId: receiver.deviceId,
        requestedPermissions: ['view'],
        permissions: [],
        status: 'pending',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        route: 'wan'
      }
      const requestPayload = {
        action: 'session_request',
        fromDeviceId: sender.deviceId,
        toDeviceId: receiver.deviceId,
        sessionId,
        session,
        peer: {
          id: sender.deviceId,
          publicKey: sender.publicKey,
          name: 'Sender',
          platform: 'darwin',
          appVersion: '0.1.0',
          registeredAt: new Date(now).toISOString(),
          lastSeenAt: new Date(now).toISOString(),
          online: true
        }
      }
      const envelope = signWanMessage(sender, requestPayload)
      const deliver = (value: unknown) => bridge.handleIncomingRawMessage(JSON.stringify({
        event: 'message',
        message: JSON.stringify(value)
      }))

      deliver(envelope)
      expect((manager as any).broker.getSession(sessionId)?.status).toBe('pending')
      deliver(envelope) // Same nonce/signature must not emit a second request.
      const firstBatch = await (manager as any).broker.pollEvents(receiver.deviceId, 0, 20, 0)
      expect(firstBatch.events.filter((event: any) => event.type === 'session.request' && event.sessionId === sessionId)).toHaveLength(1)

      const tampered = JSON.parse(JSON.stringify(envelope))
      tampered.payload.sessionId = 'b'.repeat(32)
      tampered.payload.session.id = 'b'.repeat(32)
      deliver(tampered)
      expect((manager as any).broker.getSession('b'.repeat(32))).toBeNull()

      const forgedDecision = signWanMessage(attacker, {
        action: 'session_decision',
        fromDeviceId: attacker.deviceId,
        toDeviceId: receiver.deviceId,
        sessionId,
        accepted: true,
        permissions: ['view'],
        peer: {
          id: attacker.deviceId,
          publicKey: attacker.publicKey,
          name: 'Attacker',
          platform: 'linux',
          appVersion: '0.1.0'
        }
      })
      deliver(forgedDecision)
      expect((manager as any).broker.getSession(sessionId)?.status).toBe('pending')
    } finally {
      await manager.stop()
    }
  })

})
