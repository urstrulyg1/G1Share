import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Activity, ArrowLeftRight, ArrowRight, Bell, Check, Clock3, Copy, Github, HardDrive,
  Home, Laptop, LockKeyhole, Monitor, MonitorCheck, Moon, Radio, RefreshCw, Search,
  Settings, ShieldAlert, ShieldCheck, Signal, Sparkles, Sun, Wifi, X, Clipboard,
  File, Trash2, UserRound, ExternalLink, CircleHelp
} from 'lucide-react'
import type { SessionPermission, TrustedDevice } from '../../shared/types'
import { isValidDeviceId, normalizeDeviceId } from '../../shared/device-id'
import { useOpenDesk } from './hooks/useOpenDesk'
import type { IncomingSessionRequest, RecentSession } from './hooks/useOpenDesk'
import { ActiveSessionView } from './components/ActiveSessionView'

export type Page = 'Home' | 'Devices' | 'Recent sessions' | 'File transfer' | 'Diagnostics' | 'Settings' | 'Remote session'
type Notice = { kind: 'success' | 'info' | 'error'; message: string }

const nav: { label: Exclude<Page, 'Remote session'>; icon: typeof Home }[] = [
  { label: 'Home', icon: Home },
  { label: 'Devices', icon: Monitor },
  { label: 'Recent sessions', icon: Clock3 },
  { label: 'File transfer', icon: ArrowLeftRight },
  { label: 'Diagnostics', icon: Activity },
  { label: 'Settings', icon: Settings }
]

