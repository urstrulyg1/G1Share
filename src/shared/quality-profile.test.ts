import { describe, expect, it } from 'vitest'
import {
  ADAPTATION_TUNING,
  initialAdaptationState,
  nextAdaptationState,
  parseProfileNotice,
  parseProfileNoticePayload,
  parseQualityPayload,
  parseQualityRequest,
  QUALITY_PROFILES
} from './quality-profile'
import type { AdaptationSample, AdaptationState } from './quality-profile'

const healthy: AdaptationSample = { qualityLimitation: 'none', roundTripTimeMs: 20, packetLossPercent: 0, availableKbps: 10_000 }
const bandwidthLimited: AdaptationSample = { ...healthy, qualityLimitation: 'bandwidth' }
/** Congestion evidence that does not depend on the encoder's self-reported limitation. */
const lossy: AdaptationSample = { ...healthy, packetLossPercent: 5 }
/** A queue building at a bottleneck: RTT well above the session minimum (20 ms in these tests). */
const queued: AdaptationSample = { ...healthy, roundTripTimeMs: 20 + ADAPTATION_TUNING.queueDelayMs + 20 }
const cpuLimited: AdaptationSample = { ...healthy, qualityLimitation: 'cpu' }

function run(state: AdaptationState, samples: AdaptationSample[], startAt: number, stepMs = 2000): AdaptationState {
  let current = state
  samples.forEach((sample, index) => { current = nextAdaptationState(current, sample, startAt + (index + 1) * stepMs) })
  return current
}

describe('quality profiles', () => {
  it('defines the ultra profile with a higher frame rate than the balanced profile', () => {
    expect(QUALITY_PROFILES.ultra.frameRate).toBeGreaterThan(QUALITY_PROFILES.balanced.frameRate)
    expect(QUALITY_PROFILES.ultra.playoutDelaySeconds).toBe(0)
    expect(QUALITY_PROFILES.low.maxBitrateKbps).toBeLessThan(QUALITY_PROFILES.balanced.maxBitrateKbps)
  })
})

describe('quality protocol messages', () => {
  it('accepts only known profile identifiers in quality requests', () => {
    expect(parseQualityRequest({ type: 'session:quality', profile: 'ultra' })).toEqual({ type: 'session:quality', profile: 'ultra' })
    expect(parseQualityRequest({ type: 'session:quality', profile: 'auto' })).toEqual({ type: 'session:quality', profile: 'auto' })
    expect(parseQualityRequest({ type: 'session:quality', profile: 'max' })).toBeNull()
    expect(parseQualityRequest({ type: 'session:quality', profile: 'ultra', bitrate: 99_999 })).toBeNull()
    expect(parseQualityRequest({ type: 'input:move', profile: 'ultra' })).toBeNull()
    expect(parseQualityRequest(null)).toBeNull()
  })

  it('rejects oversized, malformed, and non-JSON payloads', () => {
    expect(parseQualityPayload('{"type":"session:quality","profile":"low"}')).toEqual({ type: 'session:quality', profile: 'low' })
    expect(parseQualityPayload('not json')).toBeNull()
    expect(parseQualityPayload('x'.repeat(201))).toBeNull()
    expect(parseQualityPayload(42)).toBeNull()
  })

  it('never lets a host notice name "auto" as the effective profile', () => {
    expect(parseProfileNotice({ type: 'session:profile', profile: 'balanced', mode: 'auto' })).toEqual({ type: 'session:profile', profile: 'balanced', mode: 'auto' })
    expect(parseProfileNotice({ type: 'session:profile', profile: 'auto', mode: 'auto' })).toBeNull()
    expect(parseProfileNotice({ type: 'session:profile', profile: 'low', mode: 'sometimes' })).toBeNull()
    expect(parseProfileNoticePayload('{"type":"session:profile","profile":"low","mode":"manual"}')).not.toBeNull()
  })
})

