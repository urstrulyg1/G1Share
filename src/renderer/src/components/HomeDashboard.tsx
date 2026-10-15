import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Activity, ArrowRight, Check, ChevronRight, Clipboard, Copy, Ellipsis,
  HardDrive, Infinity as InfinityIcon, Laptop, LockKeyhole, Monitor, Pencil,
  Radio, Send, Server, ShieldCheck, Signal, Wifi, X, Zap
} from 'lucide-react'
import type { DeviceInfo, DeviceSummary } from '../../../shared/types'
import type { KnownDevice, RecentSession, ServiceState } from '../hooks/useOpenDesk'
import { devicePresence } from '../services/device-presence'

export type DashboardDestination = 'Home' | 'Connect' | 'Devices' | 'Active Session' | 'File Transfer' | 'Clipboard' | 'Settings' | 'Recent sessions' | 'Diagnostics'

export interface ConnectionCardProps {
  remoteId: string
  setRemoteId: (value: string) => void
  busy: boolean
  requestFiles: boolean
  setRequestFiles: (value: boolean) => void
  requestClipboard: boolean
  setRequestClipboard: (value: boolean) => void
  requestInput: boolean
  setRequestInput: (value: boolean) => void
  requestAudio: boolean
  setRequestAudio: (value: boolean) => void
  remoteTargetPlatform?: string
  onConnect: (deviceId?: string) => void | Promise<void>
  onError: (message: string) => void
  standalone?: boolean
}

export interface HomeDashboardProps extends ConnectionCardProps {
  onSuccess?: (message: string) => void
  device: DeviceInfo | null
  localDevice: DeviceSummary | null
  knownDevices: KnownDevice[]
  recentSessions: RecentSession[]
  serviceState: ServiceState
  serviceError: string
  incomingRequestsEnabled: boolean
  onToggleIncoming: (enabled: boolean) => void
  onCopyId: () => void | Promise<void>
  onRename: (name: string) => Promise<void>
  onNavigate: (destination: DashboardDestination) => void
  onOpenProject: () => void
  now: number
  onRenameRecent?: (id: string, name: string) => Promise<void> | void
  onRemoveRecent?: (id: string) => Promise<void> | void
}

interface RecentDeviceRowData {
  id?: string
  name: string
  subtitle: string
  platform: string
  online: boolean
  presenceLabel: string
}

export function ConnectionCard({
  remoteId, setRemoteId, busy, requestFiles, setRequestFiles,
  requestClipboard, setRequestClipboard, requestInput, setRequestInput,
  requestAudio, setRequestAudio, remoteTargetPlatform, onConnect, onError, standalone = false
}: ConnectionCardProps) {
  const [pasteBusy, setPasteBusy] = useState(false)

  async function pasteId() {
    if (pasteBusy) return
    setPasteBusy(true)
    try {
      const value = await window.openDesk.readText()
      if (!value.trim()) {
        onError('The clipboard is empty. Copy a device ID, then try Paste again.')
        return
      }
      setRemoteId(value.trim())
      document.getElementById('remote-id')?.focus()
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not read the clipboard. Check clipboard access and try again.')
    } finally {
      setPasteBusy(false)
    }
  }

  return <section className={`dashboard-panel connect-panel${standalone ? ' connect-panel-standalone' : ''}`} aria-labelledby="connect-card-heading">
    <div className="dashboard-panel-title">
      <div className="dashboard-icon"><Send size={20}/></div>
      <div><h2 id="connect-card-heading">Connect to a Device</h2><p>Enter the Device ID of the remote device.</p></div>
    </div>
    <form className="device-connect-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void onConnect() }}>
      <label className="sr-only" htmlFor="remote-id">Remote device ID</label>
      <div className="device-input-wrap">
        <Monitor size={16} aria-hidden="true"/>
        <input id="remote-id" value={remoteId} maxLength={35} autoComplete="off" spellCheck={false}
          onChange={event => setRemoteId(event.target.value)}
          placeholder="Enter Device ID (e.g. A1B2C3D4-E5F60718-192A3B4C-5D6E7F80)"/>
        <button className="paste-button" type="button" aria-label="Paste device ID from clipboard" title="Paste from clipboard" onClick={() => void pasteId()} disabled={pasteBusy}>
          {pasteBusy ? <span className="mini-spinner" aria-hidden="true"/> : <Clipboard size={16}/>}
        </button>
      </div>
      <button className="primary dashboard-connect-button" type="submit" aria-label="Connect to remote device" disabled={busy}>
        {busy ? 'Connecting…' : 'Connect'}{!busy && <ChevronRight size={18} aria-hidden="true"/>}
      </button>
    </form>
    <details className="dashboard-permission-details">
      <summary>Optional session permissions</summary>
      <div className="permission-request-row dashboard-permissions">
        <label><input type="checkbox" checked={requestFiles} onChange={event => setRequestFiles(event.target.checked)}/> File transfer</label>
        <label><input type="checkbox" checked={requestClipboard} onChange={event => setRequestClipboard(event.target.checked)}/> Clipboard</label>
        <label><input type="checkbox" checked={requestInput} onChange={event => setRequestInput(event.target.checked)}/> Keyboard &amp; mouse</label>
        <label><input type="checkbox" checked={requestAudio} disabled={remoteTargetPlatform !== undefined && remoteTargetPlatform !== 'win32'} onChange={event => setRequestAudio(event.target.checked)}/>
          Audio{remoteTargetPlatform !== undefined && remoteTargetPlatform !== 'win32' ? ' (Windows only)' : ''}</label>
      </div>
      <small>Each extra is requested separately and remains off unless selected.</small>
    </details>
  </section>
}

