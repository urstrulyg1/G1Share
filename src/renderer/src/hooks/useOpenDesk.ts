import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceInfo, DeviceSummary, EventBatch, SessionPermission, SignalingEvent, RemoteSession, TrustedDevice, DesktopCapabilities } from '../../../shared/types'
import { SignalingClient } from '../services/signaling-client'
import type { ConnectionState } from '../services/remote-session'
import { loadRecentSessions, recentSessionFrom, RECENT_STORAGE_KEY } from '../services/session-history'
import type { RecentSession } from '../services/session-history'

export type ServiceState = 'loading' | 'unconfigured' | 'blocked' | 'connecting' | 'online' | 'offline'
export type { RecentSession } from '../services/session-history'

/** Peer metadata is kept only from actual signaling lookups in this running app. */
export interface KnownDevice extends DeviceSummary {
  checkedAt: string
}

export interface IncomingSessionRequest {
  session: RemoteSession
  peer: DeviceSummary
}

export interface ActiveSession {
  role: 'viewer' | 'host'
  session: RemoteSession
  peer: DeviceSummary
  connectionState: ConnectionState
  /** Set only when the WebRTC transport actually reaches 'connected'. */
  connectedAt?: string
}

interface UseOpenDeskState {
  device: DeviceInfo | null
  localDevice: DeviceSummary | null
  serviceState: ServiceState
  serviceError: string
  signalingUrl: string
  settingsLoaded: boolean
  capabilities: DesktopCapabilities | null
  capabilitiesError: string
  trustedDevices: TrustedDevice[]
  trustedDevicesError: string
  knownDevices: KnownDevice[]
  incomingRequests: IncomingSessionRequest[]
  activeSession: ActiveSession | null
  signals: SignalingEvent[]
  recentSessions: RecentSession[]
  cursor: number
}

