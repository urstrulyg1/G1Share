import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Activity, ArrowLeftRight, ArrowRight, Bell, Check, Clock3, Copy, HardDrive,
  Home, Laptop, LockKeyhole, Maximize2, Minimize2, Minus, Monitor, MonitorCheck,
  Moon, Radio, RefreshCw, Search, Settings, ShieldAlert, ShieldCheck, Signal,
  Sun, Wifi, X, Clipboard, File, Trash2, ExternalLink, CircleHelp
} from 'lucide-react'
import type { DesktopCapabilities, SessionPermission, TrustedDevice } from '../../shared/types'
import { permissionLabel } from '../../shared/permissions'
import { isValidDeviceId, normalizeDeviceId } from '../../shared/device-id'
import { useOpenDesk } from './hooks/useOpenDesk'
import type { IncomingSessionRequest, RecentSession } from './hooks/useOpenDesk'
import { ActiveSessionView } from './components/ActiveSessionView'
import { ConnectionCard, HomeDashboard } from './components/HomeDashboard'
import { devicePresence } from './services/device-presence'

export type Page = 'Home' | 'Connect' | 'Devices' | 'Active Session' | 'File Transfer' | 'Clipboard' | 'Settings' | 'Recent sessions' | 'Diagnostics'
type Notice = { kind: 'success' | 'info' | 'error'; message: string }

const nav: { label: Extract<Page, 'Home' | 'Connect' | 'Devices' | 'Active Session' | 'File Transfer' | 'Clipboard' | 'Settings'>; icon: typeof Home }[] = [
  { label: 'Home', icon: Home },
  { label: 'Connect', icon: Radio },
  { label: 'Devices', icon: Monitor },
  { label: 'Active Session', icon: MonitorCheck },
  { label: 'File Transfer', icon: ArrowLeftRight },
  { label: 'Clipboard', icon: Clipboard },
  { label: 'Settings', icon: Settings }
]

