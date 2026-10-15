import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeftRight, Clipboard, File, FileUp, Fullscreen, LockKeyhole, Monitor, MonitorUp, MousePointer2, ShieldAlert, Signal, Square, X } from 'lucide-react'
import type { DeviceInfo, SignalingEvent } from '../../../shared/types'
import type { ActiveSession } from '../hooks/useOpenDesk'
import type { SignalingClient } from '../services/signaling-client'
import { FileTransferManager } from '../services/file-transfer'
import type { TransferRecord } from '../services/file-transfer'
import { RemoteSessionController } from '../services/remote-session'
import type { ConnectionState, RemoteControlState, SessionMetrics } from '../services/remote-session'
import { ViewerInputForwarder } from '../services/remote-input'
import { VideoFrameProbe } from '../services/video-probe'
import type { ProbeSnapshot } from '../services/video-probe'
import { QUALITY_PROFILE_IDS, QUALITY_PROFILES } from '../../../shared/quality-profile'
import type { EffectiveProfileId, QualityProfileId } from '../../../shared/quality-profile'
import { permissionLabel } from '../../../shared/permissions'

interface Props {
  active: ActiveSession
  localDevice: DeviceInfo
  client: SignalingClient | null
  signals: SignalingEvent[]
  onState: (state: ConnectionState) => void
  onFinish: (sessionId: string, result?: string) => Promise<void>
  onError: (message: string) => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function stateLabel(state: ConnectionState): string {
  switch (state) {
    case 'connecting': return 'Connecting'
    case 'negotiating': return 'Negotiating WebRTC'
    case 'connected': return 'Connected'
    case 'degraded': return 'Network degraded'
    case 'reconnecting': return 'Reconnecting'
    case 'failed': return 'Connection failed'
    case 'disconnected': return 'Disconnected'
  }
}

function progressPercent(transfer: TransferRecord): number {
  if (transfer.size === 0) return transfer.status === 'complete' ? 100 : 0
  return Math.min(100, Math.round(transfer.transferred * 100 / transfer.size))
}

export function ActiveSessionView({ active, localDevice, client, signals, onState, onFinish, onError }: Props) {
  const [controller, setController] = useState<RemoteSessionController | null>(null)
  const [prepared, setPrepared] = useState(false)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null)
  const [transfers, setTransfers] = useState<TransferRecord[]>([])
  const [metrics, setMetrics] = useState<SessionMetrics>({})
  const [presentation, setPresentation] = useState<ProbeSnapshot | null>(null)
  const [qualityChoice, setQualityChoice] = useState<QualityProfileId>('auto')
  const [effectiveQuality, setEffectiveQuality] = useState<{ profile: EffectiveProfileId; mode: 'auto' | 'manual' } | null>(null)
  const [stopping, setStopping] = useState(false)
  const [shareStarted, setShareStarted] = useState(false)
  const [fitMode, setFitMode] = useState<'fit' | 'actual'>('fit')
  const [clipboardBusy, setClipboardBusy] = useState(false)
  const [remoteControl, setRemoteControl] = useState<RemoteControlState>('off')
  const [remoteControlReason, setRemoteControlReason] = useState('')
  const [remoteControlBusy, setRemoteControlBusy] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const controllerRef = useRef<RemoteSessionController | null>(null)
  const transferManagerRef = useRef<FileTransferManager | null>(null)
  const incomingSignalsRef = useRef<SignalingEvent[]>([])
  const lastSignalSequence = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const permissions = active.session.permissions || []
  const canRemoteControl = permissions.includes('input')
  const canTransferFiles = permissions.includes('files')
  const canShareClipboard = permissions.includes('clipboard')
  const isViewer = active.role === 'viewer'
  const sessionLabel = isViewer
    ? active.session.status === 'pending' ? 'Awaiting remote approval' : remoteStream && active.connectionState === 'connected' ? 'Viewing live display' : 'Waiting for remote display'
    : shareStarted ? active.connectionState === 'connected' ? 'Sharing selected display' : 'Capturing selected display · peer not connected' : 'Screen not selected'

