export function requestPathIsAllowed(path: string): boolean {
  if (!path.startsWith('/api/v1/') || path.includes('#') || path.includes('\\') || path.includes('%') || path.includes('\n') || path.includes('\r')) return false
  const route = path.split('?')[0]
  if (path.includes('?')) {
    if (route !== '/api/v1/events' || !/^\/api\/v1\/events\?after=\d+&wait=(?:0|[1-9]\d?)$/.test(path)) return false
  }
  return /^\/api\/v1\/(?:devices(?:\/(?:register|heartbeat|me|rename|revoke|[A-F0-9-]{12,35}))?|sessions(?:\/[a-f0-9]{32}(?:\/(?:decision|signal|close))?)?|events|ice)$/.test(route)
}