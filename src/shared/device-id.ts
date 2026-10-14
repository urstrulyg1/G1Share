export const DEVICE_ID_PATTERN = /^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/

export function isValidDeviceId(value: string): boolean {
  return DEVICE_ID_PATTERN.test(value)
}

export function normalizeDeviceId(value: string): string {
  return value.trim().toUpperCase()
}
