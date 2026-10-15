import type { DeviceInfo, DeviceSummary, OpenDeskBridge, PeerSignalMessage } from '../../../shared/types'
import type { SessionPermission } from '../../../shared/permissions'
import { parseRemoteInputNotice, parseRemoteInputPayload } from '../../../shared/remote-input'
import type { RemoteInputMessage } from '../../../shared/remote-input'
import type { SignalingClient } from './signaling-client'
import { describePath, inboundInterval, outboundInterval, readInboundVideo, readOutboundVideo, readPath } from './webrtc-stats'
import { AUTO_LADDER, AUTO_START, initialAdaptationState, nextAdaptationState, parseProfileNoticePayload, parseQualityPayload, QUALITY_PROFILES } from '../../../shared/quality-profile'
import type { AdaptationState, EffectiveProfileId, QualityProfileId } from '../../../shared/quality-profile'
import type { InboundVideoInterval, InboundVideoSample, OutboundVideoInterval, OutboundVideoSample, PathInfo } from './webrtc-stats'

export type ConnectionState = 'connecting' | 'negotiating' | 'connected' | 'degraded' | 'reconnecting' | 'failed' | 'disconnected'

/**
 * Remote keyboard/mouse state. The host moves from `pending` to `active` only after the local user
 * presses "Enable remote control"; `revoked` and `unavailable` are terminal for the current grant.
 */
export type RemoteControlState = 'off' | 'pending' | 'active' | 'unavailable' | 'revoked'

export interface SessionMetrics {
  /** Decoded frame rate over the last sampling interval. */
  framesPerSecond?: number
  width?: number
  height?: number
  /** Measured video payload rate over the last sampling interval. */
  bitrateKbps?: number
  /** Congestion controller's estimate of the bandwidth it can use. Not the same as the measured rate. */
  availableBitrateKbps?: number
  roundTripTimeMs?: number
  packetLossPercent?: number
  /** Receive-side jitter buffer wait per frame (viewer). */
  jitterBufferMs?: number
  /** Decode time per frame (viewer). */
  decodeMs?: number
  /** Encode time per frame (host). */
  encodeMs?: number
  /** Frames the decoder dropped during the interval (viewer). */
  droppedFrames?: number
  /** Why the encoder is reducing quality, as reported by the browser (host). */
  qualityLimitation?: string
  path?: PathInfo
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
  onRemoteControl: (state: RemoteControlState, reason?: string) => void
  /** The profile the sender is using now, and whether it was chosen by the user or by automatic adaptation. */
  onQualityProfile: (profile: EffectiveProfileId, mode: 'auto' | 'manual') => void
}

