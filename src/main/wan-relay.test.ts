import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { createServer } from 'node:http'
import { EmbeddedSignalingBroker, AutoSignalingManager, deriveWanTopic } from './embedded-signaling'

describe('WAN Relay cross-network signaling integration', () => {
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
    const devAId = '100-200-300'
    const devBId = '400-500-600'

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

    managerA.setLocalIdentity(devAId, 'pubKeyA', 'Device A (Home)', 'darwin', '0.1.5')
    managerB.setLocalIdentity(devBId, 'pubKeyB', 'Device B (Office)', 'win32', '0.1.5')

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
})