  const upsertTransfer = useCallback((transfer: TransferRecord) => {
    setTransfers(current => [transfer, ...current.filter(item => item.id !== transfer.id)].slice(0, 20))
  }, [])

  useEffect(() => {
    if (active.session.status !== 'accepted' || !client) return
    let disposed = false
    lastSignalSequence.current = 0
    incomingSignalsRef.current = []
    setRemoteControl('off')
    setRemoteControlReason('')
    setEffectiveQuality(null)
    const instance = new RemoteSessionController(
      active.session.id,
      active.role,
      active.peer,
      localDevice,
      client,
      window.openDesk,
      {
        onState: value => { onState(value) },
        onRemoteControl: (state, reason) => {
          setRemoteControl(state)
          setRemoteControlReason(reason ?? '')
        },
        onRemoteStream: stream => setRemoteStream(stream),
        onLocalStream: stream => setLocalStream(stream),
        onDataChannel: channel => {
          setDataChannel(channel)
          if (!channel) {
            void transferManagerRef.current?.close()
            transferManagerRef.current = null
            return
          }
          if (!canTransferFiles && !canShareClipboard) return
          void transferManagerRef.current?.close()
          transferManagerRef.current = new FileTransferManager(channel, window.openDesk, {
            allowFiles: canTransferFiles,
            allowClipboard: canShareClipboard,
            onIncomingOffer: async (name, size) => window.openDesk.prepareIncomingFile({ name, size }),
            onClipboardText: async text => {
              const received = await window.openDesk.receiveClipboardText(text)
              if (!received) onError('Remote clipboard text was not applied; your current clipboard is unchanged.')
            },
            onTransfer: upsertTransfer,
            onError
          })
        },
        onMetrics: value => setMetrics(value),
        onQualityProfile: (profile, mode) => setEffectiveQuality({ profile, mode }),
        onPrepared: ready => setPrepared(ready),
        onSessionEnded: reason => { void onFinish(active.session.id, reason) },
        onError
      },
      active.session.permissions ?? ['view']
    )
    controllerRef.current = instance
    setController(instance)
    setPrepared(false)
    setRemoteStream(null)
    setLocalStream(null)
    setDataChannel(null)
    setMetrics({})
    void instance.prepare().then(async () => {
      if (disposed) return
      const queued = incomingSignalsRef.current.splice(0)
      for (const event of queued) {
        if (event.message) await instance.handleSignal(event.message).catch(error => onError(error instanceof Error ? error.message : 'WebRTC signaling failed.'))
      }
    }).catch(() => undefined)
    return () => {
      disposed = true
      if (controllerRef.current === instance) controllerRef.current = null
      setController(null)
      setPrepared(false)
      void transferManagerRef.current?.close()
      transferManagerRef.current = null
      void instance.close()
    }
  }, [active.session.id, active.session.status, active.session.permissions, active.role, active.peer, localDevice, client, canTransferFiles, canShareClipboard, onState, onFinish, onError, upsertTransfer])

  // The viewer forwards keyboard and pointer input only while the host has enabled remote control.
  useEffect(() => {
    const element = videoRef.current
    if (!controller || active.role !== 'viewer' || remoteControl !== 'active' || !remoteStream || !element) return
    const forwarder = new ViewerInputForwarder({ element, send: message => controller.sendRemoteInput(message) })
    forwarder.attach()
    return () => forwarder.detach()
  }, [controller, active.role, remoteControl, remoteStream, active.connectionState])

