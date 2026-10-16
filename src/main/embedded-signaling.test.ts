import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { createPrivateKey, createPublicKey, sign, createHash, generateKeyPairSync } from 'node:crypto'
import { EmbeddedSignalingBroker, createSignalingHttpServer, AutoSignalingManager } from './embedded-signaling'

describe('EmbeddedSignalingBroker and HTTP Server', () => {
function deviceIdForPublicKey(publicKey: string): string {
  const hash = createHash('sha256').update(publicKey, 'utf8').digest()
  const numeric = (hash.readBigUInt64BE(0) % 900_000_000n + 100_000_000n).toString()
  return `${numeric.slice(0, 3)}-${numeric.slice(3, 6)}-${numeric.slice(6, 9)}`
}


  let broker: EmbeddedSignalingBroker
  let server: http.Server
  let port: number
  let baseUrl: string

  const { publicKey: pubObj1, privateKey: privKey1 } = generateKeyPairSync('ed25519')
  const rawPub1 = pubObj1.export({ type: 'spki', format: 'der' }).subarray(-32)
  const pub1B64 = rawPub1.toString('base64url')
  const devId1 = deviceIdForPublicKey(pub1B64)

  const { publicKey: pubObj2, privateKey: privKey2 } = generateKeyPairSync('ed25519')
  const rawPub2 = pubObj2.export({ type: 'spki', format: 'der' }).subarray(-32)
  const pub2B64 = rawPub2.toString('base64url')
  const devId2 = deviceIdForPublicKey(pub2B64)

  beforeAll(async () => {
    broker = new EmbeddedSignalingBroker()
    server = createSignalingHttpServer(broker)
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number }
        port = addr.port
        baseUrl = `http://127.0.0.1:${port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  async function signedRequest(
    privKey: ReturnType<typeof createPrivateKey>,
    devId: string,
    method: string,
    path: string,
    bodyObj?: unknown,
    pubKeyForReg?: string
  ) {
    // 1. Get challenge
    const chalRes = await fetch(`${baseUrl}/api/v1/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: devId })
    })
    expect(chalRes.status).toBe(200)
    const { nonce } = (await chalRes.json()) as { nonce: string }

    // 2. Sign canonical request
    const bodyText = bodyObj !== undefined ? JSON.stringify(bodyObj) : ''
    const digest = createHash('sha256').update(bodyText, 'utf8').digest('hex')
    const canonical = `opendesk-signaling-v1\n${method}\n${path}\n${digest}\n${nonce}`
    const sig = sign(null, Buffer.from(canonical, 'utf8'), privKey).toString('base64url')

    const headers: Record<string, string> = {
      'X-OD-Device-ID': devId,
      'X-OD-Nonce': nonce,
      'X-OD-Signature': sig
    }
    if (bodyText) headers['Content-Type'] = 'application/json'

    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: bodyText || undefined
    })
  }

  it('serves /healthz and /readyz', async () => {
    const res = await fetch(`${baseUrl}/healthz`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string }
    expect(json.status).toBe('ok')
  })

  it('registers devices and handles heartbeat', async () => {
    const reg1 = await signedRequest(privKey1, devId1, 'POST', '/api/v1/devices/register', {
      id: devId1,
      publicKey: pub1B64,
      name: 'Laptop 1',
      platform: 'darwin',
      appVersion: '0.1.0'
    }, pub1B64)
    expect(reg1.status).toBe(200)
    const d1 = (await reg1.json()) as { id: string; name: string; online: boolean }
    expect(d1.id).toBe(devId1)
    expect(d1.online).toBe(true)

    const hb = await signedRequest(privKey1, devId1, 'POST', '/api/v1/devices/heartbeat', {})
    expect(hb.status).toBe(200)

    const me = await signedRequest(privKey1, devId1, 'GET', '/api/v1/devices/me')
    expect(me.status).toBe(200)
    const meJson = (await me.json()) as { id: string }
    expect(meJson.id).toBe(devId1)
  })

  it('handles peer discovery, sessions, decisions, and signals', async () => {
    // Register Device 2
    const reg2 = await signedRequest(privKey2, devId2, 'POST', '/api/v1/devices/register', {
      id: devId2,
      publicKey: pub2B64,
      name: 'Laptop 2',
      platform: 'win32',
      appVersion: '0.1.0'
    }, pub2B64)
    expect(reg2.status).toBe(200)

    // Lookup Device 2 from Device 1
    const lookup = await signedRequest(privKey1, devId1, 'GET', `/api/v1/devices/${devId2}`)
    expect(lookup.status).toBe(200)
    const peer = (await lookup.json()) as { id: string; online: boolean }
    expect(peer.id).toBe(devId2)
    expect(peer.online).toBe(true)

    // Device 1 creates session with Device 2
    const sessRes = await signedRequest(privKey1, devId1, 'POST', '/api/v1/sessions', {
      toDeviceId: devId2,
      permissions: ['view', 'files']
    })
    expect(sessRes.status).toBe(201)
    const { session } = (await sessRes.json()) as { session: { id: string; status: string } }
    expect(session.status).toBe('pending')

    // Session details must include the authenticated peer required by the approval flow.
    const detailsRes = await signedRequest(privKey2, devId2, 'GET', `/api/v1/sessions/${session.id}`)
    expect(detailsRes.status).toBe(200)
    const details = (await detailsRes.json()) as { session: { id: string }; peer: { id: string; publicKey: string } }
    expect(details.session.id).toBe(session.id)
    expect(details.peer.id).toBe(devId1)
    expect(details.peer.publicKey).toBe(pub1B64)

    // A third authenticated device cannot retrieve another pair's session details.
    const otherPair = generateKeyPairSync('ed25519')
    const otherPublicKey = otherPair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url')
    const otherDeviceId = deviceIdForPublicKey(otherPublicKey)
    const otherRegistration = await signedRequest(otherPair.privateKey, otherDeviceId, 'POST', '/api/v1/devices/register', {
      id: otherDeviceId, publicKey: otherPublicKey, name: 'Other device', platform: 'linux', appVersion: '0.1.0'
    }, otherPublicKey)
    expect(otherRegistration.status).toBe(200)
    const detailsFromOther = await signedRequest(otherPair.privateKey, otherDeviceId, 'GET', `/api/v1/sessions/${session.id}`)
    expect(detailsFromOther.status).toBe(404)

    // Device 2 polls events and sees session.request
    const poll2 = await signedRequest(privKey2, devId2, 'GET', '/api/v1/events?cursor=0&limit=10')
    expect(poll2.status).toBe(200)
    const batch2 = (await poll2.json()) as { events: Array<{ sequence: number; type: string; sessionId: string }> }
    expect(batch2.events.length).toBeGreaterThan(0)
    expect(batch2.events[0].type).toBe('session.request')
    expect(batch2.events[0].sessionId).toBe(session.id)

    // Device 2 accepts session
    const decision = await signedRequest(privKey2, devId2, 'POST', `/api/v1/sessions/${session.id}/decision`, {
      accepted: true,
      permissions: ['view', 'files']
    })
    expect(decision.status).toBe(200)

    // Device 1 polls events and sees session.accepted
    const poll1 = await signedRequest(privKey1, devId1, 'GET', '/api/v1/events?cursor=0&limit=10')
    expect(poll1.status).toBe(200)
    const batch1 = (await poll1.json()) as { events: Array<{ type: string; sessionId: string }> }
    expect(batch1.events.some(e => e.type === 'session.accepted')).toBe(true)

    // Device 1 sends WebRTC offer signal
    const sigRes = await signedRequest(privKey1, devId1, 'POST', `/api/v1/sessions/${session.id}/signal`, {
      message: { fromDeviceId: devId1, type: 'offer', payload: { sdp: 'fake-sdp' }, signature: 'sig' }
    })
    expect(sigRes.status).toBe(200)

    // Device 2 receives signal
    const pollSig = await signedRequest(privKey2, devId2, 'GET', `/api/v1/events?cursor=${batch2.events[0].sequence}&limit=10`)
    expect(pollSig.status).toBe(200)
    const batchSig = (await pollSig.json()) as { events: Array<{ type: string }> }
    expect(batchSig.events.some(e => e.type === 'signal')).toBe(true)

    // Close session
    const closeRes = await signedRequest(privKey1, devId1, 'POST', `/api/v1/sessions/${session.id}/close`, { reason: 'done' })
    expect(closeRes.status).toBe(200)
  })

  it('rejects session signaling and closure from a non-participant', () => {
    const isolated = new EmbeddedSignalingBroker()
    isolated.registerDevice(devId1, pub1B64, 'Laptop 1', 'darwin', '0.1.0')
    isolated.registerDevice(devId2, pub2B64, 'Laptop 2', 'win32', '0.1.0')
    const pair3 = generateKeyPairSync('ed25519')
    const raw3 = pair3.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
    const pub3 = raw3.toString('base64url')
    const devId3 = deviceIdForPublicKey(pub3)
    isolated.registerDevice(devId3, pub3, 'Laptop 3', 'linux', '0.1.0')

    const created = isolated.createSession(devId1, devId2, ['view'])
    expect(created).not.toBeNull()
    const sessionId = created!.session.id

    expect(isolated.forwardSignal(sessionId, devId3, { type: 'offer' })).toBe(false)
    expect(isolated.closeSession(sessionId, devId3, 'unauthorized')).toBe(false)
    expect(isolated.getSession(sessionId)?.status).toBe('pending')

    expect(isolated.decideSession(sessionId, devId2, true, ['view'])).not.toBeNull()
    expect(isolated.forwardSignal(sessionId, devId1, { type: 'offer' })).toBe(true)
    expect(isolated.closeSession(sessionId, devId2, 'approved participant')).toBe(true)
    expect(isolated.getSession(sessionId)?.status).toBe('closed')
  })

  it('does not allow an accepted session to grant permissions that were not requested', () => {
    const isolated = new EmbeddedSignalingBroker()
    isolated.registerDevice(devId1, pub1B64, 'Laptop 1', 'darwin', '0.1.0')
    isolated.registerDevice(devId2, pub2B64, 'Laptop 2', 'win32', '0.1.0')
    const created = isolated.createSession(devId1, devId2, ['view'])
    expect(created).not.toBeNull()
    expect(isolated.decideSession(created!.session.id, devId2, true, ['view', 'input'])).toBeNull()
    expect(isolated.getSession(created!.session.id)?.status).toBe('pending')
  })

  it('AutoSignalingManager starts, provides an active URL, and stops cleanly', async () => {
    const manager = new AutoSignalingManager()
    const url = await manager.start()
    expect(url).toMatch(/^http:\/\/(?:127\.0\.0\.1|localhost|\d+\.\d+\.\d+\.\d+):\d+$/)
    expect(manager.getActiveUrl()).toBe(url)
    await manager.stop()
  })

  it('serves rich ICE configuration with Google and Cloudflare STUN servers', async () => {
    const res = await signedRequest(privKey1, devId1, 'GET', '/api/v1/ice')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { iceServers: Array<{ urls: string[] }> }
    expect(Array.isArray(json.iceServers)).toBe(true)
    const allUrls = json.iceServers.flatMap(s => s.urls)
    expect(allUrls.some(u => u.includes('google.com'))).toBe(true)
    expect(allUrls.some(u => u.includes('cloudflare.com'))).toBe(true)
  })

  it('derives deterministic WAN relay topics across formatting variations', async () => {
    const { deriveWanTopic } = await import('./embedded-signaling')
    const topic1 = deriveWanTopic('123-456-789')
    const topic2 = deriveWanTopic('123456789')
    const topic3 = deriveWanTopic('123 456 789')
    const topicOther = deriveWanTopic('987-654-321')

    expect(topic1).toMatch(/^g1v_wan_[0-9a-f]{24}$/)
    expect(topic1).toBe(topic2)
    expect(topic2).toBe(topic3)
    expect(topic1).not.toBe(topicOther)
  })
})

