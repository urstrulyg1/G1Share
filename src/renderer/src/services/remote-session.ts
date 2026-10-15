import type { DeviceInfo, DeviceSummary, OpenDeskBridge, PeerSignalMessage } from '../../../shared/types'
import type { SignalingClient } from './signaling-client'

export type ConnectionState = 'connecting' | 'negotiating' | 'connected' | 'degraded' | 'reconnecting' | 'failed' | 'disconnected'

export interface SessionMetrics {
  framesPerSecond?: number
  width?: number
  height?: number
  bitrateKbps?: number
  roundTripTimeMs?: number
  packetLossPercent?: number
  transport?: string
}

interface SessionCallbacks {
  onState: (state: ConnectionState) => void
  onRemoteStream: (stream: MediaStream | null) => void
  onLocalStream: (stream: MediaStream | null) => void
  onDataChannel: (channel: RTCDataChannel | null) => void
  onMetrics: (metrics: SessionMetrics) => void
  onPrepared: (ready: boolean) => void
  onSessionEnded: (reason: string) => void
  onError: (message: string) => void
}

const ICE_GATHER_TIMEOUT_MS = 12_000

function usefulError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Screen capture was not approved. Check the OS Screen Recording permission and try again.'
    if (error.name === 'NotFoundError') return 'No screen capture source is available. On Linux Wayland, verify that the desktop portal and PipeWire are running.'
    if (error.name === 'NotReadableError') return 'The operating system could not capture this display. Close other screen-sharing tools and retry.'
  }
  return error instanceof Error ? error.message.slice(0, 240) : 'The remote session failed.'
}

export class RemoteSessionController {
  private peerConnection: RTCPeerConnection | null = null
  private localStream: MediaStream | null = null
  private remoteStream: MediaStream | null = null
  private dataChannel: RTCDataChannel | null = null
  private metricsTimer: ReturnType<typeof setInterval> | null = null
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private preparing: Promise<void> | null = null
  private closed = false
  private collectingStats = false
  private restartCount = 0
  private lastVideoStats: { frames: number; bytes: number; timestamp: number } | null = null

  constructor(
    private readonly sessionId: string,
    private readonly role: 'viewer' | 'host',
    private readonly peer: DeviceSummary,
    private readonly localDevice: DeviceInfo,
    private readonly client: SignalingClient,
    private readonly bridge: Pick<OpenDeskBridge, 'armScreenCapture' | 'verifyPeerSignal'>,
    private readonly callbacks: SessionCallbacks
  ) {}

  async prepare(): Promise<void> {
    if (this.preparing) return this.preparing
    this.preparing = this.createPeerConnection()
    try {
      await this.preparing
    } catch (error) {
      this.callbacks.onPrepared(false)
      this.callbacks.onState('failed')
      this.callbacks.onError(usefulError(error))
      throw error
    }
  }

