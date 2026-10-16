export const DEFAULT_NETWORK_CONFIG_URL =
  'https://raw.githubusercontent.com/urstrulyg1/G1Viewer/main/config/network-bootstrap.json'

export const FALLBACK_RELAY_URL = 'https://ntfy.sh'
export const FALLBACK_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
  'stun:stun.cloudflare.com:3478'
] as const

export interface NetworkBootstrapConfig {
  schemaVersion: 1
  relayUrl: string
  stunUrls: string[]
  turnCredentialsUrl?: string
  cacheTtlSeconds: number
}

export interface IceServerConfig {
  urls: string | string[]
  username?: string
  credential?: string
}

type FetchLike = typeof fetch

const DEFAULT_CACHE_TTL_SECONDS = 900
const MIN_CACHE_TTL_SECONDS = 60
const MAX_CACHE_TTL_SECONDS = 21_600
const FETCH_TIMEOUT_MS = 2_500
let cached: { configUrl: string; expiresAt: number; config: NetworkBootstrapConfig } | null = null

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseHttpsEndpoint(value: unknown, allowPath: boolean): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null
    if (!parsed.hostname || (!allowPath && parsed.pathname !== '/' && parsed.pathname !== '')) return null
    return allowPath ? `${parsed.origin}${parsed.pathname.replace(/\\/+$/, '')}` : parsed.origin
  } catch {
    return null
  }
}

function isStunUrl(value: unknown): value is string {
  return typeof value === 'string' && /^stuns?:[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(value)
}

export function parseNetworkBootstrapConfig(value: unknown): NetworkBootstrapConfig | null {
  if (!isPlainObject(value) || value.schemaVersion !== 1) return null
  const relayUrl = parseHttpsEndpoint(value.relayUrl, true)
  if (!relayUrl || !Array.isArray(value.stunUrls) || value.stunUrls.length < 1 || value.stunUrls.length > 12) return null
  if (!value.stunUrls.every(isStunUrl)) return null

  let turnCredentialsUrl: string | undefined
  if (value.turnCredentialsUrl !== undefined && value.turnCredentialsUrl !== null && value.turnCredentialsUrl !== '') {
    const parsed = parseHttpsEndpoint(value.turnCredentialsUrl, true)
    if (!parsed) return null
    turnCredentialsUrl = parsed
  }

  const requestedTtl = typeof value.cacheTtlSeconds === 'number' && Number.isFinite(value.cacheTtlSeconds)
    ? Math.floor(value.cacheTtlSeconds)
    : DEFAULT_CACHE_TTL_SECONDS

  return {
    schemaVersion: 1,
    relayUrl,
    stunUrls: Array.from(new Set(value.stunUrls)),
    ...(turnCredentialsUrl ? { turnCredentialsUrl } : {}),
    cacheTtlSeconds: Math.max(MIN_CACHE_TTL_SECONDS, Math.min(MAX_CACHE_TTL_SECONDS, requestedTtl))
  }
}

export function fallbackNetworkBootstrapConfig(): NetworkBootstrapConfig {
  return {
    schemaVersion: 1,
    relayUrl: FALLBACK_RELAY_URL,
    stunUrls: [...FALLBACK_STUN_URLS],
    cacheTtlSeconds: DEFAULT_CACHE_TTL_SECONDS
  }
}

/** Fetch provider settings at runtime; invalid or unavailable bootstrap data safely falls back. */
export async function loadNetworkBootstrapConfig(
  fetcher: FetchLike = fetch,
  configUrl = process.env.G1VIEWER_NETWORK_CONFIG_URL?.trim() || DEFAULT_NETWORK_CONFIG_URL
): Promise<NetworkBootstrapConfig> {
  const now = Date.now()
  if (cached && cached.configUrl === configUrl && cached.expiresAt > now) return cached.config

  try {
    const endpoint = parseHttpsEndpoint(configUrl, false)
    if (!endpoint) throw new Error('Network bootstrap URL must be a trusted HTTPS origin.')
    const response = await fetcher(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`Network bootstrap returned HTTP ${response.status}.`)
    const parsed = parseNetworkBootstrapConfig(await response.json())
    if (!parsed) throw new Error('Network bootstrap schema is invalid.')
    cached = { configUrl, config: parsed, expiresAt: now + parsed.cacheTtlSeconds * 1000 }
    return parsed
  } catch {
    return fallbackNetworkBootstrapConfig()
  }
}

function isTurnUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false
  return /^turns?:[A-Za-z0-9.:[\]-]+(?::[0-9]{1,5})?(?:\\?transport=(?:udp|tcp))?$/.test(value)
}

/** TURN credentials must be fetched over HTTPS and carry an explicit short expiry. */
export async function fetchDynamicTurnServers(
  config: NetworkBootstrapConfig,
  fetcher: FetchLike = fetch
): Promise<IceServerConfig[]> {
  if (!config.turnCredentialsUrl) return []
  try {
    const response = await fetcher(config.turnCredentialsUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!response.ok) return []
    const value: unknown = await response.json()
    if (!isPlainObject(value) || typeof value.expiresAt !== 'string') return []
    const expiresAt = Date.parse(value.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 24 * 60 * 60 * 1000) return []
    if (!Array.isArray(value.iceServers) || value.iceServers.length > 8) return []

    const result: IceServerConfig[] = []
    for (const item of value.iceServers) {
      if (!isPlainObject(item)) continue
      const urls = typeof item.urls === 'string' ? [item.urls] : item.urls
      if (!Array.isArray(urls) || urls.length < 1 || urls.length > 8 || !urls.every(isTurnUrl)) continue
      if (typeof item.username !== 'string' || !item.username || item.username.length > 512 ||
          typeof item.credential !== 'string' || !item.credential || item.credential.length > 2048) continue
      result.push({ urls: urls as string[], username: item.username, credential: item.credential })
    }
    return result
  } catch {
    return []
  }
}

/** Test-only cache reset, kept explicit so production callers cannot depend on cached state. */
export function resetNetworkBootstrapCacheForTests(): void {
  cached = null
}
