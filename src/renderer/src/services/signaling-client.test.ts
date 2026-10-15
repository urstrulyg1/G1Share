import { describe, expect, it, vi } from 'vitest'
import type { DeviceInfo, DeviceSummary, RemoteSession, SignalingRequest } from '../../../shared/types'
import { SignalingClient } from './signaling-client'

const local: DeviceInfo & { deviceId: string } = {
  deviceId: '11223344-55667788-99AABBCC-DDEEFF00',
  deviceName: 'Test workstation',
  appVersion: '0.1.0',
  platform: 'linux',
  architecture: 'x64',
  identityReady: true,
  identityMessage: '',
  secureStorageBackend: 'gnome_libsecret'
}

const peer: DeviceSummary = {
  id: 'AABBCCDD-EEFF0011-22334455-66778899',
  name: 'Remote workstation',
  publicKey: 'A'.repeat(43),
  platform: 'linux',
  appVersion: '0.1.0',
  online: true
}

describe('SignalingClient', () => {
  it('registers with profile metadata and resolves a device by its ID', async () => {
    const calls: SignalingRequest[] = []
    const bridge = {
      signalingRequest: vi.fn(async (request: SignalingRequest) => {
        calls.push(request)
        return request.path.endsWith('/register') ? peer : peer
      }),
      decideSession: vi.fn()
    }
    const client = new SignalingClient(bridge, local)
    await client.register()
    const result = await client.lookupDevice(`  ${peer.id.toLowerCase()}  `)

    expect(result).toEqual(peer)
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/v1/devices/register',
      body: { id: local.deviceId, name: local.deviceName, platform: 'linux', appVersion: '0.1.0' }
    })
    expect(calls[1]).toEqual({ method: 'GET', path: `/api/v1/devices/${peer.id}` })
  })

  it('requires view permission and a valid target ID', async () => {
    const bridge = { signalingRequest: vi.fn(async () => peer), decideSession: vi.fn() }
    const client = new SignalingClient(bridge, local)
    await expect(client.createSession(peer.id, ['files'])).rejects.toThrow('Screen viewing permission is required')
    await expect(client.lookupDevice('not-an-id')).rejects.toThrow('valid OpenDesk device ID')
    expect(bridge.signalingRequest).not.toHaveBeenCalled()
  })

  it('constructs bounded event polls and validates session IDs', async () => {
    const calls: SignalingRequest[] = []
    const bridge = { signalingRequest: vi.fn(async (request: SignalingRequest) => { calls.push(request); return { cursor: 3, events: [] } }), decideSession: vi.fn() }
    const client = new SignalingClient(bridge, local)
    await client.pollEvents(3, 20)
    expect(calls[0]).toEqual({ method: 'GET', path: '/api/v1/events?after=3&wait=20', body: undefined })
    await expect(client.getSession('../bad')).rejects.toThrow('Session ID is invalid')
    await expect(client.pollEvents(-1, 20)).rejects.toThrow('Invalid event cursor')
    await expect(client.pollEvents(0, 26)).rejects.toThrow('Invalid event wait duration')
  })

  it('sends selected session permissions without implicitly granting extras', async () => {
    const bridge = { signalingRequest: vi.fn(async () => ({ session: { id: '0'.repeat(32) }, peer })), decideSession: vi.fn() }
    const client = new SignalingClient(bridge, local)
    await client.createSession(peer.id, ['view', 'files', 'view'])
    expect(bridge.signalingRequest).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/v1/sessions',
      body: { toDeviceId: peer.id, permissions: ['view', 'files'] }
    })
  })

  it('routes session approval through the consent-gated main-process bridge', async () => {
    const session: RemoteSession = {
      id: '1'.repeat(32),
      fromDeviceId: local.deviceId,
      toDeviceId: peer.id,
      requestedPermissions: ['view', 'files'],
      permissions: ['view', 'files'],
      status: 'accepted',
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(60_000).toISOString()
    }
    const bridge = { signalingRequest: vi.fn(), decideSession: vi.fn(async () => session) }
    const client = new SignalingClient(bridge, local)
    await client.decideSession(session.id, true, ['view', 'files'])

    expect(bridge.decideSession).toHaveBeenCalledWith({ sessionId: session.id, accepted: true, permissions: ['view', 'files'] })
    expect(bridge.signalingRequest).not.toHaveBeenCalled()
    await expect(client.decideSession(session.id, false, ['view'])).rejects.toThrow('Session permission selection is invalid')
  })
})

describe('session decisions with input and audio permissions', () => {
  it('forwards approved input and audio permissions to the local approval bridge', async () => {
    const sessionId = 'a'.repeat(32)
    const decideSession = vi.fn(async () => ({ id: sessionId }))
    const client = new SignalingClient({ signalingRequest: vi.fn(), decideSession } as never, {} as never)
    await client.decideSession(sessionId, true, ['view', 'input', 'audio'])
    expect(decideSession).toHaveBeenCalledWith({ sessionId, accepted: true, permissions: ['view', 'input', 'audio'] })
    await expect(client.decideSession(sessionId, true, ['view', 'root' as never])).rejects.toThrow('Session decision is invalid')
  })
})