function formatEventError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 240)
  return 'Signaling service is unavailable.'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export function useOpenDesk() {
  const [state, setState] = useState<UseOpenDeskState>(() => ({
    device: null,
    localDevice: null,
    serviceState: 'loading',
    serviceError: '',
    signalingUrl: '',
    settingsLoaded: false,
    capabilities: null,
    capabilitiesError: '',
    trustedDevices: [],
    trustedDevicesError: '',
    knownDevices: [],
    incomingRequests: [],
    activeSession: null,
    signals: [],
    recentSessions: loadRecentSessions(localStorage),
    cursor: 0
  }))
  const clientRef = useRef<SignalingClient | null>(null)
  const pendingSignalsRef = useRef(new Map<string, SignalingEvent[]>())
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    // Previous localStorage lists had no provenance or transport-connected timestamp. Do not
    // import them as if they were verified devices or successful sessions.
    try {
      localStorage.removeItem('opendesk.knownDevices.v1')
      localStorage.removeItem('opendesk.recentSessions.v1')
    } catch { /* Storage might be unavailable; these keys are never read. */ }
    let cancelled = false
    void window.openDesk.getDeviceInfo().then(device => {
      if (!cancelled) setState(current => ({ ...current, device, ...(!device.identityReady || !device.deviceId
        ? { serviceState: 'blocked' as const, serviceError: device.identityMessage } : {}) }))
    }).catch(error => {
      if (!cancelled) setState(current => ({ ...current, serviceState: 'blocked', serviceError: formatEventError(error) }))
    })
    void window.openDesk.getSignalingUrl().then(signalingUrl => {
      if (!cancelled) setState(current => ({ ...current, signalingUrl, settingsLoaded: true,
        ...(!signalingUrl && current.serviceState !== 'blocked' ? { serviceState: 'unconfigured' as const, serviceError: 'No signaling server configured. Add a self-hosted HTTPS origin in Settings to connect.' } : {}) }))
    }).catch(error => {
      if (!cancelled) setState(current => ({ ...current, settingsLoaded: true,
        ...(current.serviceState === 'blocked' ? {} : { serviceState: 'unconfigured' as const, serviceError: formatEventError(error) }) }))
    })
    void window.openDesk.getCapabilities().then(capabilities => {
      if (!cancelled) setState(current => ({ ...current, capabilities, capabilitiesError: '' }))
    }).catch(error => {
      if (!cancelled) setState(current => ({ ...current, capabilitiesError: formatEventError(error) }))
    })
    void window.openDesk.listTrustedDevices().then(trustedDevices => {
      if (!cancelled) setState(current => ({ ...current, trustedDevices, trustedDevicesError: '' }))
    }).catch(error => {
      if (!cancelled) setState(current => ({ ...current, trustedDevicesError: formatEventError(error) }))
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    try { localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(state.recentSessions)) }
    catch { /* In-memory history remains accurate even when browser storage is unavailable. */ }
  }, [state.recentSessions])

  const saveKnownDevice = useCallback((device: DeviceSummary) => {
    setState(current => ({ ...current, knownDevices: [
      { ...device, checkedAt: new Date().toISOString() },
      ...current.knownDevices.filter(item => item.id !== device.id)
    ].slice(0, 100) }))
  }, [])

  const addRecentSession = useCallback((active: ActiveSession, end: 'local' | 'closed' | 'rejected' | 'expired' | 'failed') => {
    const recent = recentSessionFrom(active, new Date().toISOString(), end)
    setState(current => current.recentSessions.some(item => item.id === recent.id) ? current
      : { ...current, recentSessions: [recent, ...current.recentSessions].slice(0, 50) })
  }, [])

  const processEvent = useCallback((event: SignalingEvent) => {
    if (event.type === 'session.request' && event.session && event.peer) {
      setState(current => {
        if (current.incomingRequests.some(request => request.session.id === event.session!.id)) return current
        return { ...current, incomingRequests: [{ session: event.session!, peer: event.peer! }, ...current.incomingRequests] }
      })
      return
    }
    if (event.type === 'session.accepted' && event.session && event.peer) {
      setState(current => {
        if (current.activeSession?.session.id !== event.session!.id || current.activeSession.role !== 'viewer') return current
        return { ...current, activeSession: { ...current.activeSession, session: event.session!, peer: event.peer! } }
      })
      return
    }
    if (event.type === 'signal' && event.sessionId && event.message) {
      if (stateRef.current.activeSession?.session.id !== event.sessionId) {
        let pending = pendingSignalsRef.current.get(event.sessionId)
        if (!pending) {
          if (pendingSignalsRef.current.size >= 20) {
            const oldest = pendingSignalsRef.current.keys().next().value
            if (oldest) pendingSignalsRef.current.delete(oldest)
          }
          pending = []
          pendingSignalsRef.current.set(event.sessionId, pending)
        }
        pending.push(event)
        if (pending.length > 40) pending.splice(0, pending.length - 40)
        return
      }
      setState(current => current.activeSession?.session.id === event.sessionId
        ? { ...current, signals: [...current.signals, event].slice(-40) }
        : current)
      return
    }
    if (event.type === 'session.rejected' || event.type === 'session.expired' || event.type === 'session.closed') {
      if (event.sessionId) pendingSignalsRef.current.delete(event.sessionId)
      setState(current => {
        const incomingRequests = current.incomingRequests.filter(request => request.session.id !== event.sessionId)
        const active = current.activeSession
        if (!active || active.session.id !== event.sessionId) return { ...current, incomingRequests }
        const end = event.type === 'session.rejected' ? 'rejected' : event.type === 'session.expired' ? 'expired' : 'closed'
        const recent = recentSessionFrom(active, new Date().toISOString(), end)
        const recentSessions = current.recentSessions.some(item => item.id === recent.id) ? current.recentSessions : [recent, ...current.recentSessions].slice(0, 50)
        return { ...current, incomingRequests, activeSession: null, signals: [], recentSessions }
      })
    }
  }, [])

  useEffect(() => {
    const device = state.device
    if (!state.settingsLoaded || !device) return
    if (!device.identityReady || !device.deviceId) {
      setState(current => ({ ...current, serviceState: 'blocked', serviceError: device.identityMessage }))
      return
    }
    if (!state.signalingUrl) {
      setState(current => ({ ...current, serviceState: 'unconfigured', serviceError: 'No signaling server configured. Add a self-hosted HTTPS origin in Settings to connect.' }))
      return
    }
    let stopped = false
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    const client = new SignalingClient(window.openDesk, device)
    clientRef.current = client
    setState(current => ({ ...current, serviceState: 'connecting', serviceError: '', cursor: 0 }))

    const run = async () => {
      while (!stopped) {
        try {
          const localDevice = await client.register()
          await client.heartbeat()
          if (stopped) return
          setState(current => ({ ...current, localDevice, serviceState: 'online', serviceError: '', cursor: 0 }))
          let heartbeatBusy = false
          heartbeatTimer = setInterval(() => {
            if (heartbeatBusy || stopped) return
            heartbeatBusy = true
            void client.heartbeat().then(() => {
              if (!stopped) setState(current => ({ ...current, serviceState: 'online', serviceError: '' }))
            }).catch(error => {
              if (!stopped) setState(current => ({ ...current, serviceState: 'offline', serviceError: formatEventError(error) }))
            }).finally(() => { heartbeatBusy = false })
          }, 20_000)
          let cursor = 0
          while (!stopped) {
            const batch: EventBatch = await client.pollEvents(cursor, 20)
            if (stopped) return
            cursor = Math.max(cursor, batch.cursor)
            setState(current => ({ ...current, cursor }))
            for (const event of batch.events) processEvent(event)
            setState(current => ({ ...current, serviceState: 'online', serviceError: batch.overflow
              ? 'Some signaling events expired before G1Viewer read them. Reconnect any pending request.' : '' }))
          }
        } catch (error) {
          if (stopped) return
          setState(current => ({ ...current, serviceState: 'offline', serviceError: formatEventError(error) }))
          await delay(3000)
        } finally {
          if (heartbeatTimer) clearInterval(heartbeatTimer)
          heartbeatTimer = null
        }
      }
    }
    void run()
    return () => {
      stopped = true
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (clientRef.current === client) clientRef.current = null
    }
  }, [state.device, state.settingsLoaded, state.signalingUrl, processEvent])

  const requestSession = useCallback(async (deviceId: string, extraPermissions: SessionPermission[]) => {
    const client = clientRef.current
    if (!client || stateRef.current.serviceState !== 'online') throw new Error('Unable to reach the signaling server. Check Settings and try again.')
    if (stateRef.current.activeSession) throw new Error('Disconnect the current session before starting another one.')
    setState(current => ({ ...current, serviceError: '' }))
    const peer = await client.lookupDevice(deviceId)
    saveKnownDevice(peer)
    if (!peer.online) throw new Error('That device is currently offline. Ask its user to open G1Viewer and check the signaling server URL.')
    const trusted = await window.openDesk.trustPeer({ id: peer.id, name: peer.name, publicKey: peer.publicKey })
    if (!trusted) throw new Error('Device identity was not trusted. No session request was sent.')
    const permissions = ['view', ...extraPermissions] as SessionPermission[]
    const result = await client.createSession(peer.id, permissions)
    const pendingSignals = pendingSignalsRef.current.get(result.session.id) || []
    pendingSignalsRef.current.delete(result.session.id)
    setState(current => ({
      ...current,
      activeSession: { role: 'viewer', session: result.session, peer: result.peer, connectionState: 'connecting' },
      signals: pendingSignals
    }))
    return result.session
  }, [saveKnownDevice])

  const approveSession = useCallback(async (sessionId: string, permissions: SessionPermission[]) => {
    const client = clientRef.current
    if (!client) throw new Error('G1Viewer is not connected to a signaling service.')
    const incoming = stateRef.current.incomingRequests.find(request => request.session.id === sessionId)
    if (!incoming) throw new Error('This session request is no longer available.')
    const trusted = await window.openDesk.trustPeer({ id: incoming.peer.id, name: incoming.peer.name, publicKey: incoming.peer.publicKey })
    if (!trusted) throw new Error('Device identity was not trusted. The incoming request was not approved.')
    saveKnownDevice(incoming.peer)
    const session = await client.decideSession(sessionId, true, permissions)
    const pendingSignals = pendingSignalsRef.current.get(sessionId) || []
    pendingSignalsRef.current.delete(sessionId)
    setState(current => ({
      ...current,
      incomingRequests: current.incomingRequests.filter(request => request.session.id !== sessionId),
      activeSession: { role: 'host', session, peer: incoming.peer, connectionState: 'connecting' },
      signals: pendingSignals
    }))
  }, [saveKnownDevice])

  const rejectSession = useCallback(async (sessionId: string) => {
    const client = clientRef.current
    if (!client) throw new Error('G1Viewer is not connected to a signaling service.')
    await client.decideSession(sessionId, false)
    setState(current => ({ ...current, incomingRequests: current.incomingRequests.filter(request => request.session.id !== sessionId) }))
  }, [])

  const updateConnectionState = useCallback((stateValue: ConnectionState) => {
    setState(current => current.activeSession ? { ...current, activeSession: {
      ...current.activeSession,
      connectionState: stateValue,
      ...(stateValue === 'connected' && !current.activeSession.connectedAt ? { connectedAt: new Date().toISOString() } : {})
    } } : current)
  }, [])

  const finishSession = useCallback(async (sessionId: string, reason?: string) => {
    const currentActive = stateRef.current.activeSession
    if (!currentActive || currentActive.session.id !== sessionId) return
    let closeError: unknown
    try {
      if (!clientRef.current) throw new Error('Signaling is offline.')
      await clientRef.current.closeSession(sessionId, reason || 'user disconnected')
    } catch (error) { closeError = error }
    // A transport may reach 'connected' while the close request is in flight.
    const latest = stateRef.current.activeSession?.session.id === sessionId ? stateRef.current.activeSession : currentActive
    addRecentSession(latest, reason === 'Connection failed' ? 'failed' : 'local')
    setState(current => current.activeSession?.session.id === sessionId ? { ...current, activeSession: null, signals: [] } : current)
    if (closeError) throw new Error(`Session closed locally, but the signaling server could not be notified: ${formatEventError(closeError)}`)
  }, [addRecentSession])

  const setServerURL = useCallback(async (url: string) => {
    if (stateRef.current.activeSession) throw new Error('Disconnect the active session before changing the signaling server.')
    const signalingUrl = await window.openDesk.setSignalingUrl(url)
    pendingSignalsRef.current.clear()
    setState(current => ({ ...current, signalingUrl, knownDevices: [], incomingRequests: [], localDevice: null,
      serviceState: current.device?.identityReady ? 'connecting' : 'blocked',
      serviceError: current.device?.identityReady ? '' : current.device?.identityMessage || 'Secure identity is unavailable. Unlock the OS credential store and restart.', cursor: 0 }))
    return signalingUrl
  }, [])

  const resetDeviceIdentity = useCallback(async () => {
    if (stateRef.current.activeSession) throw new Error('Disconnect the active session before revoking this device identity.')
    const device = await window.openDesk.resetDeviceIdentity()
    if (!device) return null
    clientRef.current = null
    pendingSignalsRef.current.clear()
    setState(current => ({
      ...current,
      device,
      localDevice: null,
      knownDevices: [],
      incomingRequests: [],
      activeSession: null,
      signals: [],
      serviceState: device.identityReady ? 'connecting' : 'blocked',
      serviceError: device.identityReady ? '' : device.identityMessage,
      cursor: 0
    }))
    return device
  }, [])

  const refreshCapabilities = useCallback(async () => {
    try {
      const capabilities = await window.openDesk.getCapabilities()
      setState(current => ({ ...current, capabilities, capabilitiesError: '' }))
    } catch (error) {
      setState(current => ({ ...current, capabilitiesError: formatEventError(error) }))
      throw error
    }
  }, [])

  const refreshTrustedDevices = useCallback(async () => {
    try {
      const trustedDevices = await window.openDesk.listTrustedDevices()
      setState(current => ({ ...current, trustedDevices, trustedDevicesError: '' }))
    } catch (error) {
      setState(current => ({ ...current, trustedDevicesError: formatEventError(error) }))
      throw error
    }
  }, [])

  const refreshKnownDevices = useCallback(async () => {
    const client = clientRef.current
    if (!client || stateRef.current.serviceState !== 'online') throw new Error('Unable to reach the signaling server. Check Settings before refreshing devices.')
    const ids = stateRef.current.knownDevices.map(device => device.id)
    const results = await Promise.allSettled(ids.map(id => client.lookupDevice(id)))
    if (clientRef.current !== client) return
    const checkedAt = new Date().toISOString()
    const found = new Map(results.flatMap(result => result.status === 'fulfilled' ? [[result.value.id, { ...result.value, checkedAt }] as const] : []))
    const failed = new Set(ids.filter((_, index) => results[index].status === 'rejected'))
    setState(current => ({ ...current, knownDevices: current.knownDevices.map(device => found.get(device.id)
      ?? (failed.has(device.id) ? { ...device, checkedAt: '' } : device)) }))
    if (failed.size) throw new Error('Some devices could not be checked. Their presence is unknown; verify the signaling server and device IDs.')
  }, [])

  const forgetTrustedDevice = useCallback(async (id: string) => {
    const forgotten = await window.openDesk.forgetTrustedDevice(id)
    if (forgotten) {
      const trustedDevices = await window.openDesk.listTrustedDevices()
      setState(current => ({ ...current, trustedDevices, trustedDevicesError: '', knownDevices: current.knownDevices.filter(device => device.id !== id) }))
    }
    return forgotten
  }, [])

  const renameLocalDevice = useCallback(async (name: string) => {
    if (stateRef.current.serviceState !== 'online') throw new Error('Connect to the signaling server before changing this device name.')
    const localDevice = await window.openDesk.renameLocalDevice(name)
    setState(current => ({ ...current, localDevice, device: current.device ? { ...current.device, deviceName: localDevice.name } : null }))
  }, [])

  const renameRecentDevice = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Enter a device name with at least one visible character.')
    setState(current => ({
      ...current,
      knownDevices: current.knownDevices.map(d => d.id === id ? { ...d, name: trimmed } : d),
      recentSessions: current.recentSessions.map(s => s.peerId === id ? { ...s, peerName: trimmed } : s)
    }))
  }, [])

  const removeRecentDevice = useCallback(async (id: string) => {
    setState(current => ({
      ...current,
      knownDevices: current.knownDevices.filter(d => d.id !== id),
      recentSessions: current.recentSessions.filter(s => s.peerId !== id)
    }))
  }, [])

  return {
    ...state,
    signalingClient: clientRef.current,
    requestSession,
    approveSession,
    rejectSession,
    finishSession,
    setServerURL,
    resetDeviceIdentity,
    refreshCapabilities,
    refreshTrustedDevices,
    refreshKnownDevices,
    forgetTrustedDevice,
    renameLocalDevice,
    renameRecentDevice,
    removeRecentDevice,
    updateConnectionState
  }
}

export const useG1Viewer = useOpenDesk
export type UseG1ViewerState = UseOpenDeskState