  useEffect(() => {
    for (const event of signals) {
      if (event.sessionId !== active.session.id || !event.message || event.sequence <= lastSignalSequence.current) continue
      lastSignalSequence.current = event.sequence
      const instance = controllerRef.current
      if (!instance) {
        incomingSignalsRef.current.push(event)
        continue
      }
      void instance.handleSignal(event.message).catch(error => onError(error instanceof Error ? error.message : 'Could not process remote WebRTC signaling.'))
    }
  }, [signals, active.session.id, onError])

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = remoteStream
  }, [remoteStream, active.connectionState])

  // Presentation timing is sampled on the same cadence as the WebRTC statistics, never per frame in React.
  useEffect(() => {
    const element = videoRef.current
    if (!remoteStream || !element) return
    const probe = new VideoFrameProbe()
    probe.start(element)
    const timer = setInterval(() => setPresentation(probe.snapshot()), 2000)
    return () => {
      clearInterval(timer)
      probe.stop()
      setPresentation(null)
    }
  }, [remoteStream, active.connectionState])
  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream
  }, [localStream])

  const disconnect = async (result = 'Disconnected') => {
    if (stopping) return
    setStopping(true)
    await transferManagerRef.current?.close()
    await controllerRef.current?.close()
    await onFinish(active.session.id, result)
  }

  const startSharing = async () => {
    try {
      if (!controllerRef.current) throw new Error('Secure transport is not prepared yet.')
      await controllerRef.current.startScreenShare()
      setShareStarted(true)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Screen capture failed.')
    }
  }

  const chooseQuality = (profile: QualityProfileId) => {
    if (!controllerRef.current?.requestQualityProfile(profile)) {
      onError('The peer control channel is not connected. Try again after WebRTC connects.')
      return
    }
    setQualityChoice(profile)
  }

  const selectFiles = () => fileInputRef.current?.click()
  const sendSelectedFiles = async (files: FileList | File[]) => {
    if (!canTransferFiles) return
    const items = Array.from(files)
    if (items.length === 0) return
    try {
      if (!transferManagerRef.current) throw new Error('The secure file-transfer channel is not connected.')
      await transferManagerRef.current.sendFiles(items)
    } catch (error) { onError(error instanceof Error ? error.message : 'File transfer failed.') }
  }

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (canTransferFiles && event.dataTransfer.files.length > 0) void sendSelectedFiles(event.dataTransfer.files)
  }

  const sendClipboard = async () => {
    if (!canShareClipboard || clipboardBusy) return
    setClipboardBusy(true)
    try {
      const text = await window.openDesk.shareClipboardText()
      if (text === null) return
      if (!transferManagerRef.current) throw new Error('The secure peer data channel is not connected.')
      transferManagerRef.current.sendClipboardText(text)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Clipboard transfer failed.')
    } finally {
      setClipboardBusy(false)
    }
  }

  const enableRemoteControl = async () => {
    setRemoteControlBusy(true)
    try {
      if (!controllerRef.current) throw new Error('The approved session is not ready for remote control.')
      await controllerRef.current.enableRemoteControl()
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Remote control could not be enabled.')
    } finally {
      setRemoteControlBusy(false)
    }
  }

  const revokeRemoteControl = async () => {
    setRemoteControlBusy(true)
    try {
      if (!controllerRef.current) throw new Error('Remote control is not active.')
      await controllerRef.current.revokeRemoteControl('The local user stopped remote control.')
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Remote control could not be stopped.')
    } finally {
      setRemoteControlBusy(false)
    }
  }

  const enterFullscreen = async () => {
    try {
      const element = videoRef.current?.parentElement
      if (!element) return
      if (document.fullscreenElement) await document.exitFullscreen()
      else await element.requestFullscreen()
    } catch { onError('Fullscreen mode is unavailable on this desktop.') }
  }

  const connectionState = active.session.status === 'pending' && isViewer ? 'connecting' : active.connectionState
  // Statistics belong to a currently connected transport. Do not keep old numbers during a failure/reconnect.
  const liveMetrics: SessionMetrics = connectionState === 'connected' ? metrics : {}
  const livePresentation = connectionState === 'connected' ? presentation : null
  const sharingPermissionLabels = permissions.map(permissionLabel).join(' · ')
  const remoteControlMessage = remoteControlMessageFor(active.role, remoteControl, remoteControlReason)

  return <section className="active-session" onDragOver={event => { if (canTransferFiles) event.preventDefault() }} onDrop={onDrop}>
    <div className="session-toolbar">
      <div className="session-peer">
        <div className="session-peer-icon"><Monitor size={18}/></div>
        <div><strong>{active.peer.name}</strong><small>{active.peer.id} · {sessionLabel}</small></div>
      </div>
      <div className={`session-state state-${connectionState}`}><i/>{stateLabel(connectionState)}</div>
      <button className="danger-outline" onClick={() => void disconnect()} disabled={stopping}><Square size={13}/> Disconnect</button>
    </div>

    {active.session.status === 'pending' && isViewer && <div className="session-message pending-message"><LockKeyhole size={18}/><div><strong>Waiting for remote approval</strong><p>The remote user must approve this request before screen sharing begins.</p></div></div>}
    {active.session.status === 'accepted' && <div className="permission-strip"><ShieldAlert size={15}/><span>Session permissions approved: {sharingPermissionLabels || 'Screen view only'}</span>{!canRemoteControl && <span className="view-only-label">View-only · remote keyboard and mouse were not approved</span>}</div>}
    {canRemoteControl && active.session.status === 'accepted' && (active.role === 'viewer' || shareStarted) && <div className={`remote-control-bar state-${remoteControl}`} role="status">
      <MousePointer2 size={15}/>
      <span>{remoteControlMessage}</span>
      {active.role === 'host' && remoteControl === 'active' && <button className="danger-outline" onClick={() => void revokeRemoteControl()} disabled={remoteControlBusy}>Stop remote control</button>}
      {active.role === 'host' && remoteControl !== 'active' && <button className="primary" onClick={() => void enableRemoteControl()} disabled={remoteControlBusy || !localStream}>Enable remote control</button>}
    </div>}

    <div className="remote-view-layout">
      <div className={`remote-stage ${fitMode === 'actual' ? 'actual-size' : ''}`}>
        {remoteStream && connectionState === 'connected' ? <video ref={videoRef} autoPlay playsInline className="remote-video" aria-label={`Remote display from ${active.peer.name}`}/> : <div className="remote-placeholder">
          <div className="placeholder-icon">{active.role === 'host' ? <MonitorUp size={28}/> : <Signal size={27}/>}</div>
          <strong>{active.session.status === 'pending' ? 'Approval is required' : connectionState === 'failed' ? 'Connection failed' : connectionState === 'degraded' || connectionState === 'reconnecting' ? 'Connection interrupted' : active.role === 'host' && !shareStarted ? 'Your screen is not being shared' : 'Waiting for the remote display'}</strong>
          <p>{connectionState === 'failed' || connectionState === 'degraded' || connectionState === 'reconnecting'
            ? 'No live display is available. Check ICE/STUN/TURN and both devices’ connectivity; close the session if it does not recover.'
            : active.role === 'host' && active.session.status === 'accepted'
            ? 'Choose a screen to share. G1Viewer shows a native source-selection dialog and captures only after your confirmation.'
            : active.role === 'viewer' && active.session.status === 'accepted'
              ? 'The remote user must start screen sharing on their computer. You will see the live display here after WebRTC connects.'
              : active.session.status === 'pending'
                ? 'No screen or input data is available until the remote user approves this session.'
                : 'Check the server, ICE/STUN/TURN configuration, and both devices’ network connectivity.'}</p>
          {active.role === 'host' && active.session.status === 'accepted' && !shareStarted && <button className="primary" onClick={() => void startSharing()} disabled={!prepared || connectionState === 'failed'}><MonitorUp size={15}/>{prepared ? 'Choose screen & share' : 'Preparing secure transport…'}</button>}
          {connectionState === 'failed' && <button className="subtle" onClick={() => void disconnect('Connection failed')}><X size={13}/> Close session</button>}
        </div>}
        {localStream && active.role === 'host' && <div className="local-preview"><video ref={localVideoRef} autoPlay playsInline muted aria-label="Local screen-share preview"/><span>{connectionState === 'connected' ? 'Sharing this display' : 'Selected display · peer not connected'}</span></div>}
        {remoteStream && connectionState === 'connected' && <div className="view-controls">
          <button className="subtle" onClick={() => setFitMode(mode => mode === 'fit' ? 'actual' : 'fit')} title={fitMode === 'fit' ? 'Show actual size' : 'Fit to window'}>{fitMode === 'fit' ? 'Fit' : 'Actual size'}</button>
          <button className="subtle icon-only" aria-label="Toggle fullscreen" onClick={() => void enterFullscreen()}><Fullscreen size={15}/></button>
        </div>}
        {!canTransferFiles && <span className="drop-hint">File transfer permission was not approved</span>}
      </div>

      <aside className="session-details">
        <div className="session-detail-card">
          <div className="detail-heading"><Signal size={15}/><strong>Connection quality</strong></div>
          <div className="metric-grid">
            <Metric label="Frame rate" value={livePresentation?.presentedFps !== null && livePresentation?.presentedFps !== undefined ? `${livePresentation.presentedFps.toFixed(0)} fps` : liveMetrics.framesPerSecond !== undefined ? `${liveMetrics.framesPerSecond.toFixed(1)} fps` : 'Unavailable'}/>
            <Metric label="Resolution" value={liveMetrics.width && liveMetrics.height ? `${liveMetrics.width} × ${liveMetrics.height}` : 'Unavailable'}/>
            <Metric label="Video bitrate" value={liveMetrics.bitrateKbps !== undefined ? `${liveMetrics.bitrateKbps.toFixed(0)} kb/s` : 'Unavailable'}/>
            <Metric label="Round trip" value={liveMetrics.roundTripTimeMs !== undefined ? `${liveMetrics.roundTripTimeMs.toFixed(0)} ms` : 'Unavailable'}/>
            <Metric label="Packet loss" value={liveMetrics.packetLossPercent !== undefined ? `${liveMetrics.packetLossPercent.toFixed(1)}%` : 'Unavailable'}/>
            <Metric label="Transport" value={liveMetrics.transport || 'Unavailable'}/>
            <Metric label="Jitter buffer" value={liveMetrics.jitterBufferMs !== undefined ? `${liveMetrics.jitterBufferMs.toFixed(0)} ms` : 'Unavailable'}/>
            <Metric label="Decode" value={liveMetrics.decodeMs !== undefined ? `${liveMetrics.decodeMs.toFixed(1)} ms/frame` : 'Unavailable'}/>
            <Metric label="Capture to screen (p50)" value={livePresentation?.captureAgeMs ? `${livePresentation.captureAgeMs.p50.toFixed(0)} ms` : 'Unavailable'}/>
            <Metric label="Capture to screen (p95)" value={livePresentation?.captureAgeMs ? `${livePresentation.captureAgeMs.p95.toFixed(0)} ms` : 'Unavailable'}/>
            <Metric label="Dropped frames" value={livePresentation?.droppedFrames !== undefined && livePresentation?.droppedFrames !== null ? String(livePresentation.droppedFrames) : liveMetrics.droppedFrames !== undefined ? String(liveMetrics.droppedFrames) : 'Unavailable'}/>
            <Metric label="Encode (host)" value={liveMetrics.encodeMs !== undefined ? `${liveMetrics.encodeMs.toFixed(1)} ms/frame` : 'Unavailable'}/>
          </div>
          <div className="security-line quality-line">
            <span>Quality profile</span>
            <select value={qualityChoice} onChange={event => chooseQuality(event.target.value as QualityProfileId)} aria-label="Quality profile" disabled={!controller}>
              {QUALITY_PROFILE_IDS.map(id => <option key={id} value={id}>{id === 'auto' ? 'Automatic (60 FPS default)' : QUALITY_PROFILES[id].label}</option>)}
            </select>
          </div>
          <small className="metric-foot">{effectiveQuality ? `Sender target: ${QUALITY_PROFILES[effectiveQuality.profile].label}${effectiveQuality.mode === 'auto' ? ' (adapting automatically)' : ''}. Actual quality depends on the connection.` : 'Sender profile is unavailable until the host reports it.'}</small>
          <small className="metric-foot">Values are measured from WebRTC statistics and frame callbacks. Capture-to-screen compares sender and receiver clocks and is an estimate across machines.</small>
        </div>

        <div className="session-detail-card">
          <div className="detail-heading"><LockKeyhole size={15}/><strong>Session security</strong></div>
          <div className="security-line"><span>Device identity</span><code>{active.peer.id}</code></div>
          <div className="security-line"><span>Approval</span><strong>{active.session.status === 'accepted' ? active.role === 'host' ? 'Approved on this device' : 'Approved on host' : 'Pending'}</strong></div>
          <div className="security-line"><span>Protocol</span><strong>WebRTC DTLS-SRTP (after connection)</strong></div>
          <p className="detail-note">WebRTC media and data channels are encrypted. The signaling service carries setup messages, not screen video.</p>
        </div>

        <div className="session-detail-card transfer-card">
          <div className="detail-heading"><ArrowLeftRight size={15}/><strong>Data tools</strong></div>
          {canTransferFiles ? <>
            <input ref={fileInputRef} className="sr-only" type="file" multiple onChange={event => { void sendSelectedFiles(event.target.files || []); event.currentTarget.value = '' }}/>
            <button className="tool-button" onClick={selectFiles} disabled={!dataChannel || dataChannel.readyState !== 'open'}><FileUp size={15}/> Send file(s)</button>
            <p className="detail-note">Files are sent in bounded encrypted chunks, saved only after local approval, and SHA-256 verified. Max 1 GiB per file.</p>
          </> : <p className="detail-note">File transfer was not approved for this session.</p>}
          {canShareClipboard ? <button className="tool-button" onClick={() => void sendClipboard()} disabled={!dataChannel || dataChannel.readyState !== 'open' || clipboardBusy}><Clipboard size={15}/> Send clipboard text</button> : <p className="detail-note">Clipboard transfer was not approved for this session.</p>}
          {canTransferFiles && transfers.length > 0 && <div className="transfer-list">{transfers.map(transfer => <TransferItem key={transfer.id} transfer={transfer} cancel={() => transferManagerRef.current?.cancel(transfer.id)}/>)}</div>}
        </div>
      </aside>
    </div>
  </section>
}

