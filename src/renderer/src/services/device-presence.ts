import type { DeviceSummary } from '../../../shared/types'

type CheckedDevice = DeviceSummary & { checkedAt: string }

/** Presence is a short-lived observation from signaling, never a persisted online/offline claim. */
export function devicePresence(device: CheckedDevice, serviceOnline: boolean, now: number): { label: string; fresh: boolean } {
  const checked = Date.parse(device.checkedAt)
  if (!serviceOnline || !Number.isFinite(checked) || now < checked || now - checked >= 30_000) {
    return { label: 'Status unknown — refresh', fresh: false }
  }
  return { label: device.online ? 'Online at last lookup' : 'Offline at last lookup', fresh: true }
}
