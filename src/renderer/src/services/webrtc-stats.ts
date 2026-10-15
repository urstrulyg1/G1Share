// Turns raw RTCStatsReport counters into interval measurements. Every value here is derived from counters
// that the browser reports for real media (no estimates), and every rate is computed over the time between
// two samples, so the numbers describe recent behaviour rather than lifetime averages.

export type PathKind = 'direct-lan' | 'direct-nat' | 'relayed' | 'unknown'

export interface PathInfo {
  kind: PathKind
  localType: string | null
  remoteType: string | null
}

export interface InboundVideoSample {
  timestamp: number
  width: number
  height: number
  bytes: number
  framesDecoded: number
  framesDropped: number
  jitterBufferDelay: number
  jitterBufferEmittedCount: number
  totalDecodeTime: number
  packetsLost: number
  packetsReceived: number
}

export interface OutboundVideoSample {
  timestamp: number
  bytes: number
  framesEncoded: number
  totalEncodeTime: number
}

export interface InboundVideoInterval {
  framesPerSecond: number | null
  bitrateKbps: number | null
  /** Average time a frame waited in the receive jitter buffer during the interval. */
  jitterBufferMs: number | null
  /** Average hardware or software decode time per frame during the interval. */
  decodeMs: number | null
  droppedFrames: number
  packetLossPercent: number | null
}

export interface OutboundVideoInterval {
  framesPerSecond: number | null
  bitrateKbps: number | null
  /** Average encode time per frame during the interval. */
  encodeMs: number | null
}

/** Derives interval values from two consecutive inbound samples. Returns an empty interval when time did not advance. */
export function inboundInterval(previous: InboundVideoSample | null, current: InboundVideoSample): InboundVideoInterval {
  const empty: InboundVideoInterval = { framesPerSecond: null, bitrateKbps: null, jitterBufferMs: null, decodeMs: null, droppedFrames: current.framesDropped, packetLossPercent: null }
  if (!previous) return empty
  const elapsed = current.timestamp - previous.timestamp
  if (!(elapsed > 0)) return empty
  const frames = current.framesDecoded - previous.framesDecoded
  const emitted = current.jitterBufferEmittedCount - previous.jitterBufferEmittedCount
  const lost = current.packetsLost - previous.packetsLost
  const received = current.packetsReceived - previous.packetsReceived
  const packetTotal = lost + received
  return {
    framesPerSecond: frames >= 0 ? frames * 1000 / elapsed : null,
    bitrateKbps: current.bytes >= previous.bytes ? (current.bytes - previous.bytes) * 8 / elapsed : null,
    jitterBufferMs: emitted > 0 ? (current.jitterBufferDelay - previous.jitterBufferDelay) * 1000 / emitted : null,
    decodeMs: frames > 0 ? (current.totalDecodeTime - previous.totalDecodeTime) * 1000 / frames : null,
    droppedFrames: Math.max(0, current.framesDropped - previous.framesDropped),
    packetLossPercent: packetTotal > 0 && lost >= 0 ? lost * 100 / packetTotal : null
  }
}

export function outboundInterval(previous: OutboundVideoSample | null, current: OutboundVideoSample): OutboundVideoInterval {
  const empty: OutboundVideoInterval = { framesPerSecond: null, bitrateKbps: null, encodeMs: null }
  if (!previous) return empty
  const elapsed = current.timestamp - previous.timestamp
  if (!(elapsed > 0)) return empty
  const frames = current.framesEncoded - previous.framesEncoded
  return {
    framesPerSecond: frames >= 0 ? frames * 1000 / elapsed : null,
    bitrateKbps: current.bytes >= previous.bytes ? (current.bytes - previous.bytes) * 8 / elapsed : null,
    encodeMs: frames > 0 ? (current.totalEncodeTime - previous.totalEncodeTime) * 1000 / frames : null
  }
}