export default function App() {
  const openDesk = useOpenDesk()
  const [page, setPage] = useState<Page>('Home')
  const [remoteId, setRemoteId] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => localStorage.getItem('opendesk.theme') === 'light' ? 'light' : 'dark')
  const [requestFiles, setRequestFiles] = useState(false)
  const [requestClipboard, setRequestClipboard] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => { localStorage.setItem('opendesk.theme', theme) }, [theme])
  useEffect(() => {
    if (openDesk.activeSession) setPage('Remote session')
    else if (page === 'Remote session') setPage('Home')
  }, [openDesk.activeSession, page])

  const reportError = useCallback((message: string) => setNotice({ kind: 'error', message }), [])

  async function copyId() {
    if (!openDesk.device) return
    try {
      await window.openDesk.copyText(openDesk.device.deviceId)
      setNotice({ kind: 'success', message: 'Device ID copied. It identifies this device but is not an access password.' })
    } catch (error) { reportError(error instanceof Error ? error.message : 'Could not copy the device ID.') }
  }

  async function connect(deviceId = remoteId) {
    const normalized = normalizeDeviceId(deviceId)
    if (!isValidDeviceId(normalized)) {
      setNotice({ kind: 'error', message: 'Enter a device ID in the format XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX (legacy IDs remain accepted).' })
      return
    }
    if (openDesk.serviceState !== 'online') {
      setNotice({ kind: 'error', message: openDesk.serviceError || 'Connect to a signaling service before requesting a session.' })
      return
    }
    setBusy(true)
    try {
      const requested: SessionPermission[] = []
      if (requestFiles) requested.push('files')
      if (requestClipboard) requested.push('clipboard')
      const session = await openDesk.requestSession(normalized, requested)
      setRemoteId(normalized)
      setPage('Remote session')
      setNotice({ kind: 'info', message: `Session request sent. The remote user must approve access before any screen data is shared.` })
      setRefresh(value => value + 1)
      void session
    } catch (error) {
      reportError(error instanceof Error ? error.message : 'Could not request a remote session.')
    } finally { setBusy(false) }
  }

  async function approve(request: IncomingSessionRequest, allowRequested: boolean) {
    if (openDesk.activeSession) {
      reportError('Disconnect the current session before approving another request.')
      return
    }
    setBusy(true)
    try {
      const granted: SessionPermission[] = ['view']
      if (allowRequested) {
        if (request.session.requestedPermissions.includes('files')) granted.push('files')
        if (request.session.requestedPermissions.includes('clipboard')) granted.push('clipboard')
      }
      await openDesk.approveSession(request.session.id, granted)
      setPage('Remote session')
      setNotice({ kind: 'success', message: 'Session approved. Screen sharing will not begin until you choose a display.' })
    } catch (error) { reportError(error instanceof Error ? error.message : 'Could not approve the session.') }
    finally { setBusy(false) }
  }

  async function reject(request: IncomingSessionRequest) {
    try {
      await openDesk.rejectSession(request.session.id)
      setNotice({ kind: 'info', message: `Session request from ${request.peer.name} was rejected.` })
    } catch (error) { reportError(error instanceof Error ? error.message : 'Could not reject the session.') }
  }

  const filteredDevices = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return openDesk.knownDevices
    return openDesk.knownDevices.filter(device => device.name.toLowerCase().includes(text) || device.id.toLowerCase().includes(text) || device.platform.toLowerCase().includes(text))
  }, [openDesk.knownDevices, query])
  const platform = openDesk.device ? (({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' } as Record<string, string>)[openDesk.device.platform] || openDesk.device.platform) : 'Detecting platform'
  const statusLabel = openDesk.serviceState === 'online' ? 'Signaling connected' : openDesk.serviceState === 'connecting' ? 'Connecting to signaling' : openDesk.serviceState === 'blocked' ? 'Identity needs attention' : openDesk.serviceState === 'loading' ? 'Starting OpenDesk' : 'Signaling offline'
  const currentPage = openDesk.activeSession ? 'Remote session' : page

  return <div className={`app-shell theme-${theme}`}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><ArrowLeftRight size={20}/></div><div><strong>OpenDesk</strong><small>REMOTE, WITHOUT LIMITS</small></div></div>
      <div className="nav-label">WORKSPACE</div>
      <nav>{nav.map(({ label, icon: Icon }) => <button key={label} className={'nav-item ' + (page === label || (label === 'File transfer' && page === 'Remote session' && openDesk.activeSession?.session.permissions?.includes('files')) ? 'active' : '')} onClick={() => setPage(openDesk.activeSession ? 'Remote session' : label)}><Icon size={17}/><span>{label}</span>{label === 'File transfer' && <small>{openDesk.activeSession?.session.permissions?.includes('files') ? 'LIVE' : ''}</small>}{label === 'Devices' && openDesk.incomingRequests.length > 0 && <b className="nav-badge">{openDesk.incomingRequests.length}</b>}</button>)}</nav>
      <div className="sidebar-bottom">
        <div className="free-card"><ShieldCheck size={19}/><strong>Free by design.</strong><p>Self-hosted signaling and standard WebRTC. Your devices, your choice.</p><button onClick={() => setPage('Settings')}>Connection settings <ArrowRight size={13}/></button></div>
        <button className="github-link" onClick={() => void window.openDesk.openProjectPage()}><Github size={16}/> Open-source project <ExternalLink size={13}/></button>
        <div className="profile"><div className="avatar"><Laptop size={15}/></div><div><strong>{openDesk.device?.deviceName || 'Local device'}</strong><small>{platform}</small></div><span className={`green-dot ${openDesk.serviceState === 'online' ? '' : 'dot-muted'}`}/></div>
      </div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div className="crumb">Workspace <span>/</span> <strong>{currentPage}</strong></div>
        <div className="top-actions"><span className={`status-pill status-${openDesk.serviceState}`}><i/>{statusLabel}</span><button className="icon-button" aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={16}/> : <Moon size={16}/>}</button><button className="icon-button" aria-label="Diagnostics" onClick={() => setPage('Diagnostics')}><CircleHelp size={16}/></button></div>
      </header>

      {notice && <div className={`notice notice-${notice.kind}`} role="status"><span>{notice.kind === 'success' ? <Check size={15}/> : notice.kind === 'error' ? <X size={15}/> : <CircleHelp size={15}/>}</span><p>{notice.message}</p><button aria-label="Dismiss" onClick={() => setNotice(null)}><X size={14}/></button></div>}
      {openDesk.incomingRequests.length > 0 && <IncomingRequests requests={openDesk.incomingRequests} busy={busy} hasActiveSession={!!openDesk.activeSession} approve={approve} reject={reject}/>}

      {openDesk.activeSession && openDesk.device && <>
        <Heading eyebrow="LIVE REMOTE SESSION" title="Remote session" description="A session is active only after remote approval. Stop sharing or disconnect at any time."/>
        <ActiveSessionView active={openDesk.activeSession} localDevice={openDesk.device} client={openDesk.signalingClient} signals={openDesk.signals} onState={openDesk.updateConnectionState} onFinish={openDesk.finishSession} onError={reportError}/>
      </>}

      {!openDesk.activeSession && page === 'Home' && <>
        <section className="welcome"><div><div className="eyebrow"><Sparkles size={13}/> YOUR REMOTE WORKSPACE</div><h1>Good to see you.</h1><p>Connect to another computer. Screen sharing starts only after the remote user approves.</p></div><div className="orbit"><span><Monitor size={16}/></span><b><ArrowLeftRight size={28}/></b><i><Laptop size={15}/></i></div></section>
        <section className="connect-card">
          <div className="connect-title"><div className="section-icon"><Radio size={19}/></div><div><h2>Connect to a device</h2><p>Enter the ID shown in the other OpenDesk installation.</p></div><span className="consent"><LockKeyhole size={12}/> Approval required</span></div>
          <form onSubmit={event => { event.preventDefault(); void connect() }}><label className="sr-only" htmlFor="remote-id">Remote device ID</label><div className="input-wrap"><Monitor size={16}/><input id="remote-id" value={remoteId} maxLength={35} autoComplete="off" spellCheck={false} onChange={event => setRemoteId(event.target.value)} placeholder="Device ID · XXXXXXXX-XXXXXXXX-…"/></div><button className="primary" type="submit" disabled={busy || openDesk.serviceState !== 'online'}>{busy ? 'Requesting…' : 'Request access'} <ArrowRight size={15}/></button></form>
          <div className="permission-request-row"><span>Request additional permissions (optional)</span><label><input type="checkbox" checked={requestFiles} onChange={event => setRequestFiles(event.target.checked)}/> File transfer</label><label><input type="checkbox" checked={requestClipboard} onChange={event => setRequestClipboard(event.target.checked)}/> One-time clipboard text</label></div>
          <div className="connect-foot"><span><LockKeyhole size={13}/> Device IDs locate devices; they never grant access.</span><button onClick={() => setPage('Diagnostics')}>View connection diagnostics <ArrowRight size={13}/></button></div>
        </section>

        <section className="section"><div className="section-head"><div><h2>Your device</h2><p>This identity authenticates signaling requests and does not authorize incoming sessions.</p></div><button className="subtle" onClick={() => void copyId()} disabled={!openDesk.device}><Copy size={13}/> Copy ID</button></div>
          <div className="device-card"><div className="device-icon"><MonitorCheck size={24}/></div><div className="device-main"><strong>{platform} device <em>THIS DEVICE</em></strong><small>{openDesk.device ? `${openDesk.device.platform} · ${openDesk.device.architecture}` : 'Loading local identity'}</small><div className="id-row"><code>{openDesk.device?.deviceId || '••••••••-••••••••-••••••••-••••••••'}</code><button aria-label="Copy device ID" onClick={() => void copyId()} disabled={!openDesk.device}><Copy size={13}/></button></div></div><div className="local-only"><span className={openDesk.device?.identityReady ? '' : 'dot-warning'}/>{openDesk.device?.identityReady ? 'Authenticated' : 'Key unavailable'}<small>{openDesk.device?.secureStorageBackend || 'checking secure storage'}</small></div></div>
          {!openDesk.device?.identityReady && openDesk.device && <div className="inline-warning"><ShieldAlert size={15}/><span>{openDesk.device.identityMessage}</span><button onClick={() => setPage('Diagnostics')}>Details</button></div>}
        </section>

        <section className="section"><div className="section-head"><div><h2>Connection status</h2><p>Live state from the configured signaling service.</p></div><span className={`status-text status-text-${openDesk.serviceState}`}><i/>{statusLabel}</span></div>
          <div className="service-card"><div className="service-icon"><Signal size={20}/></div><div><strong>{openDesk.serviceState === 'online' ? 'Signaling service reachable' : openDesk.serviceState === 'blocked' ? 'Secure device identity required' : 'No active signaling connection'}</strong><p>{openDesk.serviceError || `Configured endpoint: ${openDesk.signalingUrl}`}</p></div><button className="subtle" onClick={() => setPage('Settings')}><Settings size={13}/> Configure</button></div>
        </section>
        <section className="section"><div className="section-head"><div><h2>Built around explicit consent</h2><p>Every session request remains visible to the remote user.</p></div></div><div className="feature-grid"><Feature icon={ShieldCheck} title="Approval on the remote device" text="No unattended access exists in this build. Each request must be approved locally."/><Feature icon={Wifi} title="Peer-to-peer transport" text="Screen media uses WebRTC; signaling carries setup only. TURN can be self-hosted for restrictive networks."/><Feature icon={LockKeyhole} title="Narrow capabilities" text="This build provides remote viewing, approved file transfer, and one-time clipboard text. Remote input and audio are not implemented."/></div></section>
      </>}

      {!openDesk.activeSession && page === 'Devices' && <>
        <Heading title="Devices" eyebrow="DEVICE MANAGEMENT" description="Devices are located by ID. Trust fingerprints before connecting; every remote session still requires approval." action={<button className="subtle" onClick={() => { void openDesk.refreshTrustedDevices(); setRefresh(value => value + 1) }}><RefreshCw size={13}/> Refresh</button>}/>
        <div className="search"><Search size={15}/><input placeholder="Search known devices" value={query} onChange={event => setQuery(event.target.value)}/></div>
        {filteredDevices.length > 0 ? <div className="device-list">{filteredDevices.map(device => <article className="device-card" key={device.id}><div className="device-icon"><Monitor size={22}/></div><div className="device-main"><strong>{device.name}<em>{device.platform}</em></strong><small>{device.appVersion} · {device.online ? 'Online at last lookup' : 'Status from last lookup may be stale'}</small><div className="id-row"><code>{device.id}</code></div></div><div className="device-actions"><span className={device.online ? 'online-label' : 'offline-label'}><i/>{device.online ? 'Online' : 'Last seen offline'}</span><button className="subtle" onClick={() => void connect(device.id)} disabled={busy || openDesk.serviceState !== 'online'}>Request access <ArrowRight size={13}/></button></div></article>)}</div> : <EmptyInline icon={HardDrive} title={query ? 'No matching devices' : 'No discovered devices yet'} description="Look up a device by its ID from the Home screen. The list is local and contains no access credentials."/>}
        <TrustedDevices devices={openDesk.trustedDevices} forget={openDesk.forgetTrustedDevice} refresh={() => void openDesk.refreshTrustedDevices()} error={reportError}/>
      </>}

      {!openDesk.activeSession && page === 'Recent sessions' && <>
        <Heading eyebrow="SESSION HISTORY" title="Recent sessions" description="Local history records session times and outcomes. It contains no screen, file, or clipboard content." action={<span className="history-count">{openDesk.recentSessions.length} saved locally</span>}/>
        {openDesk.recentSessions.length > 0 ? <div className="history-list">{openDesk.recentSessions.map(session => <RecentSessionRow key={session.id} session={session}/>)}</div> : <EmptyState icon={Clock3} title="No sessions yet" description="A session appears here after a connection request is approved, rejected, or closed."/>}
      </>}

      {!openDesk.activeSession && page === 'File transfer' && <>
        <Heading eyebrow="SECURE DATA CHANNEL" title="File transfer" description="Transfers use encrypted WebRTC data channels, explicit destination selection, bounded chunks, and SHA-256 verification."/>
        <div className="feature-detail"><div><File size={24}/></div><h2>Connect and request file transfer</h2><p>Start a session from Home and request the file-transfer permission. The remote user chooses whether to grant it, and approves each received file separately. While a session is active, send files from the session panel.</p><button className="subtle" onClick={() => setPage('Home')}>Go to connection <ArrowRight size={13}/></button></div>
      </>}

      {!openDesk.activeSession && page === 'Remote session' && <>
        <Heading eyebrow="LIVE REMOTE SESSION" title="Remote session" description="A session is active only after remote approval. You can disconnect or stop sharing at any time."/>
        <EmptyState icon={Signal} title="No active session" description="Connect from Home or approve an incoming request to start an authorized session."/>
      </>}

      {!openDesk.activeSession && page === 'Diagnostics' && <>
        <Heading eyebrow="HEALTH & TROUBLESHOOTING" title="Diagnostics" description="Values below are read from local capabilities and live signaling state; unavailable measurements are not fabricated." action={<button className="subtle" onClick={() => { setRefresh(value => value + 1); void openDesk.refreshTrustedDevices() }}><RefreshCw size={13}/> Refresh</button>}/>
        <div className="health-card"><Activity size={20}/><div><strong>{openDesk.serviceState === 'online' ? 'Signaling connection operational' : 'Signaling connection unavailable'}</strong><p>{openDesk.serviceError || `Configured server: ${openDesk.signalingUrl}`}</p></div><span className={openDesk.serviceState === 'online' ? 'good' : 'muted'}>● {statusLabel}</span></div>
        <div className="diag-list">
          <Diag label="Application version" detail={openDesk.device?.appVersion || 'Loading'} state={openDesk.device?.appVersion || 'Loading'} good={!!openDesk.device}/>
          <Diag label="Local device identity" detail={openDesk.device?.deviceId || 'Loading'} state={openDesk.device?.identityReady ? 'Secure key available' : 'Unavailable'} good={!!openDesk.device?.identityReady}/>
          <Diag label="Credential storage" detail={openDesk.device?.secureStorageBackend || 'Unknown'} state={openDesk.device?.identityReady ? 'Ready' : 'Needs attention'} good={!!openDesk.device?.identityReady}/>
          <Diag label="Signaling service" detail={openDesk.signalingUrl} state={openDesk.serviceState === 'online' ? 'Connected' : openDesk.serviceState} good={openDesk.serviceState === 'online'}/>
          <Diag label="Screen capture" detail={openDesk.capabilities?.screenCapture || 'Loading capability status'} state={openDesk.capabilities ? 'Available with OS permission' : 'Loading'} good={!!openDesk.capabilities}/>
          <Diag label="WebRTC / ICE" detail="Peer-to-peer connection uses Chromium WebRTC; STUN/TURN endpoints are provided by the signaling service." state="Not connected"/>
          <Diag label="Remote input" detail={openDesk.capabilities?.remoteInput || 'Not implemented'} state="Not implemented"/>
          <Diag label="Remote audio" detail={openDesk.capabilities?.audioCapture || 'Not implemented'} state="Not implemented"/>
          <Diag label="Clipboard" detail={openDesk.capabilities?.clipboard || 'Not implemented'} state="User-confirmed, one-time text only"/>
          <Diag label="File transfer" detail="Encrypted data-channel chunks, user-selected destination, and SHA-256 verification. Directory transfers and resume are not implemented." state="Requires session permission"/>
        </div>
        <div className="diag-actions"><button className="subtle" onClick={() => void copyDiagnostics(openDesk.device, openDesk.signalingUrl, openDesk.serviceState, openDesk.serviceError, openDesk.capabilities, openDesk.activeSession?.connectionState, reportError, setNotice)}><Copy size={13}/> Copy sanitized diagnostics</button><small>Includes no keys, credentials, clipboard contents, screen data, or file data.</small></div>
        <p className="diag-foot">Platform: {openDesk.device?.platform || 'detecting'} · Architecture: {openDesk.device?.architecture || 'detecting'} · Refresh {refresh}</p>
      </>}

      {!openDesk.activeSession && page === 'Settings' && <SettingsPage state={openDesk} theme={theme} setTheme={setTheme} error={reportError} success={message => setNotice({ kind: 'success', message })}/>}
      <footer><span>OpenDesk · v{openDesk.device?.appVersion || '0.1.0'}</span><span><LockKeyhole size={12}/> Consent-first · Remote keyboard, audio, and unattended access are not implemented</span></footer>
    </main>
  </div>
}

function Heading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>
}