export default function App() {
  const openDesk = useOpenDesk()
  const [page, setPage] = useState<Page>('Home')
  const [remoteId, setRemoteId] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => localStorage.getItem('opendesk.theme') === 'light' ? 'light' : 'dark')
  const [incomingRequestsEnabled, setIncomingRequestsEnabled] = useState(() => localStorage.getItem('opendesk.incomingRequests.v1') !== 'false')
  const [windowMaximized, setWindowMaximized] = useState(false)
  const [requestFiles, setRequestFiles] = useState(false)
  const [requestClipboard, setRequestClipboard] = useState(false)
  const [requestInput, setRequestInput] = useState(false)
  const [requestAudio, setRequestAudio] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshingDevices, setRefreshingDevices] = useState(false)
  const [refreshingTrustedDevices, setRefreshingTrustedDevices] = useState(false)
  const [clock, setClock] = useState(() => Date.now())
  const wasInActiveSession = useRef(false)
  const rejectingRequestIds = useRef(new Set<string>())

  useEffect(() => { localStorage.setItem('opendesk.theme', theme) }, [theme])
  useEffect(() => { localStorage.setItem('opendesk.incomingRequests.v1', String(incomingRequestsEnabled)) }, [incomingRequestsEnabled])
  useEffect(() => {
    if ((page !== 'Devices' && page !== 'Home') || openDesk.activeSession) return
    setClock(Date.now())
    const timer = setInterval(() => setClock(Date.now()), 10_000)
    return () => clearInterval(timer)
  }, [page, openDesk.activeSession])
  useEffect(() => {
    if (openDesk.activeSession) {
      wasInActiveSession.current = true
      setPage('Active Session')
    } else if (wasInActiveSession.current) {
      wasInActiveSession.current = false
      setPage('Home')
    }
  }, [openDesk.activeSession])
  useEffect(() => {
    const unsubscribe = typeof window.openDesk.onWindowMaximizedChange === 'function'
      ? window.openDesk.onWindowMaximizedChange(setWindowMaximized)
      : undefined
    if (typeof window.openDesk.getWindowMaximized === 'function') {
      void window.openDesk.getWindowMaximized().then(setWindowMaximized).catch(() => undefined)
    }
    return typeof unsubscribe === 'function' ? unsubscribe : undefined
  }, [])
  useEffect(() => {
    const present = new Set(openDesk.incomingRequests.map(request => request.session.id))
    for (const id of rejectingRequestIds.current) if (!present.has(id)) rejectingRequestIds.current.delete(id)
    if (incomingRequestsEnabled) return
    for (const request of openDesk.incomingRequests) {
      const id = request.session.id
      if (rejectingRequestIds.current.has(id)) continue
      rejectingRequestIds.current.add(id)
      void openDesk.rejectSession(id).catch(error => {
        setNotice({ kind: 'error', message: error instanceof Error ? `Incoming request could not be rejected: ${error.message}` : 'Incoming request could not be rejected.' })
      })
    }
  }, [incomingRequestsEnabled, openDesk.incomingRequests, openDesk.rejectSession])

  const reportError = useCallback((message: string) => setNotice({ kind: 'error', message }), [])
  const finishSession = useCallback((id: string, reason?: string) => openDesk.finishSession(id, reason).catch(error => {
    reportError(error instanceof Error ? error.message : 'Could not notify the signaling server that the session ended.')
  }), [openDesk.finishSession, reportError])

  async function copyId() {
    if (!openDesk.device?.identityReady || !openDesk.device.deviceId) return
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
      if (requestInput) requested.push('input')
      if (requestAudio) requested.push('audio')
      await openDesk.requestSession(normalized, requested)
      setRemoteId(normalized)
      setPage('Active Session')
      setNotice({ kind: 'info', message: 'Session request sent. The remote user must approve access before any screen data is shared.' })
    } catch (error) {
      reportError(error instanceof Error ? error.message : 'Could not request a remote session.')
    } finally { setBusy(false) }
  }

  async function approve(request: IncomingSessionRequest, selected: SessionPermission[]) {
    if (openDesk.activeSession) {
      reportError('Disconnect the current session before approving another request.')
      return
    }
    setBusy(true)
    try {
      // The host selects each extra independently; main re-fetches and confirms the exact set natively.
      await openDesk.approveSession(request.session.id, ['view', ...selected])
      setPage('Active Session')
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

  async function refreshDevices() {
    if (refreshingDevices) return
    setRefreshingDevices(true)
    try {
      await Promise.all([openDesk.refreshKnownDevices(), openDesk.refreshTrustedDevices()])
      setNotice({ kind: 'success', message: 'Looked-up devices and trusted fingerprints refreshed.' })
    } catch (error) { reportError(error instanceof Error ? error.message : 'Could not refresh device information.') }
    finally { setRefreshingDevices(false) }
  }

  async function refreshTrustedDevices() {
    if (refreshingTrustedDevices) return
    setRefreshingTrustedDevices(true)
    try {
      await openDesk.refreshTrustedDevices()
      setNotice({ kind: 'success', message: 'Trusted-device list refreshed.' })
    } catch (error) { reportError(error instanceof Error ? error.message : 'Could not refresh trusted devices.') }
    finally { setRefreshingTrustedDevices(false) }
  }

  const remoteTargetPlatform = useMemo(() => {
    const normalized = normalizeDeviceId(remoteId)
    return openDesk.knownDevices.find(device => device.id === normalized)?.platform
  }, [remoteId, openDesk.knownDevices])

  const filteredDevices = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return openDesk.knownDevices
    return openDesk.knownDevices.filter(device => device.name.toLowerCase().includes(text) || device.id.toLowerCase().includes(text) || device.platform.toLowerCase().includes(text))
  }, [openDesk.knownDevices, query])
  const platform = openDesk.device ? (({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' } as Record<string, string>)[openDesk.device.platform] || openDesk.device.platform) : 'Detecting platform'
  const statusLabel = openDesk.serviceState === 'online' ? 'Signaling connected' : openDesk.serviceState === 'connecting' ? 'Connecting to signaling' : openDesk.serviceState === 'blocked' ? 'Identity needs attention' : openDesk.serviceState === 'unconfigured' ? 'Signaling not configured' : openDesk.serviceState === 'loading' ? 'Starting G1Viewer' : 'Signaling unavailable'
  const currentPage: Page = openDesk.activeSession ? 'Active Session' : page
  const headerStatus = openDesk.serviceState === 'online' && openDesk.device?.identityReady ? 'Ready' : statusLabel
  const connectionCardProps = {
    remoteId, setRemoteId, busy, requestFiles, setRequestFiles, requestClipboard, setRequestClipboard,
    requestInput, setRequestInput, requestAudio, setRequestAudio, remoteTargetPlatform,
    onConnect: connect, onError: reportError
  }

  async function minimizeWindow() {
    try {
      if (typeof window.openDesk.minimizeWindow !== 'function') throw new Error('Native window controls are unavailable in this runtime.')
      await window.openDesk.minimizeWindow()
    } catch (error) { reportError(error instanceof Error ? error.message : 'Could not minimize the G1Viewer window.') }
  }

  async function toggleWindowSize(options?: { altKey?: boolean }) {
    try {
      if (typeof window.openDesk.toggleWindowMaximize !== 'function') throw new Error('Native window controls are unavailable in this runtime.')
      setWindowMaximized(await window.openDesk.toggleWindowMaximize(options))
    } catch (error) { reportError(error instanceof Error ? error.message : 'Could not resize the G1Viewer window.') }
  }

  async function closeWindow() {
    try {
      if (typeof window.openDesk.closeWindow !== 'function') throw new Error('Native window controls are unavailable in this runtime.')
      await window.openDesk.closeWindow()
    } catch (error) { reportError(error instanceof Error ? error.message : 'Could not close the G1Viewer window.') }
  }

  async function openProjectPage() {
    try { await window.openDesk.openProjectPage() }
    catch (error) { reportError(error instanceof Error ? error.message : 'Could not open the G1Viewer project page.') }
  }

  const isVisualValidation = typeof document !== 'undefined' && document.documentElement.dataset.visualValidation === 'true'
  const osPlatform = openDesk.device?.platform || (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent) ? 'darwin' : typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent) ? 'win32' : 'linux')
  const isMac = !isVisualValidation && osPlatform === 'darwin'
  const isWin = !isVisualValidation && osPlatform === 'win32'

  return <div className={`app-shell desktop-surface theme-${theme} platform-${osPlatform}`}>
    <div className="application-window">
      <header className={`window-header header-${isMac ? 'mac' : isWin ? 'win' : 'default'}`} onDoubleClick={event => {
        if (!(event.target instanceof HTMLElement) || !event.target.closest('button')) void toggleWindowSize({ altKey: true })
      }}>
        {isMac && (
          <div className="mac-traffic-lights" aria-label="Window controls">
            <button className="mac-traffic-light mac-close" aria-label="Close window" title="Close" onClick={() => void closeWindow()}>
              <X size={8} strokeWidth={2.6}/>
            </button>
            <button className="mac-traffic-light mac-minimize" aria-label="Minimize window" title="Minimize" onClick={() => void minimizeWindow()}>
              <Minus size={8} strokeWidth={2.6}/>
            </button>
            <button
              className="mac-traffic-light mac-maximize"
              aria-label={windowMaximized ? 'Restore window' : 'Maximize window'}
              title={windowMaximized ? 'Exit Full Screen' : 'Enter Full Screen'}
              onClick={event => void toggleWindowSize({ altKey: event.altKey })}
            >
              {windowMaximized ? <Minus size={8} strokeWidth={2.6}/> : <Maximize2 size={7} strokeWidth={2.6}/>}
            </button>
          </div>
        )}

        <div className="window-brand">
          <button className="brand-home" aria-label="Open G1Viewer Home" onClick={() => setPage('Home')}>
            <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40" className="brand-glyph"><path d="M20 4.5c8.5 0 15.5 6.7 15.5 15.1S28.5 35.1 20 35.1 4.5 28.2 4.5 19.6 11.5 4.5 20 4.5Z" fill="none" stroke="currentColor" strokeWidth="2.3"/><path d="M12 14.5c3.7-5 10.6-5.3 14.4-1.5 3.4 3.4 2.7 8.1-.5 10.8l-7.2 6.1c-2.6 2.2-6.8 1.4-8-1.7-.8-2 .1-4.1 1.8-5.7l4.2-3.7" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/><path d="M22 11.4c5.2-.2 8.4 4.7 6.3 8.9-1.4 2.8-4.8 3.8-7.2 5.7" fill="none" stroke="#b9ddff" strokeWidth="2.5" strokeLinecap="round"/></svg></span>
            <span className="brand-name">G1Viewer</span>
          </button>
          <span className="brand-tagline">Free. Fast. Secure. Remote Access.</span>
        </div>

        <div className="window-actions">
          <button
            type="button"
            className={`window-status status-${openDesk.serviceState}`}
            disabled={!!openDesk.activeSession}
            onClick={() => setPage('Diagnostics')}
            aria-label={`System status: ${headerStatus}. Click to open Diagnostics.`}
            title={openDesk.serviceError ? `${openDesk.serviceError} — Click for diagnostics` : `${statusLabel} — Click for diagnostics`}
          >
            <i aria-hidden="true"/>{headerStatus}
          </button>
          <button className="window-settings" aria-label="Open Settings" title="Settings" onClick={() => setPage('Settings')}><Settings size={17}/></button>

          {!isMac && (
            <>
              <span className="window-control-divider" aria-hidden="true"/>
              <button className="window-control" aria-label="Minimize window" title="Minimize" onClick={() => void minimizeWindow()}><Minus size={17}/></button>
              <button className="window-control" aria-label={windowMaximized ? 'Restore window' : 'Maximize window'} title={windowMaximized ? 'Restore' : 'Maximize'} onClick={() => void toggleWindowSize()}>
                {windowMaximized ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}
              </button>
              <button className="window-control window-close" aria-label="Close window" title="Close" onClick={() => void closeWindow()}><X size={17}/></button>
            </>
          )}
        </div>
      </header>

      <div className="application-content">
        <aside className="sidebar">
          <div className="nav-label">WORKSPACE</div>
          <nav aria-label="Main navigation">{nav.map(({ label, icon: Icon }) => <button key={label}
            className={`nav-item${currentPage === label ? ' active' : ''}`} aria-current={currentPage === label ? 'page' : undefined}
            onClick={() => setPage(label)} disabled={!!openDesk.activeSession && label !== 'Active Session'}
            title={openDesk.activeSession && label !== 'Active Session' ? 'Disconnect the active session before changing views.' : undefined}>
            <Icon size={17}/><span>{label}</span>{label === 'Devices' && openDesk.incomingRequests.length > 0 && <b className="nav-badge">{openDesk.incomingRequests.length}</b>}
          </button>)}</nav>
          <div className="sidebar-spacer"/>
          <div className="sidebar-bottom">
            <section className="local-device-card" aria-label="Your device information">
              <div className="local-device-heading"><Monitor size={16}/><span>Your Device ID</span>
                <button className="sidebar-copy" aria-label="Copy local device ID" title="Copy device ID" onClick={() => void copyId()} disabled={!openDesk.device?.identityReady || !openDesk.device.deviceId}><Copy size={13}/></button>
              </div>
              <code className="sidebar-device-id">{openDesk.device?.identityReady && openDesk.device.deviceId ? openDesk.device.deviceId : 'Unavailable'}</code>
              <div className="sidebar-ready-status"><i className={openDesk.serviceState === 'online' && openDesk.device?.identityReady ? 'is-ready' : 'is-unavailable'}/>
                <span>{openDesk.serviceState === 'online' && openDesk.device?.identityReady ? 'Ready for connections' : statusLabel}</span>
              </div>
              <div className="sidebar-network-status"><Wifi size={14}/><span><strong>Local Network</strong><small>{openDesk.serviceState === 'online' ? 'Signaling connected · LAN not measured' : 'Status unavailable'}</small></span></div>
              <div className="sidebar-version">{openDesk.device?.appVersion ? `Version ${openDesk.device.appVersion}` : 'Version unavailable'}</div>
            </section>
          </div>
        </aside>

        <main className={`main workspace-main page-${page.toLowerCase().replaceAll(' ', '-')}`}>
          {notice && <div className={`notice notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}><span>{notice.kind === 'success' ? <Check size={15}/> : notice.kind === 'error' ? <X size={15}/> : <CircleHelp size={15}/>}</span><p>{notice.message}</p><button aria-label="Dismiss" onClick={() => setNotice(null)}><X size={14}/></button></div>}
          {incomingRequestsEnabled && openDesk.incomingRequests.length > 0 && <IncomingRequests requests={openDesk.incomingRequests} busy={busy} hasActiveSession={!!openDesk.activeSession} approve={approve} reject={reject} capabilities={openDesk.capabilities}/>}

          {openDesk.activeSession && openDesk.device && <>
            <Heading eyebrow="REMOTE SESSION" title="Active Session" description={openDesk.activeSession.session.status === 'pending' ? 'Awaiting remote approval. No screen or data is shared yet.' : 'Approved request. The host must select a display before capture; either user can disconnect at any time.'}/>
            <ActiveSessionView active={openDesk.activeSession} localDevice={openDesk.device} client={openDesk.signalingClient} signals={openDesk.signals} onState={openDesk.updateConnectionState} onFinish={finishSession} onError={reportError}/>
          </>}

          {!openDesk.activeSession && page === 'Home' && <HomeDashboard
            {...connectionCardProps}
            device={openDesk.device}
            localDevice={openDesk.localDevice}
            knownDevices={openDesk.knownDevices}
            recentSessions={openDesk.recentSessions}
            serviceState={openDesk.serviceState}
            serviceError={openDesk.serviceError}
            incomingRequestsEnabled={incomingRequestsEnabled}
            onToggleIncoming={setIncomingRequestsEnabled}
            onCopyId={copyId}
            onRename={openDesk.renameLocalDevice}
            onRenameRecent={openDesk.renameRecentDevice}
            onRemoveRecent={openDesk.removeRecentDevice}
            onNavigate={setPage}
            onOpenProject={() => void openProjectPage()}
            onError={reportError}
            onSuccess={message => setNotice({ kind: 'success', message })}
            now={clock}
          />}

          {!openDesk.activeSession && page === 'Connect' && <>
            <Heading eyebrow="REMOTE ACCESS" title="Connect to a Device" description="Enter a real G1Viewer Device ID to request a consent-based remote session."/>
            <ConnectionCard {...connectionCardProps} standalone/>
          </>}
      {!openDesk.activeSession && page === 'Devices' && <>
        <Heading title="Devices" eyebrow="DEVICE MANAGEMENT" description="Devices appear only after an actual ID lookup in this app run. Presence expires quickly; trust pins do not grant access." action={<div className="page-heading-actions"><button className="subtle" onClick={() => setPage('Recent sessions')}><Clock3 size={13}/> Recent sessions</button><button className="subtle" onClick={() => void refreshDevices()} disabled={refreshingDevices || openDesk.serviceState !== 'online'} title={openDesk.serviceState === 'online' ? undefined : 'Connect to the signaling server before refreshing.'}><RefreshCw size={13}/>{refreshingDevices ? 'Refreshing…' : 'Refresh'}</button></div>}/>
        <div className="search"><Search size={15}/><label className="sr-only" htmlFor="device-search">Search looked-up devices</label><input id="device-search" placeholder="Search looked-up devices" value={query} onChange={event => setQuery(event.target.value)}/></div>
        {filteredDevices.length > 0 ? <div className="device-list">{filteredDevices.map(device => {
          const presence = devicePresence(device, openDesk.serviceState === 'online', clock)
          return <article className="device-card" key={device.id}><div className="device-icon"><Monitor size={22}/></div><div className="device-main"><strong>{device.name}<em>{device.platform}</em></strong><small>{device.appVersion} · {device.checkedAt ? `Checked ${new Date(device.checkedAt).toLocaleString()}` : 'Lookup failed — retry to check presence'}</small><div className="id-row"><code>{device.id}</code></div></div><div className="device-actions"><span className={presence.fresh && device.online ? 'online-label' : 'offline-label'}><i/>{presence.label}</span><button className="subtle" onClick={() => void connect(device.id)} disabled={busy || openDesk.serviceState !== 'online'}>Request access <ArrowRight size={13}/></button></div></article>
        })}</div> : <EmptyInline icon={HardDrive} title={query ? 'No matching devices' : 'No looked-up devices yet'} description="Enter a device ID on Home to look it up. There is no simulated device discovery; trusted fingerprints are listed below."/>}
        <TrustedDevices devices={openDesk.trustedDevices} loadingError={openDesk.trustedDevicesError} forget={openDesk.forgetTrustedDevice} refresh={() => void refreshTrustedDevices()} refreshing={refreshingTrustedDevices} error={reportError} success={message => setNotice({ kind: 'success', message })}/>
      </>}

      {!openDesk.activeSession && page === 'Recent sessions' && <>
        <Heading eyebrow="SESSION HISTORY" title="Recent sessions" description="Local request/connection times and real outcomes. A request is not counted as a successful connection." action={<span className="history-count">{openDesk.recentSessions.length} in local history</span>}/>
        {openDesk.recentSessions.length > 0 ? <div className="history-list">{openDesk.recentSessions.map(session => <RecentSessionRow key={session.id} session={session}/>)}</div> : <EmptyState icon={Clock3} title="No recent sessions" description="Session requests appear here when they end. The history contains no screen, file, or clipboard content."/>}
      </>}

      {!openDesk.activeSession && page === 'File Transfer' && <>
        <Heading eyebrow="SECURE DATA CHANNEL" title="File Transfer" description="Transfers use encrypted WebRTC data channels, explicit destination selection, bounded chunks, and SHA-256 verification."/>
        <div className="feature-detail"><div><File size={24}/></div><h2>Connect and request file transfer</h2><p>Start a session from Home and request the file-transfer permission. The remote user chooses whether to grant it, and approves each received file separately. While a session is active, send files from the session panel.</p><button className="subtle" onClick={() => setPage('Connect')}>Go to connection <ArrowRight size={13}/></button></div>
      </>}

      {!openDesk.activeSession && page === 'Active Session' && <>
        <Heading eyebrow="LIVE REMOTE SESSION" title="Active Session" description="A session appears here only after a real request or an incoming approval. You can disconnect or stop sharing at any time."/>
        <EmptyState icon={Signal} title="No active session" description="Connect to a device or approve an incoming request to start an authorized session."/>
      </>}

      {!openDesk.activeSession && page === 'Clipboard' && <>
        <Heading eyebrow="ONE-TIME TEXT TRANSFER" title="Clipboard" description="G1Viewer does not continuously synchronize clipboard data. Text transfer is requested and confirmed separately for each active session."/>
        <div className="feature-detail"><div><Clipboard size={24}/></div><h2>Clipboard sharing is session-scoped</h2><p>Connect to a device and request clipboard permission. The remote user must approve it, and each clipboard send or receive requires local confirmation.</p><button className="subtle" onClick={() => setPage('Connect')}>Go to connection <ArrowRight size={13}/></button></div>
      </>}

      {!openDesk.activeSession && page === 'Diagnostics' && <>
        <Heading eyebrow="HEALTH & TROUBLESHOOTING" title="Diagnostics" description="Values below are read from local capabilities and live signaling state; unavailable measurements are not fabricated." action={<button className="subtle" onClick={() => void openDesk.refreshCapabilities().catch(error => reportError(error instanceof Error ? error.message : 'Could not refresh local capabilities.'))}><RefreshCw size={13}/> Refresh capabilities</button>}/>
        <div className="health-card"><Activity size={20}/><div><strong>{openDesk.serviceState === 'online' ? 'Signaling connection operational' : 'Signaling connection unavailable'}</strong><p>{openDesk.serviceError || `Configured server: ${openDesk.signalingUrl}`}</p></div><span className={openDesk.serviceState === 'online' ? 'good' : 'muted'}>● {statusLabel}</span></div>
        <div className="diag-list">
          <Diag label="Application version" detail={openDesk.device?.appVersion || 'Unavailable'} state={openDesk.device?.appVersion || 'Unavailable'} good={!!openDesk.device}/>
          <Diag label="Local device identity" detail={openDesk.device?.deviceId || (openDesk.device ? openDesk.device.identityMessage : 'Loading identity')} state={openDesk.device?.identityReady ? 'Secure key available' : openDesk.device ? 'Unavailable' : 'Loading'} good={!!openDesk.device?.identityReady}/>
          <Diag label="Credential storage" detail={openDesk.device?.secureStorageBackend || 'Unavailable'} state={openDesk.device?.identityReady ? 'Ready' : openDesk.device ? 'Needs attention' : 'Loading'} good={!!openDesk.device?.identityReady}/>
          <Diag label="Signaling service" detail={openDesk.signalingUrl || 'No server configured. Add one in Settings.'} state={statusLabel} good={openDesk.serviceState === 'online'}/>
          <Diag label="Screen capture" detail={openDesk.capabilities?.screenCapture || openDesk.capabilitiesError || 'Loading capability status'} state={openDesk.capabilities ? 'OS-dependent; requires consent' : 'Unavailable'} />
          <Diag label="WebRTC / ICE" detail="A session is needed to measure ICE connectivity. STUN/TURN endpoints come from the signaling service." state="No active peer connection"/>
          <Diag label="Remote input" detail={openDesk.capabilities?.remoteInput || openDesk.capabilitiesError || 'Loading capability status'} state={openDesk.capabilities ? openDesk.capabilities.remoteInputSupported ? 'Available per session' : 'Unavailable on this device' : 'Unavailable'} good={!!openDesk.capabilities?.remoteInputSupported}/>
          <Diag label="Remote audio" detail={openDesk.capabilities?.audioCapture || openDesk.capabilitiesError || 'Loading capability status'} state={openDesk.capabilities ? openDesk.capabilities.audioCaptureSupported ? 'Available per session' : 'Unavailable on this device' : 'Unavailable'} good={!!openDesk.capabilities?.audioCaptureSupported}/>
          <Diag label="Clipboard" detail={openDesk.capabilities?.clipboard || openDesk.capabilitiesError || 'Loading capability status'} state={openDesk.capabilities ? 'Per-session consent' : 'Unavailable'}/>
          <Diag label="File transfer" detail="Encrypted data-channel chunks, user-selected destination, and SHA-256 verification. Directory transfers and resume are not implemented." state="Requires session permission"/>
        </div>
        <div className="diag-actions"><button className="subtle" onClick={() => void copyDiagnostics(openDesk.device, openDesk.signalingUrl, openDesk.serviceState, openDesk.serviceError, openDesk.capabilities, openDesk.activeSession?.connectionState, reportError, setNotice)}><Copy size={13}/> Copy sanitized diagnostics</button><small>Includes no keys, credentials, clipboard contents, screen data, or file data.</small></div>
        <p className="diag-foot">Platform: {openDesk.device?.platform || 'Unavailable'} · Architecture: {openDesk.device?.architecture || 'Unavailable'}</p>
      </>}

      {!openDesk.activeSession && page === 'Settings' && <SettingsPage state={openDesk} theme={theme} setTheme={setTheme} error={reportError} success={message => setNotice({ kind: 'success', message })}/>}
      {page !== 'Home' && <footer><span>G1Viewer · {openDesk.device?.appVersion ? `v${openDesk.device.appVersion}` : 'Version unavailable'}</span><span><LockKeyhole size={12}/> Consent-first · Unattended access is not available</span></footer>}
        </main>
      </div>
    </div>
  </div>
}

function Heading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>
}

function Feature({ icon: Icon, title, text }: { icon: typeof ShieldCheck; title: string; text: string }) {
  return <article className="feature"><div><Icon size={18}/></div><strong>{title}</strong><p>{text}</p></article>
}

function IncomingRequests({ requests, busy, hasActiveSession, approve, reject, capabilities }: { requests: IncomingSessionRequest[]; busy: boolean; hasActiveSession: boolean; approve: (request: IncomingSessionRequest, selected: SessionPermission[]) => void; reject: (request: IncomingSessionRequest) => void; capabilities: DesktopCapabilities | null }) {
  return <section className="incoming-section"><div className="incoming-heading"><Bell size={16}/><strong>Incoming session requests</strong><span>{requests.length}</span></div>{requests.map(request => <IncomingRequest key={request.session.id} request={request} busy={busy} hasActiveSession={hasActiveSession} approve={approve} reject={reject} capabilities={capabilities}/>)}</section>
}

function IncomingRequest({ request, busy, hasActiveSession, approve, reject, capabilities }: { request: IncomingSessionRequest; busy: boolean; hasActiveSession: boolean; approve: (request: IncomingSessionRequest, selected: SessionPermission[]) => void; reject: (request: IncomingSessionRequest) => void; capabilities: DesktopCapabilities | null }) {
  const [selected, setSelected] = useState<SessionPermission[]>([])
  const extras = request.session.requestedPermissions.filter(permission => permission !== 'view')
  const limitation = (permission: SessionPermission): string | null => {
    if (permission === 'input' && !capabilities?.remoteInputSupported) return capabilities?.remoteInput || 'Local input capability is unavailable.'
    if (permission === 'audio' && !capabilities?.audioCaptureSupported) return capabilities?.audioCapture || 'Local audio capability is unavailable.'
    return null
  }
  return <article className="incoming-card"><div className="incoming-icon"><ShieldAlert size={19}/></div><div className="incoming-copy"><strong>{request.peer.name} wants to view this device</strong><small>{request.peer.id} · {request.peer.platform} · Only this device can approve.</small><div className="incoming-permissions"><LockKeyhole size={12}/> Requested: {request.session.requestedPermissions.map(permissionLabel).join(' · ')}</div><div className="permission-choices"><strong>Screen viewing (required to approve)</strong>{extras.map(permission => {
    const unavailable = limitation(permission)
    return <label key={permission} className="grant-extra"><input type="checkbox" checked={selected.includes(permission)} disabled={busy || !!unavailable} onChange={event => setSelected(current => event.target.checked ? [...current, permission] : current.filter(value => value !== permission))}/> Grant {permissionLabel(permission)}{unavailable ? <small>Unavailable: {unavailable}</small> : null}</label>
  })}</div><small className="fingerprint-note">Each extra is off by default. Verify a first-time fingerprint out of band. A native confirmation lists exactly what you grant; screen sharing requires a separate display choice. Remote control also requires a separate host action.</small></div><div className="incoming-actions"><button className="danger-outline" onClick={() => reject(request)} disabled={busy}>Reject</button><button className="primary" onClick={() => approve(request, selected)} disabled={busy || hasActiveSession}><Check size={14}/> Approve selected</button></div></article>
}

function EmptyInline({ icon: Icon, title, description }: { icon: typeof HardDrive; title: string; description: string }) {
  return <div className="empty-inline"><Icon size={22}/><strong>{title}</strong><span>{description}</span></div>
}

function EmptyState({ icon: Icon, title, description }: { icon: typeof Clock3; title: string; description: string }) {
  return <div className="empty-state"><div><Icon size={27}/></div><h2>{title}</h2><p>{description}</p></div>
}

function TrustedDevices({ devices, loadingError, forget, refresh, refreshing, error, success }: { devices: TrustedDevice[]; loadingError: string; forget: (id: string) => Promise<boolean>; refresh: () => void; refreshing: boolean; error: (message: string) => void; success: (message: string) => void }) {
  const [confirmForget, setConfirmForget] = useState<TrustedDevice | null>(null)
  return <section className="section trusted-section"><div className="section-head"><div><h2>Trusted device fingerprints</h2><p>Public-key pins are stored locally. A changed key blocks connection until you remove the old pin and verify the new fingerprint.</p></div><button className="subtle" onClick={refresh} disabled={refreshing}><RefreshCw size={13}/>{refreshing ? 'Refreshing…' : 'Refresh'}</button></div>{loadingError ? <div className="inline-warning"><ShieldAlert size={15}/><span>Unable to read local trust records: {loadingError}</span></div> : devices.length === 0 ? <div className="empty-inline compact"><ShieldCheck size={18}/><span>No device fingerprints are trusted yet. The first connection flow asks you to verify and trust one.</span></div> : <div className="trusted-list">{devices.map(device => <div className="trusted-row" key={device.id}><div className="trusted-icon"><LockKeyhole size={15}/></div><div><strong>{device.name}</strong><small>{device.id} · Trusted {new Date(device.trustedAt).toLocaleString()}</small><code>{device.fingerprint}</code></div><button className="subtle" onClick={() => setConfirmForget(device)}><Trash2 size={13}/> Forget</button></div>)}</div>}
  {confirmForget && <div className="dashboard-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setConfirmForget(null) }}>
    <section className="dashboard-modal" role="dialog" aria-modal="true" aria-labelledby="forget-trusted-title">
      <div className="dashboard-modal-heading">
        <div className="dashboard-icon"><ShieldAlert size={20}/></div>
        <div><h2 id="forget-trusted-title">Forget Trusted Fingerprint</h2><p>Security confirmation</p></div>
        <button className="icon-button" aria-label="Close dialog" onClick={() => setConfirmForget(null)}><X size={16}/></button>
      </div>
      <div className="dashboard-modal-content">
        <p>Remove trusted public key fingerprint for <strong>{confirmForget.name}</strong> (<code>{confirmForget.id}</code>)?</p>
        <small>Future connections to this device will require you to re-verify its cryptographic fingerprint.</small>
      </div>
      <div className="dashboard-modal-actions">
        <button className="subtle" onClick={() => setConfirmForget(null)}>Cancel</button>
        <button className="primary danger-btn" onClick={async () => {
          const target = confirmForget
          setConfirmForget(null)
          try {
            await forget(target.id)
            success(`Removed trusted fingerprint for “${target.name}”.`)
          } catch (reason) {
            error(reason instanceof Error ? reason.message : 'Could not remove device trust.')
          }
        }}>Confirm Forget</button>
      </div>
    </section>
  </div>}
  </section>
}

function RecentSessionRow({ session }: { session: RecentSession }) {
  return <article className="recent-row"><div className="recent-icon"><Monitor size={17}/></div><div className="recent-main"><strong>{session.role === 'viewer' ? 'Requested access to' : 'Received request from'} {session.peerName}</strong><small>{session.peerId} · Requested {new Date(session.requestedAt).toLocaleString()}{session.connectedAt ? ` · WebRTC connected ${new Date(session.connectedAt).toLocaleString()}` : ''}</small></div><span className={`recent-result ${session.result === 'Disconnected' ? 'result-good' : ''}`}>{session.result}</span><small className="recent-ended">Ended locally {new Date(session.endedAt).toLocaleTimeString()}{session.permissions.length ? ` · Approved: ${session.permissions.map(permissionLabel).join(', ')}` : ''}</small></article>
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
      success('Signaling server saved. G1Viewer is reconnecting to the new endpoint.')
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
      if (device.identityReady && device.deviceId) success(`Identity reset completed. This device now has a new ID: ${device.deviceId}. Share it with peers and verify the new fingerprint before reconnecting.`)
      else error('The old identity was revoked, but a new secure ID is unavailable. Unlock your OS credential store and restart before reconnecting.')
    } catch (reason) { error(reason instanceof Error ? reason.message : 'Could not revoke and reset the device identity.') }
  }

  return <>
    <Heading eyebrow="PREFERENCES & SECURITY" title="Settings" description="Settings that affect the real app are connected to the main process and signaling service."/>
    <div className="settings-card"><div className="settings-head"><h2>Appearance</h2><p>Local interface preference.</p></div><div className="setting"><div className="setting-icon"><Sun size={16}/></div><div className="setting-copy"><strong>Color theme</strong><small>Choose a dark or light interface.</small></div><div className="segmented"><button className={theme === 'dark' ? 'selected' : ''} onClick={() => setTheme('dark')}><Moon size={13}/> Dark</button><button className={theme === 'light' ? 'selected' : ''} onClick={() => setTheme('light')}><Sun size={13}/> Light</button></div></div></div>

    <div className="settings-card"><div className="settings-head"><h2>Signaling service</h2><p>Zero-configuration automatic discovery is enabled by default. Devices on the same Wi-Fi/LAN find each other automatically with no setup required. For connections across the Internet, you can optionally configure a custom HTTPS server.</p></div><form className="settings-form" onSubmit={event => void saveURL(event)}><label htmlFor="signal-url">Signaling server origin</label><div className="settings-form-row"><input id="signal-url" value={urlInput} onChange={event => setUrlInput(event.target.value)} placeholder="Automatic (LAN & Embedded Coordinator)" spellCheck={false}/><button className="primary" type="submit" disabled={savingURL}>{savingURL ? 'Saving…' : 'Save & reconnect'}</button>{urlInput && <button className="subtle" type="button" onClick={() => { setUrlInput(''); void state.setServerURL('').then(url => { setUrlInput(url); success('Reset to automatic zero-configuration signaling.') }) }}>Reset to auto</button>}</div><small>Current active endpoint: {state.signalingUrl || 'Automatic'}. Leave empty or reset to use automatic zero-configuration LAN discovery.</small></form></div>

    <div className="settings-card"><div className="settings-head"><h2>Device name</h2><p>Displayed to other users. Your device ID remains stable.</p></div><form className="settings-form" onSubmit={event => void saveName(event)}><label htmlFor="device-name">Display name</label><div className="settings-form-row"><input id="device-name" value={nameInput} onChange={event => setNameInput(event.target.value)} maxLength={80}/><button className="subtle" type="submit" disabled={savingName || !nameInput.trim() || state.serviceState !== 'online'} title={state.serviceState === 'online' ? undefined : 'Connect to the signaling server to rename this device.'}><Laptop size={13}/>{savingName ? 'Saving…' : 'Save name'}</button></div></form></div>

    <div className="settings-card"><div className="settings-head"><h2>Privacy and session capabilities</h2><p>These controls reflect implemented behavior; unsupported features are not presented as active switches.</p></div><div className="setting"><div className="setting-icon"><Clipboard size={16}/></div><div className="setting-copy"><strong>Clipboard</strong><small>Manual, one-time text transfer only; requires session permission and local confirmation for each action.</small></div><span className="setting-status">Per-session consent</span></div><div className="setting"><div className="setting-icon"><Monitor size={16}/></div><div className="setting-copy"><strong>Screen capture</strong><small>Only after approval and a separate local display selection.</small></div>{state.device?.platform === 'darwin' ? <button className="subtle" onClick={() => void window.openDesk.openScreenCaptureSettings().catch(reason => error(reason instanceof Error ? reason.message : 'Could not open macOS Screen Recording settings.'))}><ExternalLink size={13}/> macOS permissions</button> : <span className="setting-status">Configure in OS settings</span>}</div><div className="setting"><div className="setting-icon"><ShieldAlert size={16}/></div><div className="setting-copy"><strong>Unattended access</strong><small>Not implemented. No background access or silent persistence is enabled.</small></div><span className="setting-status unavailable">Unavailable</span></div></div>

    <div className="settings-card"><div className="settings-head"><h2>Local identity</h2><p>Private Ed25519 identity key is encrypted with the operating-system credential store. Linux basic_text storage is refused.</p></div><div className="setting"><div className="setting-icon"><LockKeyhole size={16}/></div><div className="setting-copy"><strong>{state.device ? state.device.deviceId || 'Device ID unavailable' : 'Generating secure device identity…'}</strong><small>{state.device?.secureStorageBackend || 'Credential backend unavailable'} · {state.device?.identityReady ? 'Identity key available' : state.device?.identityMessage || 'Checking identity'}</small></div><span className={state.device?.identityReady ? 'good' : 'muted'}>{state.device?.identityReady ? '● Ready' : state.device ? '● Blocked' : '● Loading'}</span></div><div className="setting"><div className="setting-copy"><strong>Revoke and reset identity</strong><small>Closes active sessions, revokes this public key on the signaling service, and creates a new ID. Peers must verify the new fingerprint.</small></div><button className="danger-outline" onClick={() => void revokeIdentity()} disabled={!state.device?.identityReady || !!state.activeSession}>Revoke & reset</button></div></div>

    <div className="warning"><LockKeyhole size={17}/><div><strong>Remote input and audio are limited.</strong><p>Keyboard and mouse control works only after the approved session starts sharing and the host enables it. It needs an X11 Linux session, Windows, or macOS with Accessibility access; Wayland is not supported. System audio is Windows-only. Unattended access is not available.</p></div></div>
  </>
}

async function copyDiagnostics(device: ReturnType<typeof useOpenDesk>['device'], signalingUrl: string, serviceState: string, serviceError: string, capabilities: ReturnType<typeof useOpenDesk>['capabilities'], connectionState: string | undefined, error: (message: string) => void, success: (notice: Notice) => void) {
  const sanitized = [
    'G1Viewer sanitized diagnostics',
    `Version: ${device?.appVersion || 'unknown'}`,
    `Platform: ${device?.platform || 'unknown'} ${device?.architecture || ''}`,
    `Identity ready: ${device ? device.identityReady ? 'yes' : 'no' : 'unavailable'}`,
    `Secure storage: ${device?.secureStorageBackend || 'unavailable'}`,
    `Signaling endpoint: ${signalingUrl || 'not configured'}`,
    `Signaling state: ${serviceState}`,
    `Signaling error: ${serviceError || 'none reported'}`,
    `WebRTC state: ${connectionState || 'no active peer connection'}`,
    `Screen capture: ${capabilities?.screenCapture || 'unknown'}`,
    `Remote input: ${capabilities?.remoteInput || 'unknown'}`,
    `Audio: ${capabilities?.audioCapture || 'unknown'}`
  ].join('\n')
  try { await window.openDesk.copyText(sanitized); success({ kind: 'success', message: 'Sanitized diagnostic summary copied. No tokens, private keys, clipboard content, screen data, or file content is included.' }) }
  catch (reason) { error(reason instanceof Error ? reason.message : 'Could not copy diagnostics.') }
}