interface StatLike {
  type: string
  id: string
  timestamp?: number
  [key: string]: unknown
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Reads the inbound video counters (non-remote, kind video) from a stats report. */
export function readInboundVideo(report: RTCStatsReport): InboundVideoSample | null {
  let found: InboundVideoSample | null = null
  report.forEach(raw => {
    const stat = raw as unknown as StatLike
    if (stat.type !== 'inbound-rtp' || stat.kind !== 'video' || stat.isRemote === true) return
    found = {
      timestamp: stat.timestamp ?? 0,
      width: num(stat.frameWidth),
      height: num(stat.frameHeight),
      bytes: num(stat.bytesReceived),
      framesDecoded: num(stat.framesDecoded),
      framesDropped: num(stat.framesDropped),
      jitterBufferDelay: num(stat.jitterBufferDelay),
      jitterBufferEmittedCount: num(stat.jitterBufferEmittedCount),
      totalDecodeTime: num(stat.totalDecodeTime),
      packetsLost: num(stat.packetsLost),
      packetsReceived: num(stat.packetsReceived)
    }
  })
  return found
}

export interface OutboundVideoReport {
  sample: OutboundVideoSample
  /** Browser-reported reason the encoder is limited (`none`, `bandwidth`, `cpu`, `other`), or null when absent. */
  qualityLimitation: string | null
  /** Receiver-reported loss fraction for this stream, in percent (RTCP receiver reports). */
  remotePacketLossPercent: number | null
  /** Receiver-reported round-trip time for this stream, in milliseconds (RTCP receiver reports). */
  remoteRoundTripTimeMs: number | null
}

/** Reads the outbound video counters, the encoder limitation reason, and the receiver's RTCP report for the stream. */
export function readOutboundVideo(report: RTCStatsReport): OutboundVideoReport | null {
  let found: OutboundVideoReport | null = null
  let remote: { packetLossPercent: number | null; roundTripTimeMs: number | null } = { packetLossPercent: null, roundTripTimeMs: null }
  report.forEach(raw => {
    const stat = raw as unknown as StatLike
    if (stat.type === 'remote-inbound-rtp' && stat.kind === 'video') {
      remote = {
        packetLossPercent: typeof stat.fractionLost === 'number' && Number.isFinite(stat.fractionLost) ? Math.max(0, stat.fractionLost) * 100 : null,
        roundTripTimeMs: typeof stat.roundTripTime === 'number' && Number.isFinite(stat.roundTripTime) ? stat.roundTripTime * 1000 : null
      }
      return
    }
    if (stat.type !== 'outbound-rtp' || stat.kind !== 'video' || stat.isRemote === true) return
    const reason = typeof stat.qualityLimitationReason === 'string' ? stat.qualityLimitationReason : null
    found = {
      sample: {
        timestamp: stat.timestamp ?? 0,
        bytes: num(stat.bytesSent),
        framesEncoded: num(stat.framesEncoded),
        totalEncodeTime: num(stat.totalEncodeTime)
      },
      qualityLimitation: reason,
      remotePacketLossPercent: null,
      remoteRoundTripTimeMs: null
    }
  })
  if (found) {
    const value: OutboundVideoReport = found
    value.remotePacketLossPercent = remote.packetLossPercent
    value.remoteRoundTripTimeMs = remote.roundTripTimeMs
    return value
  }
  return null
}

/**
 * Classifies the path of the selected, succeeded candidate pair. "direct" is reported only when both
 * candidates are non-relayed; a relayed candidate on either side means traffic goes through TURN.
 */
export function readPath(report: RTCStatsReport): PathInfo {
  const candidates = new Map<string, string>()
  let selected: StatLike | null = null
  report.forEach(raw => {
    const stat = raw as unknown as StatLike
    if (stat.type === 'local-candidate' || stat.type === 'remote-candidate') {
      if (typeof stat.candidateType === 'string') candidates.set(stat.id, stat.candidateType)
    }
    if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.selected === true || stat.nominated === true)) selected = stat
  })
  const pair = selected as StatLike | null
  if (!pair) return { kind: 'unknown', localType: null, remoteType: null }
  const localType = typeof pair.localCandidateId === 'string' ? candidates.get(pair.localCandidateId) ?? null : null
  const remoteType = typeof pair.remoteCandidateId === 'string' ? candidates.get(pair.remoteCandidateId) ?? null : null
  return { kind: classifyCandidateTypes(localType, remoteType), localType, remoteType }
}

export function classifyCandidateTypes(localType: string | null, remoteType: string | null): PathKind {
  if (!localType || !remoteType) return 'unknown'
  if (localType === 'relay' || remoteType === 'relay') return 'relayed'
  if (localType === 'host' && remoteType === 'host') return 'direct-lan'
  return 'direct-nat'
}

export function describePath(path: PathInfo): string {
  switch (path.kind) {
    case 'direct-lan': return 'Direct (same network)'
    case 'direct-nat': return 'Direct (via NAT traversal)'
    case 'relayed': return 'Relayed through TURN'
    case 'unknown': return 'Path not yet confirmed'
  }
}
