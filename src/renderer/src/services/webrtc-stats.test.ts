import { describe, expect, it } from 'vitest'
import {
  classifyCandidateTypes,
  describePath,
  inboundInterval,
  outboundInterval,
  readInboundVideo,
  readOutboundVideo,
  readPath,
  type InboundVideoSample,
  type OutboundVideoSample
} from './webrtc-stats'

/** Minimal stand-in for RTCStatsReport: a Map with forEach, which is all the readers use. */
function reportOf(entries: Array<Record<string, unknown> & { id: string; type: string }>): RTCStatsReport {
  const map = new Map(entries.map(entry => [entry.id, entry]))
  return map as unknown as RTCStatsReport
}

const inbound = (overrides: Partial<InboundVideoSample>): InboundVideoSample => ({
  timestamp: 0, width: 800, height: 450, bytes: 0, framesDecoded: 0, framesDropped: 0,
  jitterBufferDelay: 0, jitterBufferEmittedCount: 0, totalDecodeTime: 0, packetsLost: 0, packetsReceived: 0,
  ...overrides
})

const outbound = (overrides: Partial<OutboundVideoSample>): OutboundVideoSample => ({
  timestamp: 0, bytes: 0, framesEncoded: 0, totalEncodeTime: 0, ...overrides
})

describe('inboundInterval', () => {
  it('returns no rates before there is a previous sample', () => {
    const result = inboundInterval(null, inbound({ framesDropped: 4 }))
    expect(result.framesPerSecond).toBeNull()
    expect(result.bitrateKbps).toBeNull()
    expect(result.droppedFrames).toBeNull() // A lifetime total is not an interval measurement.
  })

  it('computes frame rate, bitrate, jitter buffer, decode time and loss from deltas', () => {
    const previous = inbound({ timestamp: 1000, bytes: 0, framesDecoded: 10, jitterBufferDelay: 0, jitterBufferEmittedCount: 0, totalDecodeTime: 0, packetsLost: 0, packetsReceived: 100 })
    const current = inbound({ timestamp: 2000, bytes: 125_000, framesDecoded: 40, framesDropped: 2, jitterBufferDelay: 0.9, jitterBufferEmittedCount: 30, totalDecodeTime: 0.6, packetsLost: 1, packetsReceived: 199 })
    const result = inboundInterval(previous, current)
    expect(result.framesPerSecond).toBeCloseTo(30, 6)
    expect(result.bitrateKbps).toBeCloseTo(1000, 6) // 125000 bytes * 8 bits over 1 s
    expect(result.jitterBufferMs).toBeCloseTo(30, 6) // 0.9 s over 30 frames
    expect(result.decodeMs).toBeCloseTo(20, 6) // 0.6 s of decode time over 30 new frames
    expect(result.droppedFrames).toBe(2)
    expect(result.packetLossPercent).toBeCloseTo(1, 6) // 1 lost of 100 new packets
  })

  it('reports null, not a negative rate, when counters go backwards', () => {
    const previous = inbound({ timestamp: 1000, bytes: 500, framesDecoded: 50 })
    const current = inbound({ timestamp: 2000, bytes: 100, framesDecoded: 10 })
    const result = inboundInterval(previous, current)
    expect(result.bitrateKbps).toBeNull()
    expect(result.framesPerSecond).toBeNull()
  })

  it('returns no interval for a non-advancing clock', () => {
    const sample = inbound({ timestamp: 1000, framesDecoded: 1 })
    expect(inboundInterval(sample, { ...sample, framesDecoded: 2 }).framesPerSecond).toBeNull()
  })

  it('does not turn missing counters into fabricated zero fps, bitrate or loss', () => {
    const previous = inbound({ timestamp: 1000, bytes: null, framesDecoded: null, framesDropped: null, packetsLost: null, packetsReceived: null })
    const current = inbound({ timestamp: 2000, bytes: null, framesDecoded: null, framesDropped: null, packetsLost: null, packetsReceived: null })
    expect(inboundInterval(previous, current)).toEqual({
      framesPerSecond: null, bitrateKbps: null, jitterBufferMs: null,
      decodeMs: null, droppedFrames: null, packetLossPercent: null
    })
    expect(outboundInterval(outbound({ timestamp: 1000, bytes: null, framesEncoded: null, totalEncodeTime: null }), outbound({ timestamp: 2000, bytes: null, framesEncoded: null, totalEncodeTime: null }))).toEqual({
      framesPerSecond: null, bitrateKbps: null, encodeMs: null
    })
  })
})

describe('outboundInterval', () => {
  it('derives encode time per frame and bitrate', () => {
    const previous = outbound({ timestamp: 0, bytes: 0, framesEncoded: 0, totalEncodeTime: 0 })
    const current = outbound({ timestamp: 1000, bytes: 50_000, framesEncoded: 30, totalEncodeTime: 0.09 })
    const result = outboundInterval(previous, current)
    expect(result.framesPerSecond).toBeCloseTo(30, 6)
    expect(result.bitrateKbps).toBeCloseTo(400, 6)
    expect(result.encodeMs).toBeCloseTo(3, 6)
  })
})

