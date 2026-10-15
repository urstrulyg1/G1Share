// Quality profiles trade frame rate, resolution, and bitrate against responsiveness. They are shared by the
// renderer (sender and receiver configuration) and by the tests. Every value here is a configured target, not a
// measurement: the measured outcome is reported by the benchmark in docs/performance.

export const QUALITY_PROFILE_IDS = ['auto', 'ultra', 'balanced', 'high', 'low'] as const
export type QualityProfileId = typeof QUALITY_PROFILE_IDS[number]
/** A concrete profile. `auto` resolves to one of these at any moment. */
export type EffectiveProfileId = Exclude<QualityProfileId, 'auto'>

export interface QualityProfile {
  id: EffectiveProfileId
  label: string
  /** Ideal capture width. Capture never upscales, so this is a ceiling for the shared display. */
  width: number
  /** Capture and encoder frame rate target (ideal and maximum). */
  frameRate: number
  /** Upper bound on the encoder's output bitrate. Congestion control may still choose a lower rate. */
  maxBitrateKbps: number
  /** What the encoder sacrifices first when the link or CPU cannot keep up. */
  degradationPreference: 'maintain-framerate' | 'maintain-resolution'
  contentHint: 'motion' | 'detail'
  /**
   * Receiver jitter-buffer hint in seconds. 0 asks the browser for the smallest playout delay it can sustain; a
   * larger value trades latency for smoothness on lossy links. null keeps the browser default.
   */
  playoutDelaySeconds: number | null
}

export const QUALITY_PROFILES: Readonly<Record<EffectiveProfileId, QualityProfile>> = Object.freeze({
  ultra: { id: 'ultra', label: 'Ultra-responsive (60 FPS)', width: 1920, frameRate: 60, maxBitrateKbps: 12000, degradationPreference: 'maintain-framerate', contentHint: 'motion', playoutDelaySeconds: 0 },
  balanced: { id: 'balanced', label: 'Balanced (30 FPS)', width: 1600, frameRate: 30, maxBitrateKbps: 6000, degradationPreference: 'maintain-framerate', contentHint: 'motion', playoutDelaySeconds: 0 },
  high: { id: 'high', label: 'High quality (60 FPS)', width: 1920, frameRate: 60, maxBitrateKbps: 16000, degradationPreference: 'maintain-framerate', contentHint: 'detail', playoutDelaySeconds: 0 },
  low: { id: 'low', label: 'Low bandwidth (15 FPS)', width: 960, frameRate: 15, maxBitrateKbps: 1000, degradationPreference: 'maintain-framerate', contentHint: 'motion', playoutDelaySeconds: null }
})

/** Auto mode moves along this ladder only. `high` is chosen explicitly, never by adaptation. */
export const AUTO_LADDER: readonly EffectiveProfileId[] = ['low', 'balanced', 'ultra']
export const AUTO_START: EffectiveProfileId = 'balanced'

export function isQualityProfileId(value: unknown): value is QualityProfileId {
  return typeof value === 'string' && (QUALITY_PROFILE_IDS as readonly string[]).includes(value)
}

/** Viewer -> host request. Validated strictly because it arrives over the peer data channel. */
export interface QualityRequest { type: 'session:quality'; profile: QualityProfileId }
/** Host -> viewer notice describing the profile the sender is now using. */
export interface ProfileNotice { type: 'session:profile'; profile: EffectiveProfileId; mode: 'auto' | 'manual' }

const MAX_PROTOCOL_BYTES = 200

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

export function parseQualityRequest(value: unknown): QualityRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  if (message.type !== 'session:quality' || !onlyKeys(message, ['type', 'profile']) || !isQualityProfileId(message.profile)) return null
  return { type: 'session:quality', profile: message.profile }
}

export function parseProfileNotice(value: unknown): ProfileNotice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  if (message.type !== 'session:profile' || !onlyKeys(message, ['type', 'profile', 'mode'])) return null
  if (!isQualityProfileId(message.profile) || message.profile === 'auto') return null
  if (message.mode !== 'auto' && message.mode !== 'manual') return null
  return { type: 'session:profile', profile: message.profile, mode: message.mode }
}

/** Parses a data-channel payload that is a quality request. Oversized or non-JSON payloads return null. */
export function parseQualityPayload(payload: unknown): QualityRequest | null {
  if (typeof payload !== 'string' || payload.length > MAX_PROTOCOL_BYTES) return null
  try { return parseQualityRequest(JSON.parse(payload)) } catch { return null }
}

export function parseProfileNoticePayload(payload: unknown): ProfileNotice | null {
  if (typeof payload !== 'string' || payload.length > MAX_PROTOCOL_BYTES) return null
  try { return parseProfileNotice(JSON.parse(payload)) } catch { return null }
}

