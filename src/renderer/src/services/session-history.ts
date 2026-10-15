import { isValidDeviceId } from '../../../shared/device-id'
import { isSessionPermission } from '../../../shared/permissions'
import type { DeviceSummary, RemoteSession, SessionPermission } from '../../../shared/types'

export type SessionOutcome = 'Rejected' | 'Expired' | 'Cancelled' | 'Closed before approval' | 'Closed before connecting' | 'Connection failed' | 'Disconnected'

/** Local metadata only. requestedAt comes from signaling; connectedAt exists only after WebRTC connects. */
export interface RecentSession {
  id: string
  peerId: string
  peerName: string
  role: 'viewer' | 'host'
  result: SessionOutcome
  requestedAt: string
  connectedAt?: string
  endedAt: string
  permissions: SessionPermission[]
}

export interface SessionForHistory {
  session: RemoteSession
  peer: DeviceSummary
  role: 'viewer' | 'host'
  connectedAt?: string
  connectionState: string
}

export const RECENT_STORAGE_KEY = 'g1viewer.recentSessions.v2'
const OUTCOMES: SessionOutcome[] = ['Rejected', 'Expired', 'Cancelled', 'Closed before approval', 'Closed before connecting', 'Connection failed', 'Disconnected']

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

function validRecord(value: unknown): value is RecentSession {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<RecentSession>
  if (typeof item.id !== 'string' || !/^[a-f0-9]{32}$/.test(item.id) || typeof item.peerId !== 'string' || !isValidDeviceId(item.peerId)) return false
  if (typeof item.peerName !== 'string' || !item.peerName.trim() || item.peerName.length > 80 || !['viewer', 'host'].includes(item.role ?? '')) return false
  if (!OUTCOMES.includes(item.result as SessionOutcome) || !isIsoDate(item.requestedAt) || !isIsoDate(item.endedAt)) return false
  // requestedAt is server time; local connect/end timestamps may differ because clocks can be skewed.
  if (item.connectedAt !== undefined && (!isIsoDate(item.connectedAt) || item.connectedAt > item.endedAt)) return false
  if (!Array.isArray(item.permissions) || item.permissions.some(permission => !isSessionPermission(permission)) || new Set(item.permissions).size !== item.permissions.length) return false
  // Do not let stored metadata assert a successful connection without evidence of a transport connection.
  if (item.result === 'Disconnected' && !item.connectedAt) return false
  return true
}

export function loadRecentSessions(storage: Pick<Storage, 'getItem'>): RecentSession[] {
  try {
    const raw = storage.getItem(RECENT_STORAGE_KEY) || storage.getItem('opendesk.recentSessions.v2') || '[]'
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(validRecord).slice(0, 50)
  } catch {
    return []
  }
}

export function recentSessionFrom(active: SessionForHistory, endedAt: string, end: 'local' | 'closed' | 'rejected' | 'expired' | 'failed'): RecentSession {
  let result: SessionOutcome
  if (end === 'rejected') result = 'Rejected'
  else if (end === 'expired') result = 'Expired'
  else if (active.session.status === 'pending') result = end === 'local' ? 'Cancelled' : 'Closed before approval'
  else if (end === 'failed' || active.connectionState === 'failed') result = 'Connection failed'
  else result = active.connectedAt ? 'Disconnected' : 'Closed before connecting'

  return {
    id: active.session.id,
    peerId: active.peer.id,
    peerName: active.peer.name,
    role: active.role,
    result,
    requestedAt: active.session.createdAt,
    ...(active.connectedAt ? { connectedAt: active.connectedAt } : {}),
    endedAt,
    permissions: [...(active.session.permissions ?? [])]
  }
}