describe('readInboundVideo', () => {
  it('ignores remote and audio entries', () => {
    const report = reportOf([
      { id: 'a', type: 'inbound-rtp', kind: 'audio', bytesReceived: 999 },
      { id: 'b', type: 'inbound-rtp', kind: 'video', isRemote: true, bytesReceived: 888 },
      { id: 'c', type: 'inbound-rtp', kind: 'video', frameWidth: 640, frameHeight: 360, bytesReceived: 7, timestamp: 5 }
    ])
    const sample = readInboundVideo(report)
    expect(sample?.width).toBe(640)
    expect(sample?.bytes).toBe(7)
    expect(sample?.timestamp).toBe(5)
  })

  it('returns null when no local inbound video stream exists', () => {
    expect(readInboundVideo(reportOf([{ id: 'x', type: 'transport' }]))).toBeNull()
  })

  it('keeps missing per-stream fields unavailable rather than inventing zero values', () => {
    const sample = readInboundVideo(reportOf([{ id: 'v', type: 'inbound-rtp', kind: 'video', timestamp: 1000 }]))
    expect(sample?.bytes).toBeNull()
    expect(sample?.framesDecoded).toBeNull()
    expect(sample?.width).toBeNull()
    expect(sample?.packetsLost).toBeNull()
    expect(readInboundVideo(reportOf([{ id: 'v', type: 'inbound-rtp', kind: 'video' }]))).toBeNull()
  })
})

describe('readOutboundVideo', () => {
  it('joins the receiver report (fraction lost, RTT) and the encoder limitation', () => {
    const report = reportOf([
      { id: 'o', type: 'outbound-rtp', kind: 'video', bytesSent: 10, framesEncoded: 3, totalEncodeTime: 0.01, qualityLimitationReason: 'bandwidth', timestamp: 9 },
      { id: 'r', type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.02, roundTripTime: 0.012 }
    ])
    const result = readOutboundVideo(report)
    expect(result?.qualityLimitation).toBe('bandwidth')
    expect(result?.remotePacketLossPercent).toBeCloseTo(2, 6)
    expect(result?.remoteRoundTripTimeMs).toBeCloseTo(12, 6)
    expect(result?.sample.framesEncoded).toBe(3)
  })

  it('reports null receiver values when no receiver report has arrived yet', () => {
    const report = reportOf([{ id: 'o', type: 'outbound-rtp', kind: 'video', bytesSent: 1, timestamp: 1000 }])
    const result = readOutboundVideo(report)
    expect(result?.remotePacketLossPercent).toBeNull()
    expect(result?.remoteRoundTripTimeMs).toBeNull()
    expect(result?.qualityLimitation).toBeNull()
  })
})

describe('classifyCandidateTypes', () => {
  it('reports direct only when both candidates are non-relayed', () => {
    expect(classifyCandidateTypes('host', 'host')).toBe('direct-lan')
    expect(classifyCandidateTypes('srflx', 'host')).toBe('direct-nat')
    expect(classifyCandidateTypes('prflx', 'srflx')).toBe('direct-nat')
  })

  it('treats any relayed side as relayed, even when the other side is direct', () => {
    expect(classifyCandidateTypes('relay', 'host')).toBe('relayed')
    expect(classifyCandidateTypes('host', 'relay')).toBe('relayed')
  })

  it('stays unknown when either candidate type is missing', () => {
    expect(classifyCandidateTypes(null, 'host')).toBe('unknown')
    expect(classifyCandidateTypes('host', null)).toBe('unknown')
    expect(classifyCandidateTypes('undocumented', 'host')).toBe('unknown')
  })
})

describe('readPath', () => {
  const pairWith = (local: string | null, remote: string | null, extra: Record<string, unknown> = {}) => [
    { id: 'lc', type: 'local-candidate', candidateType: local },
    { id: 'rc', type: 'remote-candidate', candidateType: remote },
    { id: 'pair', type: 'candidate-pair', state: 'succeeded', selected: true, localCandidateId: 'lc', remoteCandidateId: 'rc', ...extra }
  ]

  it('classifies the selected succeeded pair', () => {
    expect(readPath(reportOf(pairWith('host', 'host')))).toEqual({ kind: 'direct-lan', localType: 'host', remoteType: 'host' })
  })

  it('ignores pairs that are not selected or not succeeded', () => {
    const entries = [
      { id: 'lc', type: 'local-candidate', candidateType: 'relay' },
      { id: 'rc', type: 'remote-candidate', candidateType: 'relay' },
      { id: 'pair', type: 'candidate-pair', state: 'in-progress', selected: true, localCandidateId: 'lc', remoteCandidateId: 'rc' }
    ]
    expect(readPath(reportOf(entries)).kind).toBe('unknown')
  })

  it('accepts a nominated pair when the browser does not mark it selected', () => {
    const entries = pairWith('srflx', 'host', { selected: undefined, nominated: true })
    expect(readPath(reportOf(entries)).kind).toBe('direct-nat')
  })

  it('reports unknown when the pair references a candidate that is absent', () => {
    const entries = pairWith('host', 'host').filter(entry => entry.id !== 'rc')
    expect(readPath(reportOf(entries)).kind).toBe('unknown')
  })

  it('describes each path kind in user-facing words', () => {
    expect(describePath({ kind: 'direct-lan', localType: 'host', remoteType: 'host' })).toBe('Direct (host candidates)')
    expect(describePath({ kind: 'direct-nat', localType: 'srflx', remoteType: 'host' })).toBe('Direct (via NAT traversal)')
    expect(describePath({ kind: 'relayed', localType: 'relay', remoteType: 'host' })).toBe('Relayed through TURN')
    expect(describePath({ kind: 'unknown', localType: null, remoteType: null })).toBe('Path not yet confirmed')
  })
})
