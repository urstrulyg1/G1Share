import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FALLBACK_STUN_URLS,
  fallbackNetworkBootstrapConfig,
  fetchDynamicTurnServers,
  loadNetworkBootstrapConfig,
  parseNetworkBootstrapConfig,
  resetNetworkBootstrapCacheForTests
} from './network-config'

afterEach(() => {
  resetNetworkBootstrapCacheForTests()
  vi.restoreAllMocks()
})

describe('dynamic network bootstrap', () => {
  it('accepts valid HTTPS relay, STUN list, and an optional TURN credential endpoint', () => {
    expect(parseNetworkBootstrapConfig({
      schemaVersion: 1,
      relayUrl: 'https://relay.example.test/ntfy',
      stunUrls: ['stun:stun.example.test:3478', 'stuns:stun2.example.test:5349'],
      turnCredentialsUrl: 'https://config.example.test/api/turn-credentials',
      cacheTtlSeconds: 1200
    })).toEqual({
      schemaVersion: 1,
      relayUrl: 'https://relay.example.test/ntfy',
      stunUrls: ['stun:stun.example.test:3478', 'stuns:stun2.example.test:5349'],
      turnCredentialsUrl: 'https://config.example.test/api/turn-credentials',
      cacheTtlSeconds: 1200
    })
  })

  it.each([
    ['wrong schema', { schemaVersion: 2, relayUrl: 'https://relay.example.test', stunUrls: ['stun:stun.example.test:3478'] }],
    ['plain HTTP relay', { schemaVersion: 1, relayUrl: 'http://relay.example.test', stunUrls: ['stun:stun.example.test:3478'] }],
    ['relay credentials', { schemaVersion: 1, relayUrl: 'https://user:pass@relay.example.test', stunUrls: ['stun:stun.example.test:3478'] }],
    ['invalid STUN URL', { schemaVersion: 1, relayUrl: 'https://relay.example.test', stunUrls: ['https://not-a-stun.example.test'] }],
    ['plain HTTP credential endpoint', { schemaVersion: 1, relayUrl: 'https://relay.example.test', stunUrls: ['stun:stun.example.test:3478'], turnCredentialsUrl: 'http://turn.example.test/credentials' }]
  ])('rejects unsafe bootstrap data (%s)', (_name, value) => {
    expect(parseNetworkBootstrapConfig(value)).toBeNull()
  })

  it('uses a bounded runtime fetch and caches valid provider config', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      relayUrl: 'https://relay.example.test',
      stunUrls: ['stun:stun.example.test:3478'],
      cacheTtlSeconds: 900
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const first = await loadNetworkBootstrapConfig(fetcher, 'https://config.example.test/network.json')
    const second = await loadNetworkBootstrapConfig(fetcher, 'https://config.example.test/network.json')
    expect(first.relayUrl).toBe('https://relay.example.test')
    expect(second).toEqual(first)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', cache: 'no-store' })
  })

  it('falls back to safe public defaults when the bootstrap endpoint is unavailable or invalid', async () => {
    const unavailable = await loadNetworkBootstrapConfig(vi.fn().mockRejectedValue(new Error('offline')), 'https://config.example.test/network.json')
    expect(unavailable).toEqual(fallbackNetworkBootstrapConfig())
    expect(unavailable.stunUrls).toEqual([...FALLBACK_STUN_URLS])

    const invalid = await loadNetworkBootstrapConfig(
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: 99 }), { status: 200 })),
      'https://config.example.test/invalid.json'
    )
    expect(invalid).toEqual(fallbackNetworkBootstrapConfig())
  })

  it('accepts only expiring TURN credentials from the configured HTTPS endpoint', async () => {
    const config = {
      ...fallbackNetworkBootstrapConfig(),
      turnCredentialsUrl: 'https://config.example.test/api/turn-credentials'
    }
    const valid = await fetchDynamicTurnServers(config, vi.fn().mockResolvedValue(new Response(JSON.stringify({
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      iceServers: [{ urls: ['turn:turn.example.test:3478?transport=udp', 'turns:turn.example.test:5349'], username: 'temporary-user', credential: 'temporary-password' }]
    }), { status: 200 })))
    expect(valid).toEqual([{
      urls: ['turn:turn.example.test:3478?transport=udp', 'turns:turn.example.test:5349'],
      username: 'temporary-user',
      credential: 'temporary-password'
    }])

    const expired = await fetchDynamicTurnServers(config, vi.fn().mockResolvedValue(new Response(JSON.stringify({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      iceServers: [{ urls: 'turn:turn.example.test:3478', username: 'u', credential: 'p' }]
    }), { status: 200 })))
    expect(expired).toEqual([])
  })

  it('does not fetch TURN credentials when no dynamic endpoint is configured', async () => {
    const fetcher = vi.fn()
    expect(await fetchDynamicTurnServers(fallbackNetworkBootstrapConfig(), fetcher)).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })
})
