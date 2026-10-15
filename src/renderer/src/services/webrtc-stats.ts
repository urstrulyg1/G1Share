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
  width: number | null
  height: number | null
  bytes: number | null
  framesDecoded: number | null
  framesDropped: number | null
  jitterBufferDelay: number | null
  jitterBufferEmittedCount: number | null
  totalDecodeTime: number | null
  packetsLost: number | null
  packetsReceived: number | null
}

export interface OutboundVideoSample {
  timestamp: number
  bytes: number | null
  framesEncoded: number | null
  totalEncodeTime: number | null
}

export interface InboundVideoInterval {
  framesPerSecond: number | null
  bitrateKbps: number | null
  /** Average time a frame waited in the receive jitter buffer during the interval. */
  jitterBufferMs: number | null
  /** Average hardware or software decode time per frame during the interval. */
  decodeMs: number | null
  droppedFrames: number | null
  packetLossPercent: number | null
}

export interface OutboundVideoInterval {
  framesPerSecond: number | null
  bitrateKbps: number | null
  /** Average encode time per frame during the interval. */
  encodeMs: number | null
}

/** Derives interval values from two consecutive inbound samples. Returns an empty interval when time did not advance. */
function delta(before: number | null, after: number | null): number | null {
  return before !== null && after !== null && after >= before ? after - before : null
}

export function inboundInterval(previous: InboundVideoSample | null, current: InboundVideoSample): InboundVideoInterval {
  const empty: InboundVideoInterval = { framesPerSecond: null, bitrateKbps: null, jitterBufferMs: null, decodeMs: null, droppedFrames: null, packetLossPercent: null }
  if (!previous) return empty
  const elapsed = current.timestamp - previous.timestamp
  if (!(elapsed > 0)) return empty
  const frames = delta(previous.framesDecoded, current.framesDecoded)
  const emitted = delta(previous.jitterBufferEmittedCount, current.jitterBufferEmittedCount)
  const lost = delta(previous.packetsLost, current.packetsLost)
  const received = delta(previous.packetsReceived, current.packetsReceived)
  const packetTotal = lost !== null && received !== null ? lost + received : null
  const bytes = delta(previous.bytes, current.bytes)
  const jitter = delta(previous.jitterBufferDelay, current.jitterBufferDelay)
  const decode = delta(previous.totalDecodeTime, current.totalDecodeTime)
  return {
    framesPerSecond: frames === null ? null : frames * 1000 / elapsed,
    bitrateKbps: bytes === null ? null : bytes * 8 / elapsed,
    jitterBufferMs: emitted !== null && emitted > 0 && jitter !== null ? jitter * 1000 / emitted : null,
    decodeMs: frames !== null && frames > 0 && decode !== null ? decode * 1000 / frames : null,
    droppedFrames: delta(previous.framesDropped, current.framesDropped),
    packetLossPercent: packetTotal !== null && packetTotal > 0 && lost !== null ? lost * 100 / packetTotal : null
  }
}

export function outboundInterval(previous: OutboundVideoSample | null, current: OutboundVideoSample): OutboundVideoInterval {
  const empty: OutboundVideoInterval = { framesPerSecond: null, bitrateKbps: null, encodeMs: null }
  if (!previous) return empty
  const elapsed = current.timestamp - previous.timestamp
  if (!(elapsed > 0)) return empty
  const frames = delta(previous.framesEncoded, current.framesEncoded)
  const bytes = delta(previous.bytes, current.bytes)
  const encode = delta(previous.totalEncodeTime, current.totalEncodeTime)
  return {
    framesPerSecond: frames === null ? null : frames * 1000 / elapsed,
    bitrateKbps: bytes === null ? null : bytes * 8 / elapsed,
    encodeMs: frames !== null && frames > 0 && encode !== null ? encode * 1000 / frames : null
  }
}

interface StatLike {
  type: string
  id: string
  timestamp?: number
  [key: string]: unknown
}

function counter(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Reads the inbound video counters (non-remote, kind video) from a stats report. */
export function readInboundVideo(report: RTCStatsReport): InboundVideoSample | null {
  let found: InboundVideoSample | null = null
  report.forEach(raw => {
    const stat = raw as unknown as StatLike
    if (stat.type !== 'inbound-rtp' || stat.kind !== 'video' || stat.isRemote === true || counter(stat.timestamp) === null) return
    found = {
      timestamp: stat.timestamp!,
      width: counter(stat.frameWidth),
      height: counter(stat.frameHeight),
      bytes: counter(stat.bytesReceived),
      framesDecoded: counter(stat.framesDecoded),
      framesDropped: counter(stat.framesDropped),
      jitterBufferDelay: counter(stat.jitterBufferDelay),
      jitterBufferEmittedCount: counter(stat.jitterBufferEmittedCount),
      totalDecodeTime: counter(stat.totalDecodeTime),
      packetsLost: counter(stat.packetsLost),
      packetsReceived: counter(stat.packetsReceived)
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
        packetLossPercent: counter(stat.fractionLost) !== null ? (stat.fractionLost as number) * 100 : null,
        roundTripTimeMs: counter(stat.roundTripTime) !== null ? (stat.roundTripTime as number) * 1000 : null
      }
      return
    }
    if (stat.type !== 'outbound-rtp' || stat.kind !== 'video' || stat.isRemote === true || counter(stat.timestamp) === null) return
    const reason = typeof stat.qualityLimitationReason === 'string' ? stat.qualityLimitationReason : null
    found = {
      sample: {
        timestamp: stat.timestamp!,
        bytes: counter(stat.bytesSent),
        framesEncoded: counter(stat.framesEncoded),
        totalEncodeTime: counter(stat.totalEncodeTime)
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
    if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
      if (stat.selected === true) selected = stat
      else if (stat.nominated === true && !selected) selected = stat
    }
  })
  const pair = selected as StatLike | null
  if (!pair) return { kind: 'unknown', localType: null, remoteType: null }
  const localType = typeof pair.localCandidateId === 'string' ? candidates.get(pair.localCandidateId) ?? null : null
  const remoteType = typeof pair.remoteCandidateId === 'string' ? candidates.get(pair.remoteCandidateId) ?? null : null
  return { kind: classifyCandidateTypes(localType, remoteType), localType, remoteType }
}

export function classifyCandidateTypes(localType: string | null, remoteType: string | null): PathKind {
  const knownTypes = ['host', 'prflx', 'srflx', 'relay']
  if (!localType || !remoteType || !knownTypes.includes(localType) || !knownTypes.includes(remoteType)) return 'unknown'
  if (localType === 'relay' || remoteType === 'relay') return 'relayed'
  if (localType === 'host' && remoteType === 'host') return 'direct-lan'
  return 'direct-nat'
}

export function describePath(path: PathInfo): string {
  switch (path.kind) {
    case 'direct-lan': return 'Direct (host candidates)'
    case 'direct-nat': return 'Direct (via NAT traversal)'
    case 'relayed': return 'Relayed through TURN'
    case 'unknown': return 'Path not yet confirmed'
  }
}
