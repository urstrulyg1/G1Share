import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { createServer } from 'node:http'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { EmbeddedSignalingBroker, AutoSignalingManager, deriveWanTopic } from './embedded-signaling'

describe('WAN Relay cross-network signaling integration', () => {
function signedPeerSignal(
  identity: ReturnType<typeof createTestIdentity>,
  sessionId: string,
  type: 'offer' | 'answer',
  payload: Record<string, unknown>
) {
  const digest = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
  const canonical = `opendesk-peer-signal-v1\n${sessionId}\n${identity.deviceId}\n${type}\n${digest}`
  return {
    fromDeviceId: identity.deviceId,
    type,
    payload,
    signature: sign(null, Buffer.from(canonical, 'utf8'), identity.privateKey).toString('base64url')
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
    expect((managerB as any).broker.decideSession(sessionId, devBId, true, ['view'])).not.toBeNull()
    await managerB.handleSessionDecision(bSession, devBId, true, ['view'])

    // 5. Manager A receives the acceptance event
    const aEvents = await (managerA as any).broker.pollEvents(devAId, 0, 10, 0)
    const accEvent = aEvents.events.find((e: any) => e.type === 'session.accepted')
    expect(accEvent).toBeDefined()
    expect(accEvent.sessionId).toBe(sessionId)

    // 6. Manager A (viewer) sends a signed WebRTC answer to Manager B (host).
    const answerPayload = { type: 'answer', sdp: 'v=0\\r\\n' }
    const signalMessage = signedPeerSignal(identityA, sessionId, 'answer', answerPayload)
    const aSession = (managerA as any).broker.getSession(sessionId)
    expect(aSession.status).toBe('active')
    expect(Date.parse(aSession.expiresAt)).toBeGreaterThan(Date.now() + 60 * 60 * 1000)
    expect((managerB as any).broker.getSession(sessionId)?.status).toBe('active')
    expect(Date.parse((managerB as any).broker.getSession(sessionId).expiresAt)).toBeGreaterThan(Date.now() + 60 * 60 * 1000)
    const signalEnvelopeProbe = (managerA as any).wanRelay.createEnvelope(devBId, {
      action: 'signal', sessionId, fromDeviceId: devAId, toDeviceId: devBId, message: signalMessage
    })
    expect(signalEnvelopeProbe).not.toBeNull()
    expect((managerB as any).wanRelay.decryptEnvelopePayload(signalEnvelopeProbe)).toMatchObject({
      action: 'signal', sessionId, fromDeviceId: devAId, toDeviceId: devBId, message: signalMessage
    })
    await managerA.forwardSignal(aSession, devAId, signalMessage)

    // 7. Manager B receives the signed signal.
    const bSigEvents = await (managerB as any).broker.pollEvents(devBId, bEvents.cursor, 10, 0)
    const sigEvent = bSigEvents.events.find((e: any) => e.type === 'signal')
    expect(sigEvent).toBeDefined()
    expect(sigEvent.message).toEqual(signalMessage)

    // 8. Close session
    await managerA.closeSession(aSession, devAId, 'done')
    const bCloseEvents = await (managerB as any).broker.pollEvents(devBId, bSigEvents.cursor, 10, 0)
    const closeEvent = bCloseEvents.events.find((e: any) => e.type === 'session.closed')
    expect(closeEvent).toBeDefined()

    await managerA.stop()
    await managerB.stop()
  })
  it('encrypts WAN payloads and rejects tampering, replay, and non-participant decisions', async () => {
    const sender = createTestIdentity()
    const receiver = createTestIdentity()
    const attacker = createTestIdentity()
    const senderManager = new AutoSignalingManager()
    const receiverManager = new AutoSignalingManager()
    const attackerManager = new AutoSignalingManager()
    await Promise.all([senderManager.start(), receiverManager.start(), attackerManager.start()])
    try {
      senderManager.setLocalIdentity(sender.deviceId, sender.publicKey, 'Sender', 'darwin', '0.1.0', sender.privateKey)
      receiverManager.setLocalIdentity(receiver.deviceId, receiver.publicKey, 'Receiver', 'darwin', '0.1.0', receiver.privateKey)
      attackerManager.setLocalIdentity(attacker.deviceId, attacker.publicKey, 'Attacker', 'linux', '0.1.0', attacker.privateKey)

      const registerRemote = (manager: AutoSignalingManager, identity: ReturnType<typeof createTestIdentity>, name: string) => {
        ;(manager as any).broker.registerRemoteDevice({
          id: identity.deviceId, publicKey: identity.publicKey, name, platform: 'darwin', appVersion: '0.1.0',
          registeredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), online: true
        })
      }
      registerRemote(senderManager, receiver, 'Receiver')
      registerRemote(attackerManager, sender, 'Sender')

      const senderBridge = (senderManager as any).wanRelay
      const receiverBridge = (receiverManager as any).wanRelay
      const attackerBridge = (attackerManager as any).wanRelay
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
      ;(senderManager as any).broker.injectSession({ ...session })
      const envelope = senderBridge.createEnvelope(receiver.deviceId, requestPayload)
      expect(envelope).not.toBeNull()
      expect(envelope.payload).toBeUndefined()
      expect(envelope.encryptedPayload).toBeDefined()
      const deliver = (bridge: any, value: unknown) => bridge.handleIncomingRawMessage(JSON.stringify({
        event: 'message',
        message: JSON.stringify(value)
      }))

      deliver(receiverBridge, envelope)
      expect((receiverManager as any).broker.getSession(sessionId)?.status).toBe('pending')
      deliver(receiverBridge, envelope)
      const firstBatch = await (receiverManager as any).broker.pollEvents(receiver.deviceId, 0, 20, 0)
      expect(firstBatch.events.filter((event: any) => event.type === 'session.request' && event.sessionId === sessionId)).toHaveLength(1)

      const tampered = JSON.parse(JSON.stringify(envelope))
      tampered.encryptedPayload.ciphertext = (tampered.encryptedPayload.ciphertext[0] === 'A' ? 'B' : 'A') + tampered.encryptedPayload.ciphertext.slice(1)
      deliver(receiverBridge, tampered)
      expect((receiverManager as any).broker.getSession('b'.repeat(32))).toBeNull()

      const malformedSession = { ...session, id: 'c'.repeat(32), createdAt: 'not-a-date' }
      const malformedEnvelope = senderBridge.createEnvelope(receiver.deviceId, {
        ...requestPayload, sessionId: 'c'.repeat(32), session: malformedSession
      })
      deliver(receiverBridge, malformedEnvelope)
      expect((receiverManager as any).broker.getSession('c'.repeat(32))).toBeNull()

      const forgedDecision = attackerBridge.createEnvelope(sender.deviceId, {
        action: 'session_decision',
        fromDeviceId: attacker.deviceId,
        toDeviceId: sender.deviceId,
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
      expect(forgedDecision).not.toBeNull()
      deliver(senderBridge, forgedDecision)
      expect((senderManager as any).broker.getSession(sessionId)?.status).toBe('pending')
    } finally {
      await Promise.all([senderManager.stop(), receiverManager.stop(), attackerManager.stop()])
    }
  })
})
