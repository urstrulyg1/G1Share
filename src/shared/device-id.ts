export const LEGACY_DEVICE_ID_PATTERN = /^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/
export const DEVICE_ID_PATTERN = /^[A-F0-9]{8}(?:-[A-F0-9]{8}){3}$/

export function isValidDeviceId(value: string): boolean {
  return DEVICE_ID_PATTERN.test(value) || LEGACY_DEVICE_ID_PATTERN.test(value)
}

export function normalizeDeviceId(value: string): string {
  return value.trim().toUpperCase()
}

export function formatDeviceId(hex: string): string {
  const normalized = hex.replaceAll('-', '').toUpperCase()
  if (!/^[A-F0-9]{32}$/.test(normalized)) throw new TypeError('A device identifier must contain 128 bits of hexadecimal data.')
  return normalized.match(/.{8}/g)!.join('-')
}
