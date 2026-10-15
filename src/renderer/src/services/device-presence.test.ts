import { describe, expect, it } from 'vitest'
import { devicePresence } from './device-presence'

const checkedAt = '2026-10-15T12:00:00.000Z'
const device = {
  id: 'AABBCCDD-EEFF0011-22334455-66778899', name: 'Test device', publicKey: 'A'.repeat(43),
  platform: 'linux', appVersion: 'test', online: true, checkedAt
}

describe('device presence', () => {
  it('shows an online/offline label only for recent actual lookups while signaling is available', () => {
    const now = Date.parse(checkedAt) + 10_000
    expect(devicePresence(device, true, now)).toEqual({ label: 'Online at last lookup', fresh: true })
    expect(devicePresence({ ...device, online: false }, true, now)).toEqual({ label: 'Offline at last lookup', fresh: true })
    expect(devicePresence(device, false, now)).toEqual({ label: 'Status unknown — refresh', fresh: false })
  })

  it('expires stale observations and does not invent presence for invalid timestamps', () => {
    const now = Date.parse(checkedAt)
    expect(devicePresence(device, true, now + 30_000).fresh).toBe(false)
    expect(devicePresence({ ...device, checkedAt: 'not a date' }, true, now).fresh).toBe(false)
    expect(devicePresence(device, true, now - 1).fresh).toBe(false)
  })
})