function Feature({ icon: Icon, title, text }: { icon: typeof ShieldCheck; title: string; text: string }) {
  return <article className="feature"><div><Icon size={18}/></div><strong>{title}</strong><p>{text}</p></article>
}

function IncomingRequests({ requests, busy, hasActiveSession, approve, reject }: { requests: IncomingSessionRequest[]; busy: boolean; hasActiveSession: boolean; approve: (request: IncomingSessionRequest, allowRequested: boolean) => void; reject: (request: IncomingSessionRequest) => void }) {
  return <section className="incoming-section"><div className="incoming-heading"><Bell size={16}/><strong>Incoming session requests</strong><span>{requests.length}</span></div>{requests.map(request => <IncomingRequest key={request.session.id} request={request} busy={busy} hasActiveSession={hasActiveSession} approve={approve} reject={reject}/>)}</section>
}

function IncomingRequest({ request, busy, hasActiveSession, approve, reject }: { request: IncomingSessionRequest; busy: boolean; hasActiveSession: boolean; approve: (request: IncomingSessionRequest, allowRequested: boolean) => void; reject: (request: IncomingSessionRequest) => void }) {
  const [grantExtras, setGrantExtras] = useState(false)
  const extraLabels = request.session.requestedPermissions.filter(permission => permission !== 'view').map(permission => permission === 'files' ? 'file transfer' : 'one-time clipboard text').join(' and ')
  return <article className="incoming-card"><div className="incoming-icon"><ShieldAlert size={19}/></div><div className="incoming-copy"><strong>{request.peer.name} wants to view this device</strong><small>{request.peer.id} · {request.peer.platform} · Only this device can approve.</small><div className="incoming-permissions"><LockKeyhole size={12}/> Requested: {request.session.requestedPermissions.map(permission => permission === 'view' ? 'screen view' : permission === 'files' ? 'file transfer' : 'clipboard text').join(' · ')}</div><label className="grant-extra"><input type="checkbox" checked={grantExtras} onChange={event => setGrantExtras(event.target.checked)} disabled={!extraLabels}/> Grant requested extras ({extraLabels || 'none requested'})</label><small className="fingerprint-note">A first-time device key must be verified before approval. Screen sharing does not start until you separately choose a display.</small></div><div className="incoming-actions"><button className="danger-outline" onClick={() => reject(request)} disabled={busy}>Reject</button><button className="primary" onClick={() => approve(request, grantExtras)} disabled={busy || hasActiveSession}><Check size={14}/> Approve view</button></div></article>
}