describe('auto adaptation', () => {
  const start = 1_000_000

  it('starts at the balanced profile', () => {
    expect(initialAdaptationState(start).current).toBe('balanced')
  })

  it('does not step down on a bandwidth limitation alone (measured regression: ramp-up on an idle loopback link)', () => {
    // The congestion controller reports "bandwidth" while it ramps up, with no loss and no queueing. Stepping
    // down on that stepped healthy sessions to the low profile and added a 100 ms playout target.
    const initial = { ...initialAdaptationState(start), changedAt: start - 60_000 }
    const rampUp = run(initial, Array(10).fill(bandwidthLimited), start)
    expect(rampUp.current).toBe('balanced')
  })

  it('steps down after sustained loss, and not after a single sample', () => {
    const initial = initialAdaptationState(start)
    expect(run(initial, [lossy], start).current).toBe('balanced')
    expect(run(initial, [lossy, lossy], start).current).toBe('low')
  })

  it('steps down after sustained queueing delay measured against the session minimum RTT', () => {
    const initial = { ...initialAdaptationState(start), changedAt: start - 60_000 }
    // The first healthy sample establishes the 20 ms minimum; queued samples sit 40 ms above it.
    expect(run(initial, [healthy, queued], start).current).toBe('balanced')
    expect(run(initial, [healthy, queued, queued], start).current).toBe('low')
  })

  it('keeps the minimum RTT across samples, so a slowly rising RTT is still seen as queueing', () => {
    const initial = { ...initialAdaptationState(start), changedAt: start - 60_000 }
    // Each step is under the 50 ms queueing threshold relative to the previous sample, but not relative to the minimum.
    const drift = [20, 45, 70, 95, 120].map(rtt => ({ ...healthy, roundTripTimeMs: rtt }))
    const state = run(initial, drift, start)
    expect(state.baseRttMs).toBe(20)
    expect(state.current).toBe('low')
  })

  it('treats CPU limitation as pressure, because a 60 fps encode cannot keep up on a busy host', () => {
    const state = run({ ...initialAdaptationState(start), current: 'ultra', changedAt: start - 60_000 }, [cpuLimited, cpuLimited], start)
    expect(state.current).toBe('balanced')
  })

  it('steps up slowly and only when bandwidth is available', () => {
    const initial = { ...initialAdaptationState(start), changedAt: start - 60_000 }
    const notEnough = run(initial, Array(5).fill({ ...healthy, availableKbps: 3_000 }), start)
    expect(notEnough.current).toBe('balanced')
    const enough = run(initial, Array(ADAPTATION_TUNING.upSamples).fill({ ...healthy, availableKbps: 9_000 }), start)
    expect(enough.current).toBe('ultra')
  })

  it('does not change profile more than once within the dwell period', () => {
    const initial = { ...initialAdaptationState(start), changedAt: start - 60_000 }
    const down = run(initial, [lossy, lossy], start)
    expect(down.current).toBe('low')
    const immediatelyHealthy = run(down, Array(ADAPTATION_TUNING.upSamples).fill({ ...healthy, availableKbps: 9_000 }), down.changedAt)
    expect(immediatelyHealthy.current).toBe('low')
    const later = run(down, Array(ADAPTATION_TUNING.upSamples).fill({ ...healthy, availableKbps: 9_000 }), down.changedAt + ADAPTATION_TUNING.dwellMs)
    expect(later.current).toBe('balanced')
  })

  it('does not oscillate when samples alternate around a threshold', () => {
    const initial = { ...initialAdaptationState(start), changedAt: start - 60_000 }
    const borderline: AdaptationSample[] = []
    for (let index = 0; index < 60; index += 1) {
      borderline.push(index % 2 === 0 ? lossy : { ...healthy, availableKbps: 3_000 })
    }
    const result = run(initial, borderline, start)
    expect(result.current).toBe('balanced')
    expect(result.changedAt).toBe(initial.changedAt)
  })

  it('treats unknown loss and RTT as neutral rather than as health', () => {
    const initial = { ...initialAdaptationState(start), changedAt: start - 60_000 }
    const unknown: AdaptationSample = { qualityLimitation: 'none', roundTripTimeMs: null, packetLossPercent: null, availableKbps: 9_000 }
    expect(run(initial, Array(ADAPTATION_TUNING.upSamples).fill(unknown), start).current).toBe('ultra')
  })

  it('keeps the high-quality profile out of automatic adaptation', () => {
    const initial = { ...initialAdaptationState(start), current: 'ultra' as const, changedAt: start - 60_000 }
    const state = run(initial, Array(10).fill(healthy), start)
    expect(state.current).toBe('ultra')
  })
})