const ICE_GATHER_TIMEOUT_MS = 12_000
const MAX_RECOVERY_RESTARTS = 2
const INPUT_ERROR_REPORT_INTERVAL_MS = 5_000
/** Keyboard, pointer, and control messages travel on their own channel so that file chunks never queue ahead of them. */
export const INPUT_CHANNEL_LABEL = 'opendesk-input-v1'
/** Bulk file and clipboard transfer uses this channel. */
export const DATA_CHANNEL_LABEL = 'opendesk-data-v1'
const QUALITY_REQUEST_INTERVAL_MS = 500

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
  private inputChannel: RTCDataChannel | null = null
  /** Channels already reported as open. A channel can be seen both as open and via its open event. */
  private readonly announcedChannels = new WeakSet<RTCDataChannel>()
  private qualityMode: QualityProfileId = 'auto'
  private effectiveProfile: EffectiveProfileId = 'ultra'
  private adaptation: AdaptationState = { ...initialAdaptationState(Date.now()), current: 'ultra' }
  private lastQualityRequest = 0
  private senderQueue: Promise<void> = Promise.resolve()
  private metricsTimer: ReturnType<typeof setInterval> | null = null
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private preparing: Promise<void> | null = null
  private closed = false
  private collectingStats = false
  private restartCount = 0
  private lastInbound: InboundVideoSample | null = null
  private lastOutbound: OutboundVideoSample | null = null
  private remoteControl: RemoteControlState = 'off'
  private lastInputErrorReport = 0

  constructor(
    private readonly sessionId: string,
    private readonly role: 'viewer' | 'host',
    private readonly peer: DeviceSummary,
    private readonly localDevice: DeviceInfo,
    private readonly client: SignalingClient,
    private readonly bridge: Pick<OpenDeskBridge, 'armScreenCapture' | 'verifyPeerSignal' | 'startRemoteInput' | 'stopRemoteInput' | 'injectRemoteInput'>,
    private readonly callbacks: SessionCallbacks,
    private readonly permissions: readonly SessionPermission[] = ['view']
  ) {
    if (permissions.includes('input')) this.setRemoteControl(role === 'viewer' ? 'pending' : 'off')
  }

  get remoteControlState(): RemoteControlState {
    return this.remoteControl
  }

  get audioRequested(): boolean {
    return this.permissions.includes('audio')
  }

  private setRemoteControl(state: RemoteControlState, reason?: string): void {
    this.remoteControl = state
    if (!this.closed) this.callbacks.onRemoteControl(state, reason)
  }

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
    const profile = QUALITY_PROFILES[this.effectiveProfile]
    const targetFps = Math.max(60, profile.frameRate)
    const targetWidth = Math.max(1920, profile.width)
    const captureRequest = navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: targetFps, max: targetFps }, width: { ideal: targetWidth } },
      audio: this.audioRequested
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
        track.contentHint = QUALITY_PROFILES[this.effectiveProfile].contentHint
        this.peerConnection!.addTrack(track, stream)
        track.addEventListener('ended', () => {
          if (!this.closed) this.callbacks.onSessionEnded('The local user stopped screen sharing.')
        }, { once: true })
      }
      // Approval does not guarantee OS capture. A stream without audio is still a valid video share,
      // but the user must be told instead of seeing an apparently successful audio grant.
      if (this.audioRequested) {
        const audioTracks = stream.getAudioTracks()
        if (audioTracks.length === 0) this.callbacks.onError('System audio was approved, but this display did not provide an audio track. This session is video-only.')
        for (const track of audioTracks) this.peerConnection!.addTrack(track, stream)
      }
      if (this.permissions.includes('input') && this.remoteControl === 'off') this.setRemoteControl('pending')
      this.callbacks.onState('negotiating')
      await this.createAndSendOffer(false)
    } catch (error) {
      for (const track of this.localStream?.getTracks() || []) track.stop()
      this.localStream = null
      this.callbacks.onLocalStream(null)
      this.callbacks.onError(usefulError(error))
      if (!this.closed && this.role === 'host') void this.bridge.armScreenCapture({ sessionId: this.sessionId, audio: this.audioRequested }).catch(() => undefined)
      if (!this.closed) this.callbacks.onState('failed')
      throw error
    }
  }

  /**
   * Host only: starts accepting the viewer's keyboard and mouse messages for the shared display.
   * Requires that screen sharing is already running, because the native layer needs the display geometry.
   */
  async enableRemoteControl(): Promise<void> {
    if (this.role !== 'host') throw new Error('Only the device whose screen is shared can enable remote control.')
    if (!this.permissions.includes('input')) throw new Error('Remote keyboard and mouse were not approved for this session.')
    if (this.closed || !this.localStream) throw new Error('Start screen sharing before enabling remote control.')
    if (this.remoteControl === 'active') return
    try {
      await this.bridge.startRemoteInput(this.sessionId)
    } catch (error) {
      const reason = usefulError(error)
      this.sendNotice({ type: 'input:unavailable', reason })
      this.setRemoteControl('unavailable', reason)
      throw error
    }
    this.setRemoteControl('active')
    this.sendNotice({ type: 'input:ready' })
  }

  /** Host: stops remote control immediately, releases held keys and buttons, and tells the viewer. */
  async revokeRemoteControl(reason = 'The local user stopped remote control.'): Promise<void> {
    if (this.role !== 'host') return
    if (this.remoteControl === 'off' || this.remoteControl === 'revoked') return
    await this.bridge.stopRemoteInput(this.sessionId).catch(() => undefined)
    this.sendNotice({ type: 'input:revoked', reason })
    this.setRemoteControl('revoked', reason)
  }

  /** Viewer: sends one input message while the host has enabled remote control. Returns false when it cannot be sent. */
  sendRemoteInput(message: RemoteInputMessage): boolean {
    if (this.role !== 'viewer' || this.remoteControl !== 'active') return false
    const channel = this.inputChannel
    if (!channel || channel.readyState !== 'open') return false
    if (channel.bufferedAmount > 256 * 1024 && (message.type === 'input:move' || message.type === 'input:wheel')) return false
    channel.send(JSON.stringify(message))
    return true
  }

  /**
   * Viewer: asks the host to use a quality profile (or `auto`). Host: applies the profile to its own sender now.
   * Viewer requests are rate-limited on the host, so a peer cannot force constant reconfiguration.
   */
  requestQualityProfile(profile: QualityProfileId): boolean {
    if (this.closed) return false
    if (this.role === 'viewer') return this.sendOnInput(JSON.stringify({ type: 'session:quality', profile }))
    this.applyQualityMode(profile)
    return true
  }

  /** The profile the sender is using, as last reported to this side. */
  get qualityProfile(): EffectiveProfileId {
    return this.effectiveProfile
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
    // Release host-side control before anything else so no injected key or button outlives the session.
    if (this.role === 'host' && this.remoteControl !== 'off') {
      await this.bridge.stopRemoteInput(this.sessionId).catch(() => undefined)
    }
    this.remoteControl = 'off'
    this.inputChannel?.close()
    this.inputChannel = null
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
      this.applyReceiverPlayout(event.receiver)
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
      // The input channel is created first and marked high priority; it carries only small messages.
      this.attachDataChannel(peer.createDataChannel(INPUT_CHANNEL_LABEL, { ordered: true, priority: 'high' } as RTCDataChannelInit))
      this.attachDataChannel(peer.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true }))
      await this.bridge.armScreenCapture({ sessionId: this.sessionId, audio: this.audioRequested })
    }
    this.callbacks.onPrepared(true)
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    if (this.closed) {
      channel.close()
      return
    }
    if (channel.label === INPUT_CHANNEL_LABEL) this.attachInputChannel(channel)
    else if (channel.label === DATA_CHANNEL_LABEL) this.attachFileChannel(channel)
    else channel.close()
  }

  /** Remote keyboard, pointer, quality, and notice messages. Small and latency-sensitive. */
  private attachInputChannel(channel: RTCDataChannel): void {
    if (this.inputChannel && this.inputChannel !== channel) this.inputChannel.close()
    this.inputChannel = channel
    channel.binaryType = 'arraybuffer'
    channel.addEventListener('open', () => this.announceOpen(channel, () => {
      // A host that enabled control, or changed quality, before the channel opened must tell the viewer.
      if (this.role === 'host' && this.remoteControl === 'active') this.sendNotice({ type: 'input:ready' })
      if (this.role === 'host') this.sendProfileNotice()
    }))
    channel.addEventListener('message', event => this.handleChannelMessage(event.data))
    channel.addEventListener('close', () => {
      if (this.inputChannel === channel) this.inputChannel = null
    })
    channel.addEventListener('error', event => this.reportChannelError(event))
    if (channel.readyState === 'open') this.announceOpen(channel, () => {
      if (this.role === 'host') this.sendProfileNotice()
    })
  }

  /** Bulk file and clipboard transfer. Its queue never delays the input channel. */
  private attachFileChannel(channel: RTCDataChannel): void {
    if (this.dataChannel && this.dataChannel !== channel) this.dataChannel.close()
    this.dataChannel = channel
    channel.binaryType = 'arraybuffer'
    channel.addEventListener('open', () => this.announceOpen(channel, () => this.callbacks.onDataChannel(channel)))
    channel.addEventListener('close', () => {
      if (this.dataChannel === channel) {
        this.dataChannel = null
        this.callbacks.onDataChannel(null)
      }
    })
    channel.addEventListener('error', event => this.reportChannelError(event))
    if (channel.readyState === 'open') this.announceOpen(channel, () => this.callbacks.onDataChannel(channel))
  }

  /** Runs the open-handler once per channel, even when the channel is seen both as open and through its event. */
  private announceOpen(channel: RTCDataChannel, action: () => void): void {
    if (this.closed || this.announcedChannels.has(channel)) return
    this.announcedChannels.add(channel)
    action()
  }

  // A peer that closes the session aborts the SCTP channel, which fires `error` before `close`. The user-visible
  // outcome (session ended, or ICE recovery and failure) is already reported elsewhere, so this stays diagnostic.
  private reportChannelError(event: Event): void {
    const detail = (event as RTCErrorEvent).error?.errorDetail ?? 'unknown'
    console.warn(`Secure data channel error (${detail}).`)
  }

  private async createAndSendOffer(iceRestart: boolean): Promise<void> {
    const peer = this.peerConnection
    if (!peer || this.closed) throw new Error('WebRTC connection was closed before the offer was created.')
    const offer = await peer.createOffer(iceRestart ? { iceRestart: true } : undefined)
    await peer.setLocalDescription(offer)
    // Sender parameters can only be applied once a local description exists.
    void this.applyQualityToSenders()
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
    // A recovered connection earns a fresh budget of ICE restarts for future transient failures.
    this.restartCount = 0
    this.callbacks.onState('connected')
    if (this.role === 'host') this.callbacks.onQualityProfile(this.effectiveProfile, this.qualityMode === 'auto' ? 'auto' : 'manual')
    if (!this.metricsTimer) this.metricsTimer = setInterval(() => { void this.collectMetrics() }, 2000)
  }

  private scheduleRecovery(state: 'failed' | 'disconnected'): void {
    if (this.closed || this.disconnectTimer) return
    this.callbacks.onState('degraded')
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null
      if (this.closed || !this.peerConnection) return
      if (this.role === 'host' && this.restartCount < MAX_RECOVERY_RESTARTS) {
        void this.restartIce()
      } else {
        this.callbacks.onState('failed')
      }
    }, state === 'failed' ? 0 : 5000)
  }

  private async restartIce(): Promise<void> {
    const peer = this.peerConnection
    if (!peer || this.closed || this.restartCount >= MAX_RECOVERY_RESTARTS) {
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

  private handleChannelMessage(data: unknown): void {
    if (this.closed || typeof data !== 'string') return
    if (this.role === 'viewer') {
      const profile = parseProfileNoticePayload(data)
      if (profile) {
        this.effectiveProfile = profile.profile
        this.callbacks.onQualityProfile(profile.profile, profile.mode)
        for (const receiver of this.peerConnection?.getReceivers() ?? []) this.applyReceiverPlayout(receiver)
        return
      }
      const notice = parseRemoteInputNotice(safeParse(data))
      if (!notice) return
      if (notice.type === 'input:ready') this.setRemoteControl('active')
      else if (notice.type === 'input:revoked') this.setRemoteControl('revoked', notice.reason)
      else if (notice.type === 'input:unavailable') this.setRemoteControl('unavailable', notice.reason)
      return
    }
    // Host side: a quality request is accepted at a bounded rate; input only from the approved, enabled grant.
    if (data.startsWith('{"type":"session:quality"')) {
      const request = parseQualityPayload(data)
      const now = Date.now()
      if (!request || now - this.lastQualityRequest < QUALITY_REQUEST_INTERVAL_MS) return
      this.lastQualityRequest = now
      this.applyQualityMode(request.profile)
      return
    }
    if (!data.startsWith('{"type":"input:')) return
    const message = parseRemoteInputPayload(data)
    if (!message || this.remoteControl !== 'active') return
    this.bridge.injectRemoteInput(message).catch(error => this.reportInputError(error))
  }

  private applyQualityMode(profile: QualityProfileId): void {
    if (this.role !== 'host' || this.closed) return
    this.qualityMode = profile
    if (profile === 'auto') {
      // Adaptation resumes from the profile in use, or from the ultra (60 FPS) default when that profile is manual-only.
      const start = (AUTO_LADDER as readonly string[]).includes(this.effectiveProfile) ? this.effectiveProfile as EffectiveProfileId : 'ultra'
      this.adaptation = { ...initialAdaptationState(Date.now()), current: start as EffectiveProfileId }
      this.setEffectiveProfile(this.adaptation.current, 'auto')
    } else {
      this.setEffectiveProfile(profile, 'manual')
    }
  }

  private setEffectiveProfile(profile: EffectiveProfileId, mode: 'auto' | 'manual'): void {
    this.effectiveProfile = profile
    this.callbacks.onQualityProfile(profile, mode)
    this.sendProfileNotice()
    void this.applyQualityToSenders()
  }

  private sendProfileNotice(): void {
    this.sendOnInput(JSON.stringify({ type: 'session:profile', profile: this.effectiveProfile, mode: this.qualityMode === 'auto' ? 'auto' : 'manual' }))
  }

  /**
   * Host: applies the effective profile to the display track and the video sender. Calls are serialized because
   * getParameters/setParameters must not interleave, and a failed application leaves the previous settings in place.
   */
  private applyQualityToSenders(): Promise<void> {
    this.senderQueue = this.senderQueue.then(() => this.applyQualityToSendersNow()).catch(() => undefined)
    return this.senderQueue
  }

  private async applyQualityToSendersNow(): Promise<void> {
    const peer = this.peerConnection
    if (!peer || this.closed || this.role !== 'host' || !peer.localDescription) return
    const profile = QUALITY_PROFILES[this.effectiveProfile]
    for (const sender of peer.getSenders()) {
      const track = sender.track
      if (!track || track.kind !== 'video') continue
      track.contentHint = profile.contentHint
      await track.applyConstraints({ width: { ideal: profile.width }, frameRate: { ideal: profile.frameRate, max: profile.frameRate } }).catch(() => undefined)
      try {
        const parameters = sender.getParameters()
        if (!parameters.encodings || parameters.encodings.length === 0) parameters.encodings = [{}]
        const encoding = parameters.encodings[0]
        encoding.maxBitrate = profile.maxBitrateKbps * 1000
        encoding.maxFramerate = profile.frameRate
        encoding.priority = 'high'
        encoding.networkPriority = 'high'
        parameters.degradationPreference = profile.degradationPreference
        await sender.setParameters(parameters)
      } catch {
        // The encoder keeps its previous limits; the session continues and the next change retries.
      }
    }
  }

  /** Viewer: asks the receiver for the smallest jitter buffer that the active profile permits. */
  private applyReceiverPlayout(receiver: RTCRtpReceiver): void {
    if (receiver.track.kind !== 'video') return
    const delay = QUALITY_PROFILES[this.effectiveProfile].playoutDelaySeconds
    if (delay === null) return
    const hinted = receiver as RTCRtpReceiver & { playoutDelayHint?: number | null; jitterBufferTarget?: number | null }
    try {
      if ('playoutDelayHint' in hinted) hinted.playoutDelayHint = delay
      if ('jitterBufferTarget' in hinted) hinted.jitterBufferTarget = delay * 1000
    } catch {
      // Browsers without these hints keep their default buffering; the session is unaffected.
    }
  }

  private reportInputError(error: unknown): void {
    const now = Date.now()
    if (now - this.lastInputErrorReport < INPUT_ERROR_REPORT_INTERVAL_MS) return
    this.lastInputErrorReport = now
    this.callbacks.onError(usefulError(error))
  }

  private sendOnInput(payload: string): boolean {
    const channel = this.inputChannel
    if (!channel || channel.readyState !== 'open') return false
    try {
      channel.send(payload)
      return true
    } catch {
      return false // The channel closed; the state change is still applied locally.
    }
  }

  private sendNotice(notice: { type: 'input:ready' } | { type: 'input:revoked' | 'input:unavailable'; reason: string }): void {
    this.sendOnInput(JSON.stringify(notice))
  }

  private async collectMetrics(): Promise<void> {
    const peer = this.peerConnection
    if (!peer || this.closed || this.collectingStats) return
    this.collectingStats = true
    try {
      const report = await peer.getStats()
      const metrics: SessionMetrics = {}
      const inbound = readInboundVideo(report)
      if (inbound) {
        const interval: InboundVideoInterval = inboundInterval(this.lastInbound, inbound)
        if (inbound.width !== null && inbound.width > 0) metrics.width = inbound.width
        if (inbound.height !== null && inbound.height > 0) metrics.height = inbound.height
        if (interval.framesPerSecond !== null) metrics.framesPerSecond = interval.framesPerSecond
        if (interval.bitrateKbps !== null) metrics.bitrateKbps = interval.bitrateKbps
        if (interval.jitterBufferMs !== null) metrics.jitterBufferMs = interval.jitterBufferMs
        if (interval.decodeMs !== null) metrics.decodeMs = interval.decodeMs
        if (interval.packetLossPercent !== null) metrics.packetLossPercent = interval.packetLossPercent
        if (interval.droppedFrames !== null) metrics.droppedFrames = interval.droppedFrames
        this.lastInbound = inbound
      }
      const outbound = readOutboundVideo(report)
      if (outbound) {
        const interval: OutboundVideoInterval = outboundInterval(this.lastOutbound, outbound.sample)
        if (interval.encodeMs !== null) metrics.encodeMs = interval.encodeMs
        if (interval.framesPerSecond !== null) metrics.framesPerSecond = interval.framesPerSecond
        if (interval.bitrateKbps !== null) metrics.bitrateKbps = interval.bitrateKbps
        if (outbound.qualityLimitation) metrics.qualityLimitation = outbound.qualityLimitation
        if (outbound.remotePacketLossPercent !== null) metrics.packetLossPercent = outbound.remotePacketLossPercent
        this.lastOutbound = outbound.sample
      }
      const path = readPath(report)
      if (path.kind !== 'unknown') {
        metrics.path = path
        metrics.transport = describePath(path)
      }
      for (const stat of report.values()) {
        const pair = stat as RTCIceCandidatePairStats & { currentRoundTripTime?: number; availableOutgoingBitrate?: number; availableIncomingBitrate?: number; selected?: boolean; nominated?: boolean }
        if (stat.type !== 'candidate-pair' || pair.state !== 'succeeded' || !(pair.selected || pair.nominated)) continue
        if (typeof pair.currentRoundTripTime === 'number' && Number.isFinite(pair.currentRoundTripTime) && pair.currentRoundTripTime >= 0) metrics.roundTripTimeMs = pair.currentRoundTripTime * 1000
        const available = this.role === 'host' ? pair.availableOutgoingBitrate : pair.availableIncomingBitrate
        if (typeof available === 'number' && Number.isFinite(available) && available >= 0) metrics.availableBitrateKbps = available / 1000
      }
      // Automatic quality adaptation runs on the host, the only side that controls the encoder. It runs after the
      // candidate-pair values are read, because the decision uses the path RTT and the available bitrate.
      if (this.role === 'host' && this.qualityMode === 'auto' && outbound) {
        const before = this.adaptation.current
        this.adaptation = nextAdaptationState(this.adaptation, {
          qualityLimitation: outbound.qualityLimitation as 'none' | 'bandwidth' | 'cpu' | 'other' | null,
          roundTripTimeMs: metrics.roundTripTimeMs ?? outbound.remoteRoundTripTimeMs,
          packetLossPercent: outbound.remotePacketLossPercent,
          availableKbps: metrics.availableBitrateKbps ?? null
        }, Date.now())
        if (this.adaptation.current !== before) this.setEffectiveProfile(this.adaptation.current, 'auto')
      }
      this.callbacks.onMetrics(metrics)
    } catch {
      // Stats are optional. Clear previous measurements rather than displaying them as current.
      if (!this.closed) this.callbacks.onMetrics({})
    } finally {
      this.collectingStats = false
    }
  }
}

function safeParse(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return null }
}