function EmptyInline({ icon: Icon, title, description }: { icon: typeof HardDrive; title: string; description: string }) {
  return <div className="empty-inline"><Icon size={22}/><strong>{title}</strong><span>{description}</span></div>
}

function EmptyState({ icon: Icon, title, description }: { icon: typeof Clock3; title: string; description: string }) {
  return <div className="empty-state"><div><Icon size={27}/></div><h2>{title}</h2><p>{description}</p></div>
}

function TrustedDevices({ devices, forget, refresh, error }: { devices: TrustedDevice[]; forget: (id: string) => Promise<boolean>; refresh: () => void; error: (message: string) => void }) {
  return <section className="section trusted-section"><div className="section-head"><div><h2>Trusted device fingerprints</h2><p>Public-key pins are stored locally. A changed key blocks connection until you remove the old pin and verify the new fingerprint.</p></div><button className="subtle" onClick={refresh}><RefreshCw size={13}/> Refresh</button></div>{devices.length === 0 ? <div className="empty-inline compact"><ShieldCheck size={18}/><span>No device fingerprints are trusted yet. The first connection flow asks you to verify and trust one.</span></div> : <div className="trusted-list">{devices.map(device => <div className="trusted-row" key={device.id}><div className="trusted-icon"><LockKeyhole size={15}/></div><div><strong>{device.name}</strong><small>{device.id} · Trusted {new Date(device.trustedAt).toLocaleString()}</small><code>{device.fingerprint}</code></div><button className="subtle" onClick={() => void forget(device.id).catch(reason => error(reason instanceof Error ? reason.message : 'Could not remove device trust.'))}><Trash2 size={13}/> Forget</button></div>)}</div>}</section>
}

