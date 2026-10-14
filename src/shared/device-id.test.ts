import { describe, expect, it } from 'vitest'
import { isValidDeviceId, normalizeDeviceId } from './device-id'

describe('device ID validation', () => {
  it('accepts the displayed identifier format', () => {
    expect(isValidDeviceId('1A2B-3C4D-5E6F')).toBe(true)
  })

  it('rejects malformed identifiers', () => {
    for (const value of ['', '1A2B3C4D5E6F', '1A2B-3C4D-5E6', '1A2B-3C4D-5E6G', '1A2B/3C4D/5E6F']) {
      expect(isValidDeviceId(value)).toBe(false)
    }
  })

  it('normalizes whitespace and lowercase input', () => {
    expect(normalizeDeviceId('  abcd-1234-fedc ')).toBe('ABCD-1234-FEDC')
  })
})
