import type { DeviceInfo, DeviceSummary, EventBatch, IceConfiguration, OpenDeskBridge, RemoteSession, SessionPermission, SignalingEvent, SessionDecisionRequest } from '../../../shared/types'
import { isValidDeviceId, normalizeDeviceId } from '../../../shared/device-id'
import { isSessionPermission } from '../../../shared/permissions'

type SignalingBridge = Pick<OpenDeskBridge, 'signalingRequest' | 'decideSession'>

export class SignalingClient {
  constructor(private readonly bridge: SignalingBridge, private readonly localDevice: DeviceInfo) {}

  async register(): Promise<DeviceSummary> {
    if (!this.localDevice.identityReady || !this.localDevice.deviceId) throw new Error('A secure local device identity is required to register.')
    return await this.call<DeviceSummary>('POST', '/api/v1/devices/register', {
      id: this.localDevice.deviceId,
      name: this.localDevice.deviceName,
      platform: this.localDevice.platform,
      appVersion: this.localDevice.appVersion
    })
  }

  async heartbeat(): Promise<void> {
    await this.call('POST', '/api/v1/devices/heartbeat', {})
  }

  async lookupDevice(deviceId: string): Promise<DeviceSummary> {
    const id = normalizeDeviceId(deviceId)
    if (!isValidDeviceId(id)) throw new TypeError('Enter a valid G1Viewer device ID.')
    if (id === this.localDevice.deviceId) throw new TypeError('You cannot connect to this device itself.')
    return await this.call<DeviceSummary>('GET', `/api/v1/devices/${id}`)
  }

  async createSession(toDeviceId: string, requestedPermissions: SessionPermission[]): Promise<{ session: RemoteSession; peer: DeviceSummary }> {
    const id = normalizeDeviceId(toDeviceId)
    if (!isValidDeviceId(id)) throw new TypeError('Enter a valid G1Viewer device ID.')
    if (!requestedPermissions.includes('view')) throw new TypeError('Screen viewing permission is required.')
    return await this.call('POST', '/api/v1/sessions', { toDeviceId: id, permissions: [...new Set(requestedPermissions)] })
  }

  async decideSession(sessionId: string, accepted: boolean, permissions: SessionPermission[] = []): Promise<RemoteSession> {
    this.validateSessionId(sessionId)
    if (typeof accepted !== 'boolean' || permissions.some(permission => !isSessionPermission(permission))) throw new TypeError('Session decision is invalid.')
    const uniquePermissions = [...new Set(permissions)]
    if (uniquePermissions.length !== permissions.length || (!accepted && permissions.length > 0) || (accepted && !permissions.includes('view'))) {
      throw new TypeError('Session permission selection is invalid.')
    }
    const request: SessionDecisionRequest = { sessionId, accepted, permissions: uniquePermissions }
    return await this.bridge.decideSession(request)
  }

  async sendSignal(sessionId: string, type: 'offer' | 'answer' | 'hangup', payload: Record<string, unknown>): Promise<void> {
    this.validateSessionId(sessionId)
    await this.call('POST', `/api/v1/sessions/${sessionId}/signal`, { message: { type, payload } })
  }

  async closeSession(sessionId: string, reason = 'user disconnected'): Promise<void> {
    this.validateSessionId(sessionId)
    await this.call('POST', `/api/v1/sessions/${sessionId}/close`, { reason })
  }

  async getSession(sessionId: string): Promise<{ session: RemoteSession; peer: DeviceSummary }> {
    this.validateSessionId(sessionId)
    return await this.call('GET', `/api/v1/sessions/${sessionId}`)
  }

  async pollEvents(cursor: number, waitSeconds = 20): Promise<EventBatch> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError('Invalid event cursor.')
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 25) throw new TypeError('Invalid event wait duration.')
    return await this.call<EventBatch>('GET', `/api/v1/events?after=${cursor}&wait=${waitSeconds}`)
  }

  async getIceConfiguration(): Promise<IceConfiguration> {
    return await this.call<IceConfiguration>('GET', '/api/v1/ice')
  }

  private validateSessionId(sessionId: string): void {
    if (!/^[a-f0-9]{32}$/.test(sessionId)) throw new TypeError('Session ID is invalid.')
  }

  private async call<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const value = await this.bridge.signalingRequest({ method, path, body })
    return value as T
  }
}

export function peerFingerprint(publicKey: string): string {
  const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))
  if (bytes.length !== 32) throw new TypeError('Peer identity key is invalid.')
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('').match(/.{1,4}/g)!.join(':')
}

export function eventNeedsPeer(event: SignalingEvent): boolean {
  return event.type === 'session.request' || event.type === 'session.accepted'
}