  async startScreenShare(): Promise<void> {
    if (this.role !== 'host') throw new Error('Only the approved screen-sharing device can capture its display.')
    if (this.closed) throw new Error('This remote session is no longer active.')
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This platform does not expose the Electron screen-capture API.')

    // Call synchronously in the user click handler so Chromium retains user activation.
    const captureRequest = navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 }, width: { ideal: 1600 } },
      audio: false
    })
    try {
      await this.prepare()
      const stream = await captureRequest
      if (this.closed) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      this.localStream = stream
      this.callbacks.onLocalStream(stream)
      const videoTracks = stream.getVideoTracks()
      if (videoTracks.length === 0) throw new Error('The selected display did not provide a video track.')
      for (const track of videoTracks) {
        track.contentHint = 'detail'
        this.peerConnection!.addTrack(track, stream)
        track.addEventListener('ended', () => {
          if (!this.closed) this.callbacks.onSessionEnded('The local user stopped screen sharing.')
        }, { once: true })
      }
      this.callbacks.onState('negotiating')
      await this.createAndSendOffer(false)
    } catch (error) {
      for (const track of this.localStream?.getTracks() || []) track.stop()
      this.localStream = null
      this.callbacks.onLocalStream(null)
      this.callbacks.onError(usefulError(error))
      if (!this.closed && this.role === 'host') void this.bridge.armScreenCapture().catch(() => undefined)
      if (!this.closed) this.callbacks.onState('failed')
      throw error
    }
  }

  async handleSignal(message: PeerSignalMessage): Promise<void> {
    if (this.closed) return
    await this.prepare()
    if (this.closed || !this.peerConnection) return
    if (message.fromDeviceId !== this.peer.id) throw new Error('Received a signal from an unexpected device.')
    const verified = await this.bridge.verifyPeerSignal({
      sessionId: this.sessionId,
      peerDeviceId: this.peer.id,
      peerPublicKey: this.peer.publicKey,
      fromDeviceId: message.fromDeviceId,
      type: message.type,
      payload: message.payload,
      signature: message.signature
    })
    if (!verified) throw new Error('Peer signal signature verification failed. The signaling payload may have been altered.')

    if (message.type === 'offer') {
      if (this.role !== 'viewer') throw new Error('The screen-sharing device sent an unexpected offer.')
      const description = message.payload as unknown as RTCSessionDescriptionInit
      if (description.type !== 'offer' || typeof description.sdp !== 'string') throw new Error('The remote WebRTC offer is malformed.')
      if (this.peerConnection.signalingState === 'have-remote-offer') return
      await this.peerConnection.setRemoteDescription(description)
      const answer = await this.peerConnection.createAnswer()
      await this.peerConnection.setLocalDescription(answer)
      await this.waitForIceGathering()
      const local = this.peerConnection.localDescription
      if (!local?.sdp) throw new Error('The local WebRTC answer was not created.')
      await this.client.sendSignal(this.sessionId, 'answer', { type: local.type, sdp: local.sdp })
      this.callbacks.onState('negotiating')
      return
    }
    if (message.type === 'answer') {
      if (this.role !== 'host') throw new Error('The screen-viewing device sent an unexpected answer.')
      const description = message.payload as unknown as RTCSessionDescriptionInit
      if (description.type !== 'answer' || typeof description.sdp !== 'string') throw new Error('The remote WebRTC answer is malformed.')
      if (this.peerConnection.signalingState !== 'have-local-offer') return
      await this.peerConnection.setRemoteDescription(description)
      this.callbacks.onState('negotiating')
      return
    }
    if (message.type === 'hangup') {
      await this.close()
    }
  }

  async closeRemoteSession(reason = 'user disconnected'): Promise<void> {
    if (this.closed) return
    try { await this.client.closeSession(this.sessionId, reason) } catch (error) { this.callbacks.onError(usefulError(error)) }
    await this.close()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.metricsTimer) clearInterval(this.metricsTimer)
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.metricsTimer = null
    this.disconnectTimer = null
    this.reconnectTimer = null
    this.dataChannel?.close()
    this.dataChannel = null
    this.callbacks.onDataChannel(null)
    for (const track of this.localStream?.getTracks() || []) track.stop()
    this.localStream = null
    this.callbacks.onLocalStream(null)
    this.peerConnection?.close()
    this.peerConnection = null
    this.remoteStream = null
    this.callbacks.onRemoteStream(null)
    this.callbacks.onState('disconnected')
  }

  private async createPeerConnection(): Promise<void> {
    this.callbacks.onState('connecting')
    const configuration = await this.client.getIceConfiguration()
    if (!Array.isArray(configuration.iceServers)) throw new Error('Signaling service returned invalid ICE server configuration.')
    const peer = new RTCPeerConnection({ iceServers: configuration.iceServers, iceTransportPolicy: 'all' })
    this.peerConnection = peer
    peer.ontrack = event => {
      if (this.closed) return
      if (event.streams[0]) this.remoteStream = event.streams[0]
      else {
        if (!this.remoteStream) this.remoteStream = new MediaStream()
        this.remoteStream.addTrack(event.track)
      }
      this.callbacks.onRemoteStream(this.remoteStream)
    }
    peer.ondatachannel = event => this.attachDataChannel(event.channel)
    peer.oniceconnectionstatechange = () => this.handleICEState(peer.iceConnectionState)
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') this.markConnected()
      else if (peer.connectionState === 'failed') this.scheduleRecovery('failed')
      else if (peer.connectionState === 'disconnected') this.scheduleRecovery('disconnected')
      else if (peer.connectionState === 'connecting') this.callbacks.onState('negotiating')
      else if (peer.connectionState === 'closed') this.callbacks.onState('disconnected')
    }
    peer.onicegatheringstatechange = () => {
      if (peer.iceGatheringState === 'gathering' && !this.closed) this.callbacks.onState('negotiating')
    }
    if (this.role === 'host') {
      this.attachDataChannel(peer.createDataChannel('opendesk-data-v1', { ordered: true }))
      await this.bridge.armScreenCapture()
    }
    this.callbacks.onPrepared(true)
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    if (this.closed) {
      channel.close()
      return
    }
    if (this.dataChannel && this.dataChannel !== channel) this.dataChannel.close()
    this.dataChannel = channel
    channel.binaryType = 'arraybuffer'
    channel.addEventListener('open', () => {
      if (!this.closed) this.callbacks.onDataChannel(channel)
    })
    channel.addEventListener('close', () => {
      if (this.dataChannel === channel) {
        this.dataChannel = null
        this.callbacks.onDataChannel(null)
      }
    })
    channel.addEventListener('error', () => this.callbacks.onError('The secure peer data channel reported an error.'))
    if (channel.readyState === 'open') this.callbacks.onDataChannel(channel)
  }

  private async createAndSendOffer(iceRestart: boolean): Promise<void> {
    const peer = this.peerConnection
    if (!peer || this.closed) throw new Error('WebRTC connection was closed before the offer was created.')
    const offer = await peer.createOffer(iceRestart ? { iceRestart: true } : undefined)
    await peer.setLocalDescription(offer)
    await this.waitForIceGathering()
    const local = peer.localDescription
    if (!local?.sdp) throw new Error('The WebRTC offer was not created.')
    await this.client.sendSignal(this.sessionId, 'offer', { type: local.type, sdp: local.sdp })
    this.callbacks.onState(iceRestart ? 'reconnecting' : 'negotiating')
  }

  private waitForIceGathering(): Promise<void> {
    const peer = this.peerConnection
    if (!peer || peer.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise(resolve => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        peer.removeEventListener('icegatheringstatechange', onState)
        resolve()
      }
      const onState = () => { if (peer.iceGatheringState === 'complete') finish() }
      const timer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS)
      peer.addEventListener('icegatheringstatechange', onState)
      if (peer.iceGatheringState === 'complete') finish()
    })
  }

  private handleICEState(state: RTCIceConnectionState): void {
    if (this.closed) return
    if (state === 'connected' || state === 'completed') this.markConnected()
    else if (state === 'checking' || state === 'new') this.callbacks.onState('negotiating')
    else if (state === 'disconnected') this.scheduleRecovery('disconnected')
    else if (state === 'failed') this.scheduleRecovery('failed')
    else if (state === 'closed') this.callbacks.onState('disconnected')
  }

  private markConnected(): void {
    if (this.closed) return
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.disconnectTimer = null
    this.reconnectTimer = null
    this.callbacks.onState('connected')
    if (!this.metricsTimer) this.metricsTimer = setInterval(() => { void this.collectMetrics() }, 2000)
  }

  private scheduleRecovery(state: 'failed' | 'disconnected'): void {
    if (this.closed || this.disconnectTimer) return
    this.callbacks.onState(state === 'failed' ? 'degraded' : 'degraded')
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null
      if (this.closed || !this.peerConnection) return
      if (this.role === 'host' && this.restartCount < 2) {
        void this.restartIce()
      } else {
        this.callbacks.onState('failed')
      }
    }, state === 'failed' ? 0 : 5000)
  }

  private async restartIce(): Promise<void> {
    const peer = this.peerConnection
    if (!peer || this.closed || this.restartCount >= 2) {
      this.callbacks.onState('failed')
      return
    }
    this.restartCount += 1
    this.callbacks.onState('reconnecting')
    try {
      peer.restartIce()
      await this.createAndSendOffer(true)
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = setTimeout(() => {
        if (!this.closed && this.peerConnection?.connectionState !== 'connected') this.callbacks.onState('failed')
      }, 20_000)
    } catch (error) {
      this.callbacks.onError(usefulError(error))
      this.callbacks.onState('failed')
    }
  }

  private async collectMetrics(): Promise<void> {
    const peer = this.peerConnection
    if (!peer || this.closed || this.collectingStats) return
    this.collectingStats = true
    try {
      const report = await peer.getStats()
      let inbound: RTCStats | undefined
      let selectedPair: RTCStats | undefined
      report.forEach(stat => {
        const candidate = stat as RTCInboundRtpStreamStats & { kind?: string; isRemote?: boolean }
        if (stat.type === 'inbound-rtp' && candidate.kind === 'video' && !candidate.isRemote) inbound = stat
        const pair = stat as RTCIceCandidatePairStats & { selected?: boolean; nominated?: boolean }
        if (stat.type === 'candidate-pair' && (pair.selected || pair.nominated) && pair.state === 'succeeded') selectedPair = stat
      })
      const metrics: SessionMetrics = {}
      if (inbound) {
        const video = inbound as RTCInboundRtpStreamStats & { framesPerSecond?: number; frameWidth?: number; frameHeight?: number; bytesReceived?: number; framesDecoded?: number }
        if (typeof video.frameWidth === 'number' && video.frameWidth > 0) metrics.width = video.frameWidth
        if (typeof video.frameHeight === 'number' && video.frameHeight > 0) metrics.height = video.frameHeight
        const now = performance.now()
        const bytes = video.bytesReceived || 0
        const frames = video.framesDecoded || 0
        if (typeof video.framesPerSecond === 'number' && video.framesPerSecond >= 0) metrics.framesPerSecond = video.framesPerSecond
        else if (this.lastVideoStats && now > this.lastVideoStats.timestamp) metrics.framesPerSecond = Math.max(0, (frames - this.lastVideoStats.frames) * 1000 / (now - this.lastVideoStats.timestamp))
        if (this.lastVideoStats && now > this.lastVideoStats.timestamp) metrics.bitrateKbps = Math.max(0, (bytes - this.lastVideoStats.bytes) * 8 / (now - this.lastVideoStats.timestamp))
        this.lastVideoStats = { frames, bytes, timestamp: now }
        const videoStats = video as RTCInboundRtpStreamStats & { packetsLost?: number; packetsReceived?: number }
        if (typeof videoStats.packetsLost === 'number' && typeof videoStats.packetsReceived === 'number') {
          const total = videoStats.packetsLost + videoStats.packetsReceived
          if (total > 0) metrics.packetLossPercent = Math.max(0, videoStats.packetsLost) * 100 / total
        }
      }
      if (selectedPair) {
        const pair = selectedPair as RTCIceCandidatePairStats & { currentRoundTripTime?: number; availableIncomingBitrate?: number; localCandidateId?: string }
        if (typeof pair.currentRoundTripTime === 'number') metrics.roundTripTimeMs = pair.currentRoundTripTime * 1000
        if (typeof pair.availableIncomingBitrate === 'number') metrics.bitrateKbps = pair.availableIncomingBitrate / 1000
        metrics.transport = 'WebRTC ICE'
      }
      this.callbacks.onMetrics(metrics)
    } catch {
      // Stats are optional diagnostics. Failure does not alter the session state.
    } finally {
      this.collectingStats = false
    }
  }
}
