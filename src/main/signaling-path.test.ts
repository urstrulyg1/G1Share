import { describe, expect, it } from 'vitest'
import { requestPathIsAllowed } from './signaling-path'

describe('signaling request path allowlist', () => {
  it('allows device discovery and supported signaling routes', () => {
    for (const path of [
      '/api/v1/devices',
      '/api/v1/devices/register',
      '/api/v1/devices/11223344-55667788-99AABBCC-DDEEFF00',
      '/api/v1/sessions',
      '/api/v1/sessions/0123456789abcdef0123456789abcdef',
      '/api/v1/sessions/0123456789abcdef0123456789abcdef/signal',
      '/api/v1/events?after=0&wait=20',
      '/api/v1/ice'
    ]) expect(requestPathIsAllowed(path), path).toBe(true)
  })

  it('rejects unknown routes and path/query injection', () => {
    for (const path of [
      '/api/v1/devices/',
      '/api/v1/admin',
      '/api/v1/devices/%2e%2e',
      '/api/v1/devices#fragment',
      '/api/v1/devices\\\\register',
      '/api/v1/events?wait=20&after=0',
      '/api/v1/events?after=-1&wait=20',
      '/api/v1/sessions/not-a-session/signal',
      'https://example.com/api/v1/devices'
    ]) expect(requestPathIsAllowed(path), path).toBe(false)
  })
})