function RecentSessionRow({ session }: { session: RecentSession }) {
  return <article className="recent-row"><div className="recent-icon"><Monitor size={17}/></div><div className="recent-main"><strong>{session.role === 'viewer' ? 'Connected to' : 'Hosted session with'} {session.peerName}</strong><small>{session.peerId} · {new Date(session.startedAt).toLocaleString()}</small></div><span className={`recent-result ${session.result === 'Connected' || session.result === 'Disconnected' ? 'result-good' : ''}`}>{session.result}</span><small className="recent-ended">Ended {new Date(session.endedAt).toLocaleTimeString()}</small></article>
}

function Diag({ label, detail, state, good = false }: { label: string; detail: string; state: string; good?: boolean }) {
  return <div className="diag-row"><div><strong>{label}</strong><small>{detail}</small></div><span className={good ? 'good' : 'muted'}>● {state}</span></div>
}

function SettingsPage({ state, theme, setTheme, error, success }: { state: ReturnType<typeof useOpenDesk>; theme: 'dark' | 'light'; setTheme: (theme: 'dark' | 'light') => void; error: (message: string) => void; success: (message: string) => void }) {
  const [urlInput, setUrlInput] = useState(state.signalingUrl)
  const [nameInput, setNameInput] = useState(state.localDevice?.name || state.device?.deviceName || '')
  const [savingURL, setSavingURL] = useState(false)
  const [savingName, setSavingName] = useState(false)
  useEffect(() => { setUrlInput(state.signalingUrl) }, [state.signalingUrl])
  useEffect(() => { setNameInput(state.localDevice?.name || state.device?.deviceName || '') }, [state.localDevice?.name, state.device?.deviceName])

  async function saveURL(event: FormEvent) {
    event.preventDefault()
    setSavingURL(true)
    try {
      const url = await state.setServerURL(urlInput)
      setUrlInput(url)
      success('Signaling server saved. OpenDesk is reconnecting to the new endpoint.')
    } catch (reason) { error(reason instanceof Error ? reason.message : 'Could not save the signaling server URL.') }
    finally { setSavingURL(false) }
  }
  async function saveName(event: FormEvent) {
    event.preventDefault()
    setSavingName(true)
    try {
      await state.renameLocalDevice(nameInput.trim())
      success('Device name updated on the signaling service.')
    } catch (reason) { error(reason instanceof Error ? reason.message : 'Could not update device name.') }
    finally { setSavingName(false) }
  }

  async function revokeIdentity() {
    try {
      const device = await state.resetDeviceIdentity()
      if (!device) return
      success(`Identity reset completed. This device now has a new ID: ${device.deviceId}. Share it with peers and verify the new fingerprint before reconnecting.`)
    } catch (reason) { error(reason instanceof Error ? reason.message : 'Could not revoke and reset the device identity.') }
  }

  return <>
    <Heading eyebrow="PREFERENCES & SECURITY" title="Settings" description="Settings that affect the real app are connected to the main process and signaling service."/>
    <div className="settings-card"><div className="settings-head"><h2>Appearance</h2><p>Local interface preference.</p></div><div className="setting"><div className="setting-icon"><Sun size={16}/></div><div className="setting-copy"><strong>Color theme</strong><small>Choose a dark or light interface.</small></div><div className="segmented"><button className={theme === 'dark' ? 'selected' : ''} onClick={() => setTheme('dark')}><Moon size={13}/> Dark</button><button className={theme === 'light' ? 'selected' : ''} onClick={() => setTheme('light')}><Sun size={13}/> Light</button></div></div></div>

    <div className="settings-card"><div className="settings-head"><h2>Signaling service</h2><p>LAN development can use loopback. Remote servers must use HTTPS with a trusted certificate.</p></div><form className="settings-form" onSubmit={event => void saveURL(event)}><label htmlFor="signal-url">Signaling server origin</label><div className="settings-form-row"><input id="signal-url" value={urlInput} onChange={event => setUrlInput(event.target.value)} placeholder="https://remote.example.org" spellCheck={false}/><button className="primary" type="submit" disabled={savingURL || !urlInput.trim()}>{savingURL ? 'Saving…' : 'Save & reconnect'}</button></div><small>Default for local development: http://127.0.0.1:8787. Non-loopback HTTP is rejected by the desktop main process.</small></form></div>

    <div className="settings-card"><div className="settings-head"><h2>Device name</h2><p>Displayed to other users. Your device ID remains stable.</p></div><form className="settings-form" onSubmit={event => void saveName(event)}><label htmlFor="device-name">Display name</label><div className="settings-form-row"><input id="device-name" value={nameInput} onChange={event => setNameInput(event.target.value)} maxLength={80}/><button className="subtle" type="submit" disabled={savingName || !nameInput.trim()}><UserRound size={13}/>{savingName ? 'Saving…' : 'Save name'}</button></div></form></div>

    <div className="settings-card"><div className="settings-head"><h2>Privacy and session capabilities</h2><p>These controls reflect implemented behavior; unsupported features are not presented as active switches.</p></div><div className="setting"><div className="setting-icon"><Clipboard size={16}/></div><div className="setting-copy"><strong>Clipboard</strong><small>Manual, one-time text transfer only; requires session permission and local confirmation for each action.</small></div><span className="setting-status">Per-session consent</span></div><div className="setting"><div className="setting-icon"><Monitor size={16}/></div><div className="setting-copy"><strong>Screen capture</strong><small>Only after approval and a separate local display selection.</small></div><button className="subtle" onClick={() => void window.openDesk.openScreenCaptureSettings()}><ExternalLink size={13}/> OS permissions</button></div><div className="setting"><div className="setting-icon"><ShieldAlert size={16}/></div><div className="setting-copy"><strong>Unattended access</strong><small>Not implemented. No background access or silent persistence is enabled.</small></div><span className="setting-status unavailable">Unavailable</span></div></div>

    <div className="settings-card"><div className="settings-head"><h2>Local identity</h2><p>Private Ed25519 identity key is encrypted with the operating-system credential store. Linux basic_text storage is refused.</p></div><div className="setting"><div className="setting-icon"><LockKeyhole size={16}/></div><div className="setting-copy"><strong>{state.device?.deviceId || 'Loading device ID'}</strong><small>{state.device?.secureStorageBackend || 'Unknown credential backend'} · {state.device?.identityReady ? 'Identity key available' : state.device?.identityMessage || 'Checking identity'}</small></div><span className={state.device?.identityReady ? 'good' : 'muted'}>{state.device?.identityReady ? '● Ready' : '● Blocked'}</span></div><div className="setting"><div className="setting-copy"><strong>Revoke and reset identity</strong><small>Closes active sessions, revokes this public key on the signaling service, and creates a new ID. Peers must verify the new fingerprint.</small></div><button className="danger-outline" onClick={() => void revokeIdentity()} disabled={!state.device?.identityReady || !!state.activeSession}>Revoke & reset</button></div></div>

    <div className="warning"><LockKeyhole size={17}/><div><strong>Remote input and audio are not implemented.</strong><p>This build supports approved remote viewing, optional chunked file transfer, and one-time clipboard text. It does not inject keyboard/mouse input, stream audio, or offer unattended access.</p></div></div>
  </>
}