export function HomeDashboard(props: HomeDashboardProps) {
  const {
    device, localDevice, knownDevices, recentSessions, serviceState, serviceError,
    incomingRequestsEnabled, onToggleIncoming, onCopyId, onRename, onNavigate,
    onOpenProject, now, onRenameRecent, onRemoveRecent, ...connectionProps
  } = props
  const [aliasEditing, setAliasEditing] = useState(false)
  const [aliasDraft, setAliasDraft] = useState(localDevice?.name || device?.deviceName || '')
  const [aliasSaving, setAliasSaving] = useState(false)
  const [detailsDevice, setDetailsDevice] = useState<RecentDeviceRowData | null>(null)
  const [menuDevice, setMenuDevice] = useState<string | null>(null)
  const [renamingDevice, setRenamingDevice] = useState<RecentDeviceRowData | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmingRemoveDevice, setConfirmingRemoveDevice] = useState<RecentDeviceRowData | null>(null)

  useEffect(() => {
    if (!aliasEditing) setAliasDraft(localDevice?.name || device?.deviceName || '')
  }, [aliasEditing, device?.deviceName, localDevice?.name])
  useEffect(() => {
    if (!detailsDevice && !menuDevice && !renamingDevice && !confirmingRemoveDevice) return
    const closeOverlaysOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDetailsDevice(null)
        setMenuDevice(null)
        setRenamingDevice(null)
        setConfirmingRemoveDevice(null)
      }
    }
    const handleClickOutside = (event: MouseEvent) => {
      if (menuDevice && !(event.target as HTMLElement)?.closest('.device-menu-anchor')) {
        setMenuDevice(null)
      }
    }
    window.addEventListener('keydown', closeOverlaysOnEscape)
    window.addEventListener('mousedown', handleClickOutside)
    return () => {
      window.removeEventListener('keydown', closeOverlaysOnEscape)
      window.removeEventListener('mousedown', handleClickOutside)
    }
  }, [detailsDevice, menuDevice, renamingDevice, confirmingRemoveDevice])

  const deviceId = device?.identityReady && device.deviceId ? device.deviceId : null
  const recentRows = useMemo(() => getRecentDeviceRows(knownDevices, recentSessions, serviceState === 'online', now), [knownDevices, recentSessions, serviceState, now])
  const accessMessage = incomingAccessMessage(device, serviceState, incomingRequestsEnabled)
  const appVersion = device?.appVersion ? `Version ${device.appVersion}` : 'Version unavailable'

  async function saveAlias(event: FormEvent) {
    event.preventDefault()
    const value = aliasDraft.trim()
    if (!value) {
      props.onError('Enter an alias with at least one visible character.')
      return
    }
    setAliasSaving(true)
    try {
      await onRename(value)
      setAliasEditing(false)
      props.onSuccess?.(`Device alias saved as “${value}”.`)
    } catch (error) {
      props.onError(error instanceof Error ? error.message : 'Could not save the device alias.')
    } finally {
      setAliasSaving(false)
    }
  }

  async function copyRealDeviceId(id: string) {
    try {
      await window.openDesk.copyText(id)
      props.onSuccess?.('Device ID copied. It identifies a device but is not an access password.')
    } catch (error) {
      props.onError(error instanceof Error ? error.message : 'Could not copy the device ID.')
    }
  }

  return <div className="home-dashboard">
    <div className="home-dashboard-layout">
      <div className="dashboard-center-column">
        <section className="dashboard-hero" aria-label="Access your devices anywhere">
          <div className="hero-copy">
            <h1>Access Your Devices<br/>Anywhere</h1>
            <p>Fast. Secure. No Login. Completely Free.</p>
          </div>
        </section>
        <div className="dashboard-primary">
          <section className="dashboard-panel access-panel" aria-labelledby="access-card-heading">
            <div className="dashboard-panel-title">
              <div className="dashboard-icon"><Radio size={20}/></div>
              <div><h2 id="access-card-heading">Allow Remote Access</h2><p>Share your Device ID with someone you trust.</p></div>
            </div>
            <div className="device-id-display">
              <code title={deviceId || undefined}>{deviceId || (device ? 'Unavailable — unlock your OS credential store' : 'Generating secure device identity…')}</code>
              <button className="icon-button" aria-label="Copy device ID" onClick={() => void onCopyId()} disabled={!deviceId}><Copy size={17}/></button>
            </div>
            <button className="alias-action" type="button" onClick={() => { setAliasDraft(localDevice?.name || device?.deviceName || ''); setAliasEditing(value => !value) }}>
              <Pencil size={13}/>{aliasEditing ? 'Cancel alias edit' : 'Set Custom Alias (Optional)'}
            </button>
            {aliasEditing && <form className="alias-editor" onSubmit={event => void saveAlias(event)}>
              <label className="sr-only" htmlFor="device-alias">Device alias</label>
              <input id="device-alias" value={aliasDraft} maxLength={80} autoFocus placeholder="Enter a device alias" onChange={event => setAliasDraft(event.target.value)}/>
              <button className="primary alias-save" type="submit" disabled={aliasSaving || !aliasDraft.trim()}>{aliasSaving ? 'Saving…' : 'Save'}</button>
            </form>}
            <div className="access-state">
              <i className={serviceState === 'online' && incomingRequestsEnabled && deviceId ? 'state-dot-ready' : 'state-dot-waiting'} aria-hidden="true"/>
              <div className="access-state-copy"><strong>{accessMessage}</strong><small>{incomingRequestsEnabled ? 'Every session still requires your approval.' : 'Incoming session requests are being rejected.'}</small></div>
              <button type="button" role="switch" aria-checked={incomingRequestsEnabled} aria-label="Allow incoming session requests"
                className={`access-switch${incomingRequestsEnabled ? ' is-on' : ''}`} onClick={() => onToggleIncoming(!incomingRequestsEnabled)}>
                <span/>
              </button>
            </div>
            {serviceState !== 'online' && <p className="dashboard-note"><LockKeyhole size={13}/>{serviceError || 'Connect a signaling service before accepting incoming requests.'}</p>}
          </section>

          <ConnectionCard {...connectionProps}/>
        </div>
      </div>

      <aside className="dashboard-side">
        <section className="dashboard-panel recent-devices-panel" aria-labelledby="recent-devices-heading">
          <div className="dashboard-section-heading">
            <h2 id="recent-devices-heading">Recent Devices</h2>
            <button className="text-action" onClick={() => onNavigate('Devices')}>See All <ArrowRight size={13}/></button>
          </div>
          {recentRows.length === 0 ? (
            <div className="empty-inline recent-empty">
              <Laptop size={24}/>
              <strong>No recent devices</strong>
              <span>Devices you connect to or look up will appear here for fast access.</span>
            </div>
          ) : (
            <div className="dashboard-device-list">
              {recentRows.slice(0, 5).map(row => <div className="dashboard-device-row" key={row.id || row.name}>
                <button className="recent-device-main" type="button" onClick={() => row.id ? void props.onConnect(row.id) : setDetailsDevice(row)}
                  disabled={!row.id || props.busy} aria-label={`Connect to ${row.name}`}>
                  <span className={`device-status-indicator${row.online ? ' is-online' : ''}`} aria-hidden="true"/>
                  <span className="dashboard-device-icon">{deviceIcon(row.platform)}</span>
                  <span className="dashboard-device-copy"><strong>{row.name}</strong><small>{row.subtitle}</small></span>
                </button>
                <div className="device-menu-anchor">
                  <button className="device-menu-trigger" type="button" aria-label={`More actions for ${row.name}`} aria-haspopup="menu" aria-expanded={menuDevice === (row.id || row.name)}
                    onClick={() => setMenuDevice(current => current === (row.id || row.name) ? null : (row.id || row.name))}>
                    <Ellipsis size={17}/>
                  </button>
                  {menuDevice === (row.id || row.name) && <div className="device-context-menu" role="menu">
                    <button role="menuitem" onClick={() => { setMenuDevice(null); setDetailsDevice(row) }}>View details</button>
                    <button role="menuitem" disabled={!row.id || props.busy} onClick={() => { setMenuDevice(null); if (row.id) void props.onConnect(row.id) }}>Connect</button>
                    {row.id && <button role="menuitem" onClick={() => { setMenuDevice(null); void copyRealDeviceId(row.id!) }}>Copy Device ID</button>}
                    {row.id && onRenameRecent && <button role="menuitem" onClick={() => { setMenuDevice(null); setRenamingDevice(row); setRenameDraft(row.name) }}>Rename</button>}
                    {row.id && onRemoveRecent && <button role="menuitem" className="danger-item" onClick={() => { setMenuDevice(null); setConfirmingRemoveDevice(row) }}>Remove</button>}
                  </div>}
                </div>
              </div>)}
            </div>
          )}
        </section>

        <section className="dashboard-panel network-panel" aria-labelledby="network-quality-heading">
          <div className="network-heading-row">
            <div className="network-heading-icon"><Signal size={18}/></div>
            <h2 id="network-quality-heading">Network Quality</h2>
            <span className="quality-unavailable">Unavailable</span>
          </div>
          <div className="network-route-status">
            <span className="network-state-dot" aria-hidden="true"/>
            <div><strong>Connection type unavailable</strong><small>No active WebRTC session to measure</small></div>
          </div>
          <div className="network-metrics" aria-label="Network metrics are unavailable">
            <Metric label="Latency" value="—"/>
            <Metric label="Download" value="—"/>
            <Metric label="Upload" value="—"/>
          </div>
          <button className="network-details-link" type="button" onClick={() => onNavigate('Diagnostics')}>Network details <ChevronRight size={14}/></button>
        </section>
      </aside>

      <section className="dashboard-benefits" aria-label="OpenDesk features">
        <FeatureCard icon={<Zap size={21}/>} iconClass="benefit-speed" title="Ultra Fast" description="Optimized for low latency and smooth performance." onClick={() => onNavigate('Diagnostics')} ariaLabel="Open performance details"/>
        <FeatureCard icon={<ShieldCheck size={21}/>} iconClass="benefit-secure" title="Secure" description="End-to-end encrypted peer-to-peer connection." onClick={() => onNavigate('Settings')} ariaLabel="Open security information"/>
        <FeatureCard icon={<Laptop size={21}/>} iconClass="benefit-platform" title="Cross Platform" description="Windows, macOS, Linux and more." onClick={() => onNavigate('Diagnostics')} ariaLabel="Open supported platform information"/>
        <FeatureCard icon={<InfinityIcon size={22}/>} iconClass="benefit-free" title="Completely Free" description="No login. No subscription. Open source." onClick={onOpenProject} ariaLabel="Open the OpenDesk source project"/>
      </section>
    </div>

    {detailsDevice && <div className="dashboard-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDetailsDevice(null) }}>
      <section className="dashboard-modal" role="dialog" aria-modal="true" aria-labelledby="device-details-title">
        <div className="dashboard-modal-heading"><div className="dashboard-icon">{deviceIcon(detailsDevice.platform)}</div><div><h2 id="device-details-title">{detailsDevice.name}</h2><p>Device information from this app run</p></div>
          <button className="icon-button" aria-label="Close device details" onClick={() => setDetailsDevice(null)}><X size={16}/></button></div>
        <div className="dashboard-modal-content">
          <p>{detailsDevice.subtitle}</p>
          {detailsDevice.id && <div className="modal-device-id"><small>Device ID</small><code>{detailsDevice.id}</code><button className="subtle" onClick={() => void copyRealDeviceId(detailsDevice.id!)}><Copy size={13}/> Copy ID</button></div>}
          <div className="modal-device-status"><span className={`device-status-indicator${detailsDevice.online ? ' is-online' : ''}`}/>{detailsDevice.presenceLabel}</div>
        </div>
        <div className="dashboard-modal-actions">
          {detailsDevice.id && onRenameRecent && <button className="subtle" onClick={() => { const target = detailsDevice; setDetailsDevice(null); setRenamingDevice(target); setRenameDraft(target.name) }}>Rename</button>}
          {detailsDevice.id && onRemoveRecent && <button className="subtle danger-text" onClick={() => { const target = detailsDevice; setDetailsDevice(null); setConfirmingRemoveDevice(target) }}>Remove</button>}
          <button className="subtle" onClick={() => setDetailsDevice(null)}>Close</button>
          {detailsDevice.id ? <button className="primary" disabled={props.busy} onClick={() => { const id = detailsDevice.id; setDetailsDevice(null); void props.onConnect(id) }}>Connect <ChevronRight size={15}/></button> : null}
        </div>
      </section>
    </div>}

    {renamingDevice && <div className="dashboard-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setRenamingDevice(null) }}>
      <section className="dashboard-modal" role="dialog" aria-modal="true" aria-labelledby="rename-device-title">
        <div className="dashboard-modal-heading">
          <div className="dashboard-icon"><Pencil size={20}/></div>
          <div><h2 id="rename-device-title">Rename Device</h2><p>Set a custom local display name for this device.</p></div>
          <button className="icon-button" aria-label="Close rename dialog" onClick={() => setRenamingDevice(null)}><X size={16}/></button>
        </div>
        <form onSubmit={async event => {
          event.preventDefault()
          const trimmed = renameDraft.trim()
          if (!trimmed) {
            props.onError('Enter a device name with at least one visible character.')
            return
          }
          try {
            await onRenameRecent?.(renamingDevice.id!, trimmed)
            setRenamingDevice(null)
            props.onSuccess?.(`Device renamed to “${trimmed}”.`)
          } catch (err) {
            props.onError(err instanceof Error ? err.message : 'Could not rename device.')
          }
        }}>
          <div className="dashboard-modal-content">
            <label htmlFor="rename-device-input" className="sr-only">New device name</label>
            <input id="rename-device-input" autoFocus value={renameDraft} maxLength={80} onChange={event => setRenameDraft(event.target.value)} placeholder="Enter device name" className="modal-input"/>
          </div>
          <div className="dashboard-modal-actions">
            <button type="button" className="subtle" onClick={() => setRenamingDevice(null)}>Cancel</button>
            <button type="submit" className="primary" disabled={!renameDraft.trim()}>Save name</button>
          </div>
        </form>
      </section>
    </div>}

    {confirmingRemoveDevice && <div className="dashboard-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setConfirmingRemoveDevice(null) }}>
      <section className="dashboard-modal" role="dialog" aria-modal="true" aria-labelledby="remove-device-title">
        <div className="dashboard-modal-heading">
          <div className="dashboard-icon"><Laptop size={20}/></div>
          <div><h2 id="remove-device-title">Remove Recent Device</h2><p>Confirm removing this device from your recent list.</p></div>
          <button className="icon-button" aria-label="Close remove dialog" onClick={() => setConfirmingRemoveDevice(null)}><X size={16}/></button>
        </div>
        <div className="dashboard-modal-content">
          <p>Are you sure you want to remove <strong>{confirmingRemoveDevice.name}</strong> from your recent devices? This will not remove any trusted cryptographic fingerprints.</p>
        </div>
        <div className="dashboard-modal-actions">
          <button className="subtle" onClick={() => setConfirmingRemoveDevice(null)}>Cancel</button>
          <button className="primary danger-btn" onClick={async () => {
            const target = confirmingRemoveDevice
            try {
              await onRemoveRecent?.(target.id!)
              setConfirmingRemoveDevice(null)
              props.onSuccess?.(`Removed “${target.name}” from recent devices.`)
            } catch (err) {
              props.onError(err instanceof Error ? err.message : 'Could not remove device.')
            }
          }}>Remove device</button>
        </div>
      </section>
    </div>}
  </div>
}