/** One observation of the sender's link and encoder, taken on the metrics cadence. */
export interface AdaptationSample {
  /** Browser-reported reason the encoder is limited, or 'none'. */
  qualityLimitation: 'none' | 'bandwidth' | 'cpu' | 'other' | null
  roundTripTimeMs: number | null
  /** Fraction of packets the receiver reports lost, in percent. */
  packetLossPercent: number | null
  /** Congestion controller's estimate of the outgoing bandwidth, in kb/s. */
  availableKbps: number | null
}

export interface AdaptationState {
  current: EffectiveProfileId
  /** Consecutive samples that were congested (down-pressure). */
  congestedRun: number
  /** Consecutive samples that were clearly healthy (up-pressure). */
  healthyRun: number
  /** Timestamp, in ms, of the last profile change. */
  changedAt: number
  /** Lowest round-trip time seen in this session. Queueing delay is measured against it. */
  baseRttMs: number | null
}

export const ADAPTATION_TUNING = Object.freeze({
  /** Consecutive pressured samples required before stepping down. At the 2 s metrics cadence this is 4 s. */
  downSamples: 2,
  /** Consecutive healthy samples required before stepping up. At 2 s this is 6 s, deliberately slower than down. */
  upSamples: 3,
  /** Minimum time between two changes, so that a single change can settle before the next decision. */
  dwellMs: 10_000,
  congestedLossPercent: 3,
  congestedRttMs: 300,
  /** Round-trip time this far above the session minimum means packets are queueing at a bottleneck. */
  queueDelayMs: 50,
  healthyLossPercent: 1,
  healthyRttMs: 150,
  /** Bandwidth needed before stepping up to each profile, in kb/s. */
  bandwidthForUpKbps: { balanced: 2_500, ultra: 6_000 } as Partial<Record<EffectiveProfileId, number>>
})

export function initialAdaptationState(now: number): AdaptationState {
  return { current: AUTO_START, congestedRun: 0, healthyRun: 0, changedAt: now - ADAPTATION_TUNING.dwellMs, baseRttMs: null }
}

/**
 * Congestion is evidence of loss or queueing, or a CPU that cannot keep up. A bandwidth limitation on its own is not
 * congestion: the congestion controller reports it while it ramps up from its initial estimate, even on an idle
 * link with no loss and no queueing. Measured on loopback, treating it as congestion stepped healthy sessions down.
 */
function isCongested(sample: AdaptationSample, baseRttMs: number | null): boolean {
  if (sample.qualityLimitation === 'cpu') return true
  if (sample.packetLossPercent !== null && sample.packetLossPercent >= ADAPTATION_TUNING.congestedLossPercent) return true
  if (sample.roundTripTimeMs !== null && sample.roundTripTimeMs >= ADAPTATION_TUNING.congestedRttMs) return true
  if (sample.roundTripTimeMs !== null && baseRttMs !== null && sample.roundTripTimeMs - baseRttMs >= ADAPTATION_TUNING.queueDelayMs) return true
  return false
}

function isHealthy(sample: AdaptationSample, target: EffectiveProfileId): boolean {
  if (sample.qualityLimitation !== 'none' && sample.qualityLimitation !== null) return false
  if (sample.packetLossPercent !== null && sample.packetLossPercent > ADAPTATION_TUNING.healthyLossPercent) return false
  if (sample.roundTripTimeMs !== null && sample.roundTripTimeMs > ADAPTATION_TUNING.healthyRttMs) return false
  const need = ADAPTATION_TUNING.bandwidthForUpKbps[target]
  if (need !== undefined && (sample.availableKbps === null || sample.availableKbps < need)) return false
  return true
}

/**
 * Pure adaptation step for `auto` mode. It steps down quickly after sustained pressure and steps up slowly after
 * sustained health, and never changes more than once per dwell period. Those three rules are what prevent the
 * profile from oscillating when the link sits near a threshold.
 */
export function nextAdaptationState(state: AdaptationState, sample: AdaptationSample, now: number): AdaptationState {
  const baseRttMs = sample.roundTripTimeMs === null
    ? state.baseRttMs
    : state.baseRttMs === null ? sample.roundTripTimeMs : Math.min(state.baseRttMs, sample.roundTripTimeMs)
  const congested = isCongested(sample, baseRttMs)
  const index = AUTO_LADDER.indexOf(state.current)
  const congestedRun = congested ? state.congestedRun + 1 : 0
  const upTarget = AUTO_LADDER[index + 1]
  const healthyRun = !congested && upTarget !== undefined && isHealthy(sample, upTarget) ? state.healthyRun + 1 : 0
  const dwellOver = now - state.changedAt >= ADAPTATION_TUNING.dwellMs

  if (dwellOver && congestedRun >= ADAPTATION_TUNING.downSamples && index > 0) {
    return { current: AUTO_LADDER[index - 1], congestedRun: 0, healthyRun: 0, changedAt: now, baseRttMs }
  }
  if (dwellOver && healthyRun >= ADAPTATION_TUNING.upSamples && upTarget !== undefined) {
    return { current: upTarget, congestedRun: 0, healthyRun: 0, changedAt: now, baseRttMs }
  }
  return { ...state, congestedRun, healthyRun, baseRttMs }
}
