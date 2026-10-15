import { describe, expect, it } from 'vitest'
import type { DeviceSummary, RemoteSession } from '../../../shared/types'
import { loadRecentSessions, recentSessionFrom, RECENT_STORAGE_KEY } from './session-history'

const requestedAt = '2026-10-15T12:00:00.000Z'
const endedAt = '2026-10-15T12:01:00.000Z'
const peer: DeviceSummary = {
  id: 'AABBCCDD-EEFF0011-22334455-66778899', name: 'Fixture workstation',
  publicKey: 'A'.repeat(43), platform: 'linux', appVersion: 'test', online: true
}
const pending: RemoteSession = {
  id: '1'.repeat(32), fromDeviceId: peer.id, toDeviceId: '11223344-55667788-99AABBCC-DDEEFF00',
  requestedPermissions: ['view', 'files'], status: 'pending', createdAt: requestedAt, expiresAt: endedAt
}
const base = { peer, role: 'viewer' as const, connectionState: 'connecting' }

describe('real local session outcomes', () => {
  it('never treats a sent but unapproved request as a successful connection', () => {
    const cancelled = recentSessionFrom({ ...base, session: pending }, endedAt, 'local')
    expect(cancelled.result).toBe('Cancelled')
    expect(cancelled.connectedAt).toBeUndefined()
    expect(cancelled.permissions).toEqual([])
    expect(recentSessionFrom({ ...base, session: pending }, endedAt, 'rejected').result).toBe('Rejected')
    expect(recentSessionFrom({ ...base, session: pending }, endedAt, 'expired').result).toBe('Expired')
    expect(recentSessionFrom({ ...base, session: pending }, endedAt, 'closed').result).toBe('Closed before approval')
  })

  it('reports no WebRTC success after approval if transport fails', () => {
    const accepted = { ...pending, status: 'accepted' as const, permissions: ['view', 'files'] as const }
    expect(recentSessionFrom({ ...base, session: { ...accepted, permissions: [...accepted.permissions] } }, endedAt, 'local').result).toBe('Closed before connecting')
    expect(recentSessionFrom({ ...base, session: { ...accepted, permissions: [...accepted.permissions] }, connectionState: 'failed' }, endedAt, 'failed').result).toBe('Connection failed')
    const connected = recentSessionFrom({ ...base, session: { ...accepted, permissions: [...accepted.permissions] }, connectionState: 'connected', connectedAt: '2026-10-15T12:00:20.000Z' }, endedAt, 'closed')
    expect(connected.result).toBe('Disconnected')
    expect(connected.permissions).toEqual(['view', 'files'])
  })

  it('does not import old unverified history or display malformed stored records', () => {
    const valid = recentSessionFrom({ ...base, session: pending }, endedAt, 'local')
    const storage = { getItem: (key: string) => key === RECENT_STORAGE_KEY ? JSON.stringify([
      valid,
      { ...valid, id: 'fixture-history' },
      { ...valid, result: 'Disconnected' },
      { ...valid, endedAt: 'yesterday' }
    ]) : JSON.stringify([{ ...valid, result: 'Connected' }]) }
    expect(loadRecentSessions(storage)).toEqual([valid])
    expect(loadRecentSessions({ getItem: () => null })).toEqual([])
  })
})