async function copyDiagnostics(device: ReturnType<typeof useOpenDesk>['device'], signalingUrl: string, serviceState: string, serviceError: string, capabilities: ReturnType<typeof useOpenDesk>['capabilities'], connectionState: string | undefined, error: (message: string) => void, success: (notice: Notice) => void) {
  const sanitized = [
    'OpenDesk sanitized diagnostics',
    `Version: ${device?.appVersion || 'unknown'}`,
    `Platform: ${device?.platform || 'unknown'} ${device?.architecture || ''}`,
    `Identity ready: ${device?.identityReady ? 'yes' : 'no'}`,
    `Secure storage: ${device?.secureStorageBackend || 'unknown'}`,
    `Signaling endpoint: ${signalingUrl}`,
    `Signaling state: ${serviceState}`,
    `Signaling error: ${serviceError || 'none'}`,
    `WebRTC state: ${connectionState || 'not connected'}`,
    `Screen capture: ${capabilities?.screenCapture || 'unknown'}`,
    `Remote input: ${capabilities?.remoteInput || 'not implemented'}`,
    `Audio: ${capabilities?.audioCapture || 'not implemented'}`
  ].join('\n')
  try { await window.openDesk.copyText(sanitized); success({ kind: 'success', message: 'Sanitized diagnostic summary copied. No tokens, private keys, clipboard content, screen data, or file content is included.' }) }
  catch (reason) { error(reason instanceof Error ? reason.message : 'Could not copy diagnostics.') }
}
