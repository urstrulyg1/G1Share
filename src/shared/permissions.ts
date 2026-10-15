// Session permissions are requested by the viewer and approved (a subset) by the host.
// `view` is mandatory for every session. Each other permission is opt-in per session.
export const SESSION_PERMISSIONS = ['view', 'files', 'clipboard', 'input', 'audio'] as const
export type SessionPermission = (typeof SESSION_PERMISSIONS)[number]

export function isSessionPermission(value: unknown): value is SessionPermission {
  return typeof value === 'string' && (SESSION_PERMISSIONS as readonly string[]).includes(value)
}

export function permissionLabel(permission: SessionPermission): string {
  switch (permission) {
    case 'view': return 'screen viewing'
    case 'files': return 'file transfer'
    case 'clipboard': return 'one-time clipboard text'
    case 'input': return 'remote keyboard and mouse'
    case 'audio': return 'system audio (Windows only)'
  }
}
