import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Activity, ArrowLeftRight, ArrowRight, Check, Clock3, Copy, Github, Home, Laptop, LockKeyhole, Monitor, MonitorCheck, Moon, Radio, Search, Settings, ShieldCheck, Sparkles, Sun, Wifi, X, Clipboard, HardDrive, CircleHelp, RefreshCw } from 'lucide-react'
import type { DeviceInfo } from '../../shared/types'
import { isValidDeviceId, normalizeDeviceId } from '../../shared/device-id'

type Page = 'Home' | 'Devices' | 'Recent sessions' | 'File transfer' | 'Diagnostics' | 'Settings'
type Notice = { kind: 'success' | 'info' | 'error'; message: string }
const nav: { label: Page; icon: typeof Home }[] = [
  { label: 'Home', icon: Home }, { label: 'Devices', icon: Monitor }, { label: 'Recent sessions', icon: Clock3 },
  { label: 'File transfer', icon: ArrowLeftRight }, { label: 'Diagnostics', icon: Activity }, { label: 'Settings', icon: Settings }
]

export default function App() {
  const [page, setPage] = useState<Page>('Home')
  const [device, setDevice] = useState<DeviceInfo | null>(null)
  const [remoteId, setRemoteId] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [clipboardEnabled, setClipboardEnabled] = useState(false)
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  const [query, setQuery] = useState('')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    window.openDesk.getDeviceInfo().then(setDevice).catch(() => setNotice({ kind: 'error', message: 'Could not load local device identity.' }))
  }, [])

  async function copyId() {
    if (!device) return
    try { await window.openDesk.copyText(device.deviceId); setNotice({ kind: 'success', message: 'Device ID copied to clipboard.' }) }
    catch { setNotice({ kind: 'error', message: 'Could not copy the device ID.' }) }
  }
  function connect() {
    const id = normalizeDeviceId(remoteId)
    if (!isValidDeviceId(id)) { setNotice({ kind: 'error', message: 'Enter a device ID in the format XXXX-XXXX-XXXX.' }); return }
    if (device && id === device.deviceId) { setNotice({ kind: 'error', message: 'That is this device. Enter another computer ID.' }); return }
    setNotice({ kind: 'info', message: 'Remote sessions are not implemented yet. No connection was attempted; the signaling and remote-control engine are future milestones.' })
  }
  const platform = device ? (({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' } as Record<string, string>)[device.platform] || device.platform) : 'Detecting platform'

  return <div className={'app-shell theme-' + theme}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><ArrowLeftRight size={20}/></div><div><strong>OpenDesk</strong><small>REMOTE, WITHOUT LIMITS</small></div></div>
      <div className="nav-label">WORKSPACE</div>
      <nav>{nav.map(({label, icon: Icon}) => <button key={label} className={'nav-item ' + (page === label ? 'active' : '')} onClick={() => {setPage(label);setNotice(null)}}><Icon size={17}/><span>{label}</span>{label === 'File transfer' && <small>SOON</small>}</button>)}</nav>
      <div className="sidebar-bottom">
        <div className="free-card"><ShieldCheck size={19}/><strong>Free by design.</strong><p>No subscriptions. No artificial session limits. Your devices, your choice.</p><button onClick={() => setPage('Settings')}>Explore privacy <ArrowRight size={13}/></button></div>
        <button className="github-link" onClick={() => void window.openDesk.openProjectPage()}><Github size={16}/> Open-source project <ArrowRight size={13}/></button>
        <div className="profile"><div className="avatar">G</div><div><strong>Local device</strong><small>{platform}</small></div><span className="green-dot"/></div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="crumb">Workspace <span>/</span> <strong>{page}</strong></div><div className="top-actions"><span className="status-pill"><i/> App running locally</span><button className="icon-button" aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={16}/> : <Moon size={16}/>}</button><button className="icon-button" aria-label="Diagnostics" onClick={() => setPage('Diagnostics')}><CircleHelp size={16}/></button></div></header>
      {notice && <div className={'notice notice-' + notice.kind} role="status"><span>{notice.kind === 'success' ? <Check size={15}/> : notice.kind === 'error' ? <X size={15}/> : <CircleHelp size={15}/>}</span><p>{notice.message}</p><button aria-label="Dismiss" onClick={() => setNotice(null)}><X size={14}/></button></div>}
      {page === 'Home' && <>
        <section className="welcome"><div><div className="eyebrow"><Sparkles size={13}/> YOUR REMOTE WORKSPACE</div><h1>Good to see you.</h1><p>Connect to another computer, or get this device ready for remote support.</p></div><div className="orbit"><span><Monitor size={16}/></span><b><ArrowLeftRight size={28}/></b><i><Laptop size={15}/></i></div></section>
        <section className="connect-card"><div className="connect-title"><div className="section-icon"><Radio size={19}/></div><div><h2>Connect to a device</h2><p>Enter the ID of the computer you want to access.</p></div><span className="consent"><LockKeyhole size={12}/> Consent-first</span></div>
          <form onSubmit={e => {e.preventDefault();connect()}}><label className="sr-only" htmlFor="remote-id">Remote device ID</label><div className="input-wrap"><Monitor size={16}/><input id="remote-id" value={remoteId} maxLength={14} autoComplete="off" spellCheck={false} onChange={e => setRemoteId(e.target.value)} placeholder="Enter device ID · XXXX-XXXX-XXXX"/></div><button className="primary" type="submit">Connect <ArrowRight size={15}/></button></form>
          <div className="connect-foot"><span><LockKeyhole size={13}/> Remote connections are not enabled in this build.</span><button onClick={() => setPage('Diagnostics')}>View capabilities <ArrowRight size={13}/></button></div>
        </section>
        <section className="section"><div className="section-head"><div><h2>Your device</h2><p>This ID identifies your device; it is not an access password.</p></div><button className="subtle" onClick={() => void copyId()}><Copy size={13}/> Copy ID</button></div>
          <div className="device-card"><div className="device-icon"><MonitorCheck size={24}/></div><div className="device-main"><strong>{platform} device <em>THIS DEVICE</em></strong><small>{device ? device.platform + ' · ' + device.architecture : 'Creating local identity'}</small><div className="id-row"><code>{device?.deviceId || '••••-••••-••••'}</code><button aria-label="Copy device ID" onClick={() => void copyId()}><Copy size={13}/></button></div></div><div className="local-only"><span/> Local only<small>Identity stored on this computer</small></div></div>
        </section>
        <section className="section"><div className="section-head"><div><h2>Built for your peace of mind</h2><p>Useful remote access, without the usual friction.</p></div></div><div className="feature-grid"><Feature icon={ShieldCheck} title="Consent comes first" text="Attended access will require explicit approval on the remote device."/><Feature icon={Activity} title="No artificial limits" text="Designed without forced session timers or paid feature gates."/><Feature icon={Wifi} title="Connect your way" text="Direct connectivity and optional self-hosted relay are planned."/></div></section>
      </>}
      {page === 'Devices' && <><Heading title="Your devices" eyebrow="DEVICE MANAGEMENT" description="Manage trusted devices and connection preferences." action={<button className="subtle" disabled>Add device · Soon</button>}/><div className="search"><Search size={15}/><input placeholder="Search devices" value={query} onChange={e => setQuery(e.target.value)}/></div>{device && (!query || device.deviceId.toLowerCase().includes(query.toLowerCase()) || 'this device'.includes(query.toLowerCase())) && <div className="device-card"><div className="device-icon"><Monitor size={23}/></div><div className="device-main"><strong>This device <em>LOCAL</em></strong><small>{device.platform} · {device.architecture}</small><div className="id-row"><code>{device.deviceId}</code><button onClick={() => void copyId()} aria-label="Copy device ID"><Copy size={13}/></button></div></div></div>}<div className="empty-inline"><HardDrive size={22}/><strong>{query ? 'No matching devices' : 'No other devices yet'}</strong><span>Remote pairing will appear here when the connection service is implemented.</span></div></>}
      {page === 'Recent sessions' && <Empty title="Your sessions will live here" description="Connection history will appear after real remote sessions are implemented. No activity is fabricated." icon={Clock3}/>}
      {page === 'File transfer' && <Empty title="File transfer is on the roadmap" description="Secure, resumable transfers with integrity verification are planned. File transfer is not implemented in this build." icon={ArrowLeftRight}/>}
      {page === 'Diagnostics' && <><Heading eyebrow="HEALTH & TROUBLESHOOTING" title="Diagnostics" description="Local application status and capabilities available in this build." action={<button className="subtle" onClick={() => setRefresh(refresh + 1)}><RefreshCw size={13}/> Refresh</button>}/><div className="health-card"><Activity size={20}/><div><strong>Local application is running</strong><p>Desktop shell initialized. Remote networking has not started.</p></div><span className="good">● Operational</span></div><div className="diag-list"><Diag label="Local identity" detail={device?.deviceId || 'Loading'} state={device ? 'Available' : 'Loading'} good={!!device}/><Diag label="Isolated desktop bridge" detail="Narrow preload API" state="Available" good/><Diag label="Screen capture" detail="Native capture adapter not implemented" state="Unavailable"/><Diag label="Remote input" detail="OS-specific input adapter not implemented" state="Unavailable"/><Diag label="Signaling / NAT traversal" detail="No signaling server connected" state="Unavailable"/><Diag label="Relay transport" detail="TURN / relay integration not implemented" state="Unavailable"/><Diag label="File transfer" detail="Secure transfer subsystem not implemented" state="Planned"/></div><p className="diag-foot">Platform: {device?.platform || 'detecting'} · Architecture: {device?.architecture || 'detecting'} · Refresh count: {refresh}</p></>}
      {page === 'Settings' && <><Heading eyebrow="PREFERENCES" title="Settings" description="Control the local app experience. Session security controls will arrive with remote sessions."/><div className="settings-card"><div className="settings-head"><h2>Appearance</h2><p>Make OpenDesk comfortable to use.</p></div><div className="setting"><div className="setting-icon"><Sun size={16}/></div><div className="setting-copy"><strong>Color theme</strong><small>Choose the application appearance.</small></div><div className="segmented"><button className={theme === 'dark' ? 'selected' : ''} onClick={() => setTheme('dark')}><Moon size={13}/> Dark</button><button className={theme === 'light' ? 'selected' : ''} onClick={() => setTheme('light')}><Sun size={13}/> Light</button></div></div></div><div className="settings-card"><div className="settings-head"><h2>Privacy & permissions</h2><p>Future session features remain off until implemented.</p></div><Toggle icon={Clipboard} title="Clipboard synchronization" description="UI preference only; clipboard sync is not implemented." value={clipboardEnabled} change={setClipboardEnabled}/><Toggle icon={Laptop} title="Launch at login" description="UI preference only; OS startup integration is not implemented." value={launchAtLogin} change={setLaunchAtLogin}/></div><div className="warning"><LockKeyhole size={17}/><div><strong>These are local interface preferences.</strong><p>Switches currently affect the UI only. They do not enable background access or change OS settings.</p></div></div></>}
      <footer><span>OpenDesk · v{device?.appVersion || '0.1.0'}</span><span><LockKeyhole size={12}/> Privacy-first foundation · Remote control not yet enabled</span></footer>
    </main>
  </div>
}

function Heading({eyebrow,title,description,action}:{eyebrow:string;title:string;description:string;action?:ReactNode}) { return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div> }
function Feature({icon:Icon,title,text}:{icon:typeof ShieldCheck;title:string;text:string}) { return <article className="feature"><div><Icon size={18}/></div><strong>{title}</strong><p>{text}</p></article> }
function Empty({title,description,icon:Icon}:{title:string;description:string;icon:typeof Clock3}) { return <><Heading eyebrow="WORKSPACE" title={title} description={description}/><div className="empty-state"><div><Icon size={27}/></div><h2>Coming in a future milestone</h2><p>This screen is honest about what is and is not implemented. No placeholder data is shown as real activity.</p><span>Planned · Not yet available</span></div></> }
function Diag({label,detail,state,good=false}:{label:string;detail:string;state:string;good?:boolean}) { return <div className="diag-row"><div><strong>{label}</strong><small>{detail}</small></div><span className={good ? 'good' : 'muted'}>● {state}</span></div> }
function Toggle({icon:Icon,title,description,value,change}:{icon:typeof Clipboard;title:string;description:string;value:boolean;change:(v:boolean)=>void}) { return <div className="setting"><div className="setting-icon"><Icon size={16}/></div><div className="setting-copy"><strong>{title}</strong><small>{description}</small></div><button className={'toggle ' + (value ? 'on' : '')} role="switch" aria-checked={value} aria-label={title} onClick={() => change(!value)}><span/></button></div> }
