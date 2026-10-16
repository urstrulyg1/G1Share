export const DEVICE_ID_9_PATTERN = /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/
export const LEGACY_DEVICE_ID_12_PATTERN = /^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/
export const LEGACY_DEVICE_ID_32_PATTERN = /^[A-F0-9]{8}(?:-[A-F0-9]{8}){3}$/

export const DEVICE_ID_PATTERN = DEVICE_ID_9_PATTERN
export const LEGACY_DEVICE_ID_PATTERN = LEGACY_DEVICE_ID_12_PATTERN

export function isValidDeviceId(value: string): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return DEVICE_ID_9_PATTERN.test(trimmed) ||
         LEGACY_DEVICE_ID_12_PATTERN.test(trimmed) ||
         LEGACY_DEVICE_ID_32_PATTERN.test(trimmed)
}

export function normalizeDeviceId(value: string): string {
  if (typeof value !== 'string') return ''
  const cleaned = value.trim().replace(/[\s-]+/g, '').toUpperCase()
  if (/^[A-Z0-9]{9}$/.test(cleaned)) {
    return `${cleaned.slice(0, 3)}-${cleaned.slice(3, 6)}-${cleaned.slice(6, 9)}`
  }
  if (/^[A-F0-9]{12}$/.test(cleaned)) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}-${cleaned.slice(8, 12)}`
  }
  if (/^[A-F0-9]{32}$/.test(cleaned)) {
    return `${cleaned.slice(0, 8)}-${cleaned.slice(8, 16)}-${cleaned.slice(16, 24)}-${cleaned.slice(24, 32)}`
  }
  return value.trim().toUpperCase()
}

export function formatDeviceId(input: string): string {
  const cleaned = input.replaceAll(/[\s-]+/g, '').toUpperCase()
  if (/^[A-Z0-9]{9}$/.test(cleaned)) {
    return `${cleaned.slice(0, 3)}-${cleaned.slice(3, 6)}-${cleaned.slice(6, 9)}`
  }
  if (/^[A-F0-9]{32}$/.test(cleaned)) {
    return cleaned.match(/.{8}/g)!.join('-')
  }
  if (/^[A-F0-9]{12}$/.test(cleaned)) {
    return cleaned.match(/.{4}/g)!.join('-')
  }
  throw new TypeError('A device identifier must contain a 9-digit code (3-3-3) or 128 bits of hexadecimal data.')
}