function FeatureCard({ icon, iconClass, title, description, onClick, ariaLabel }: { icon: ReactNode; iconClass: string; title: string; description: string; onClick: () => void; ariaLabel: string }) {
  return <button className="benefit-card clickable-tile" type="button" onClick={onClick} aria-label={ariaLabel}>
    <span className={`benefit-icon ${iconClass}`}>{icon}</span>
    <span className="benefit-copy"><strong>{title}</strong><small>{description}</small></span>
  </button>
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="network-metric"><strong>{value}</strong><small>{label}</small></div>
}

function DeviceMenuRow({ row, serviceOnline, now }: { row: KnownDevice; serviceOnline: boolean; now: number }): RecentDeviceRowData {
  const presence = devicePresence(row, serviceOnline, now)
  return { id: row.id, name: row.name, subtitle: `Last checked ${relativeTime(row.checkedAt, now)} · ${presence.label}`, platform: row.platform, online: presence.fresh && row.online, presenceLabel: presence.label }
}

function getRecentDeviceRows(devices: KnownDevice[], sessions: RecentSession[], serviceOnline: boolean, now: number): RecentDeviceRowData[] {
  const deviceById = new Map(devices.map(device => [device.id, device]))
  const unique = new Map<string, RecentDeviceRowData>()
  for (const session of [...sessions].filter(item => item.connectedAt).sort((a, b) => Date.parse(b.connectedAt!) - Date.parse(a.connectedAt!))) {
    if (unique.has(session.peerId)) continue
    const known = deviceById.get(session.peerId)
    const presence = known ? devicePresence(known, serviceOnline, now) : null
    unique.set(session.peerId, {
      id: session.peerId,
      name: known?.name || session.peerName,
      subtitle: `Last connected ${relativeTime(session.connectedAt!, now)}`,
      platform: known?.platform || 'unknown',
      online: !!presence?.fresh && !!known?.online,
      presenceLabel: presence?.label || 'Status unknown — refresh in Devices'
    })
  }
  for (const device of devices) {
    if (unique.has(device.id)) continue
    unique.set(device.id, DeviceMenuRow({ row: device, serviceOnline, now }))
  }
  return [...unique.values()].slice(0, 5)
}

function relativeTime(timestamp: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(timestamp))
  if (!Number.isFinite(elapsed)) return 'time unavailable'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`
  const weeks = Math.floor(days / 7)
  return `${weeks} week${weeks === 1 ? '' : 's'} ago`
}

function incomingAccessMessage(device: DeviceInfo | null, state: ServiceState, enabled: boolean): string {
  if (!enabled) return 'Incoming requests paused'
  if (!device?.identityReady || !device.deviceId) return 'Secure device identity unavailable'
  if (state === 'online') return 'Ready for incoming connections'
  if (state === 'connecting' || state === 'loading') return 'Connecting to signaling service'
  if (state === 'unconfigured') return 'Signaling service not configured'
  return 'Signaling service unavailable'
}

function deviceIcon(platform: string) {
  const normalized = platform.toLowerCase()
  if (normalized.includes('mac') || normalized === 'darwin') return <Laptop size={18}/> // Platform comes from a real lookup; no faux Apple identity is implied.
  if (normalized.includes('server') || normalized.includes('linux')) return <Server size={18}/>
  if (normalized.includes('windows') || normalized.includes('win32')) return <Monitor size={18}/>
  return <HardDrive size={18}/>
}