function remoteControlMessageFor(role: 'viewer' | 'host', state: RemoteControlState, reason: string): string {
  switch (state) {
    case 'off': return 'Remote keyboard and mouse are not active.'
    case 'pending': return role === 'host'
      ? 'The approved viewer can control this display after you enable remote control.'
      : 'Waiting for the host to enable remote control.'
    case 'active': return role === 'host'
      ? 'The approved viewer is controlling this display. Stop remote control at any time.'
      : 'Remote control is active. Click the display to control it.'
    case 'unavailable': return `Remote control is unavailable${reason ? `: ${reason}` : '.'}`
    case 'revoked': return `Remote control stopped${reason ? `: ${reason}` : '.'}`
  }
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><small>{label}</small><strong>{value}</strong></div>
}

function TransferItem({ transfer, cancel }: { transfer: TransferRecord; cancel: () => void }) {
  const percent = progressPercent(transfer)
  return <div className="transfer-item">
    <div className="transfer-top"><File size={13}/><strong title={transfer.name}>{transfer.name}</strong>{transfer.status !== 'complete' && transfer.status !== 'failed' && transfer.status !== 'cancelled' && <button aria-label={`Cancel ${transfer.name}`} onClick={cancel}><X size={12}/></button>}</div>
    <progress className="transfer-progress" value={percent} max={100} aria-label={`${percent}% transferred`}/>
    <small>{transfer.direction === 'sending' ? 'Sending' : 'Receiving'} · {formatBytes(transfer.transferred)} / {formatBytes(transfer.size)} · {transfer.status}{transfer.error ? ` · ${transfer.error}` : ''}</small>
  </div>
}
