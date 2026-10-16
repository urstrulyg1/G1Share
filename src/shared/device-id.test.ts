import { describe, expect, it } from 'vitest'
import { formatDeviceId, isValidDeviceId, normalizeDeviceId } from './device-id'

describe('device ID validation', () => {
  it('accepts new 9-digit 3-3-3, 128-bit, and legacy identifiers', () => {
    expect(isValidDeviceId('482-910-375')).toBe(true)
    expect(isValidDeviceId('A1B-2C3-D4E')).toBe(true)
    expect(isValidDeviceId('1A2B3C4D-5E6F7081-92A3B4C5-D6E7F809')).toBe(true)
    expect(isValidDeviceId('1A2B-3C4D-5E6F')).toBe(true)
  })

  it('rejects malformed identifiers', () => {
    for (const value of ['', '1A2B3C4D5E6F', '1A2B-3C4D-5E6', '1A2B-3C4D-5E6G', '1A2B/3C4D/5E6F', '1A2B3C4D-5E6F7081-92A3B4C5', '12-34-56']) {
      expect(isValidDeviceId(value)).toBe(false)
    }
  })

  it('normalizes whitespace and lowercase input', () => {
    expect(normalizeDeviceId('  abcd-1234-fedc ')).toBe('ABCD-1234-FEDC')
    expect(normalizeDeviceId('  123456789 ')).toBe('123-456-789')
    expect(normalizeDeviceId('  123 456 789 ')).toBe('123-456-789')
    expect(normalizeDeviceId('  123-456-789 ')).toBe('123-456-789')
  })

  it('formats a 9-digit (3-3-3) and full 128-bit identifier', () => {
    expect(formatDeviceId('123456789')).toBe('123-456-789')
    expect(formatDeviceId('1234567890abcdef1234567890abcdef')).toBe('12345678-90ABCDEF-12345678-90ABCDEF')
    expect(() => formatDeviceId('abcd')).toThrow('128 bits')
  })
})
