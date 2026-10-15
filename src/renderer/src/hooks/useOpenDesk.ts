import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceInfo, DeviceSummary, EventBatch, SessionPermission, SignalingEvent, RemoteSession, TrustedDevice, DesktopCapabilities } from '../../../shared/types'
import { SignalingClient } from '../services/signaling-client'
import type { ConnectionState } from '../services/remote-session'

export type ServiceState = 'loading' | 'blocked' | 'connecting' | 'online' | 'offline'

export interface IncomingSessionRequest {
  session: RemoteSession
  peer: DeviceSummary
}

export interface ActiveSession {
  role: 'viewer' | 'host'
  session: RemoteSession
  peer: DeviceSummary
  connectionState: ConnectionState
  reason?: string
}

export interface RecentSession {
  id: string
  peerId: string
  peerName: string
  role: 'viewer' | 'host'
  result: string
  startedAt: string
  endedAt: string
  /** Permissions approved for the session. Absent on records saved before this field existed. */
  permissions?: SessionPermission[]
}

interface UseOpenDeskState {
  device: DeviceInfo | null
  localDevice: DeviceSummary | null
  serviceState: ServiceState
  serviceError: string
  signalingUrl: string
  settingsLoaded: boolean
  capabilities: DesktopCapabilities | null
  trustedDevices: TrustedDevice[]
  knownDevices: DeviceSummary[]
  incomingRequests: IncomingSessionRequest[]
  activeSession: ActiveSession | null
  signals: SignalingEvent[]
  recentSessions: RecentSession[]
  cursor: number
}

const RECENT_STORAGE_KEY = 'opendesk.recentSessions.v1'
const KNOWN_STORAGE_KEY = 'opendesk.knownDevices.v1'

function loadRecentSessions(): RecentSession[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is RecentSession => !!item && typeof item === 'object' && typeof item.id === 'string' && typeof item.peerId === 'string' && typeof item.peerName === 'string' && (item.role === 'viewer' || item.role === 'host') && typeof item.result === 'string' && typeof item.startedAt === 'string' && typeof item.endedAt === 'string').slice(0, 50)
  } catch {
    return []
  }
}

function loadKnownDevices(): DeviceSummary[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KNOWN_STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is DeviceSummary => !!item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.publicKey === 'string' && typeof item.platform === 'string' && typeof item.appVersion === 'string' && typeof item.online === 'boolean').slice(0, 100)
  } catch {
    return []
  }
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
    signalingUrl: 'http://127.0.0.1:8787',
    settingsLoaded: false,
    capabilities: null,
    trustedDevices: [],
    knownDevices: loadKnownDevices(),
    incomingRequests: [],
    activeSession: null,
    signals: [],
    recentSessions: loadRecentSessions(),
    cursor: 0
  }))
  const clientRef = useRef<SignalingClient | null>(null)
  const pendingSignalsRef = useRef(new Map<string, SignalingEvent[]>())
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.openDesk.getDeviceInfo(),
      window.openDesk.getSignalingUrl(),
      window.openDesk.getCapabilities(),
      window.openDesk.listTrustedDevices()
    ]).then(([device, signalingUrl, capabilities, trustedDevices]) => {
      if (cancelled) return
      setState(current => ({ ...current, device, signalingUrl, settingsLoaded: true, capabilities, trustedDevices }))
      if (!device.identityReady) setState(current => ({ ...current, serviceState: 'blocked', serviceError: device.identityMessage }))
    }).catch(error => {
      if (cancelled) return
      setState(current => ({ ...current, settingsLoaded: true, serviceState: 'blocked', serviceError: formatEventError(error) }))
    })
    return () => { cancelled = true }
  }, [])

  const saveKnownDevice = useCallback((device: DeviceSummary) => {
    setState(current => {
      const knownDevices = [device, ...current.knownDevices.filter(item => item.id !== device.id)].slice(0, 100)
      localStorage.setItem(KNOWN_STORAGE_KEY, JSON.stringify(knownDevices))
      return { ...current, knownDevices }
    })
  }, [])

  const addRecentSession = useCallback((active: ActiveSession, result: string) => {
    const now = new Date().toISOString()
    const recent: RecentSession = {
      id: active.session.id,
      peerId: active.peer.id,
      peerName: active.peer.name,
      role: active.role,
      result,
      startedAt: active.session.createdAt,
      endedAt: now,
      permissions: [...(active.session.permissions ?? [])]
    }
    setState(current => {
      if (current.recentSessions.some(item => item.id === recent.id)) return current
      const recentSessions = [recent, ...current.recentSessions].slice(0, 50)
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recentSessions))
      return { ...current, recentSessions }
    })
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
        const result = event.type === 'session.rejected' ? 'Rejected' : event.type === 'session.expired' ? 'Expired' : 'Disconnected'
        const recent: RecentSession = {
          id: active.session.id,
          peerId: active.peer.id,
          peerName: active.peer.name,
          role: active.role,
          result,
          startedAt: active.session.createdAt,
          endedAt: new Date().toISOString(),
          permissions: [...(active.session.permissions ?? [])]
        }
        const recentSessions = current.recentSessions.some(item => item.id === recent.id) ? current.recentSessions : [recent, ...current.recentSessions].slice(0, 50)
        localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recentSessions))
        return { ...current, incomingRequests, activeSession: null, signals: [], recentSessions }
      })
    }
  }, [])

  useEffect(() => {
    const device = state.device
    if (!state.settingsLoaded || !device) return
    if (!device.identityReady) {
      setState(current => ({ ...current, serviceState: 'blocked', serviceError: device.identityMessage }))
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
          saveKnownDevice(localDevice)
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
            if (batch.overflow) setState(current => ({ ...current, serviceError: 'Some old signaling events expired before this app read them. Reconnect any pending session request.' }))
            cursor = Math.max(cursor, batch.cursor)
            setState(current => ({ ...current, cursor }))
            for (const event of batch.events) processEvent(event)
            setState(current => ({ ...current, serviceState: 'online', serviceError: '' }))
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
  }, [state.device, state.settingsLoaded, state.signalingUrl, processEvent, saveKnownDevice])

  const requestSession = useCallback(async (deviceId: string, extraPermissions: SessionPermission[]) => {
    const client = clientRef.current
    if (!client) throw new Error('OpenDesk is not connected to a signaling service.')
    if (stateRef.current.activeSession) throw new Error('Disconnect the current session before starting another one.')
    setState(current => ({ ...current, serviceError: '' }))
    const peer = await client.lookupDevice(deviceId)
    if (!peer.online) throw new Error('That device is currently offline. Ask its user to open OpenDesk and check the signaling server URL.')
    const trusted = await window.openDesk.trustPeer({ id: peer.id, name: peer.name, publicKey: peer.publicKey })
    if (!trusted) throw new Error('Device identity was not trusted. No session request was sent.')
    saveKnownDevice(peer)
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
    if (!client) throw new Error('OpenDesk is not connected to a signaling service.')
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
    if (!client) throw new Error('OpenDesk is not connected to a signaling service.')
    await client.decideSession(sessionId, false)
    setState(current => ({ ...current, incomingRequests: current.incomingRequests.filter(request => request.session.id !== sessionId) }))
  }, [])

  const updateConnectionState = useCallback((stateValue: ConnectionState) => {
    setState(current => current.activeSession ? { ...current, activeSession: { ...current.activeSession, connectionState: stateValue } } : current)
  }, [])

  const finishSession = useCallback(async (sessionId: string, result = 'Disconnected') => {
    const currentActive = stateRef.current.activeSession
    if (!currentActive || currentActive.session.id !== sessionId) return
    try { await clientRef.current?.closeSession(sessionId, 'user disconnected') } catch { /* The peer is still locally closed if signaling is offline. */ }
    addRecentSession(currentActive, result)
    setState(current => current.activeSession?.session.id === sessionId ? { ...current, activeSession: null, signals: [] } : current)
  }, [addRecentSession])

  const setServerURL = useCallback(async (url: string) => {
    if (stateRef.current.activeSession) throw new Error('Disconnect the active session before changing the signaling server.')
    const signalingUrl = await window.openDesk.setSignalingUrl(url)
    setState(current => ({ ...current, signalingUrl, serviceState: 'connecting', serviceError: '' }))
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
      incomingRequests: [],
      activeSession: null,
      signals: [],
      serviceState: device.identityReady ? 'connecting' : 'blocked',
      serviceError: device.identityReady ? '' : device.identityMessage,
      cursor: 0
    }))
    return device
  }, [])

  const refreshTrustedDevices = useCallback(async () => {
    const trustedDevices = await window.openDesk.listTrustedDevices()
    setState(current => ({ ...current, trustedDevices }))
  }, [])

  const forgetTrustedDevice = useCallback(async (id: string) => {
    const forgotten = await window.openDesk.forgetTrustedDevice(id)
    if (forgotten) {
      const trustedDevices = await window.openDesk.listTrustedDevices()
      setState(current => ({ ...current, trustedDevices, knownDevices: current.knownDevices.filter(device => device.id !== id) }))
    }
    return forgotten
  }, [])

  const renameLocalDevice = useCallback(async (name: string) => {
    const client = clientRef.current
    if (!client) throw new Error('OpenDesk is not connected to a signaling service.')
    const localDevice = await client.renameDevice(name)
    setState(current => ({ ...current, localDevice, device: current.device ? { ...current.device, deviceName: name } : null }))
  }, [])

  const lookupAndSaveDevice = useCallback(async (id: string) => {
    const client = clientRef.current
    if (!client) throw new Error('OpenDesk is not connected to a signaling service.')
    const device = await client.lookupDevice(id)
    saveKnownDevice(device)
    return device
  }, [saveKnownDevice])

  const updateKnownDeviceStatus = useCallback((id: string, online: boolean) => {
    setState(current => {
      const knownDevices = current.knownDevices.map(device => device.id === id ? { ...device, online } : device)
      localStorage.setItem(KNOWN_STORAGE_KEY, JSON.stringify(knownDevices))
      return { ...current, knownDevices }
    })
  }, [])

  const dismissRequest = useCallback((id: string) => {
    setState(current => ({ ...current, incomingRequests: current.incomingRequests.filter(request => request.session.id !== id) }))
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
    refreshTrustedDevices,
    forgetTrustedDevice,
    renameLocalDevice,
    lookupAndSaveDevice,
    updateKnownDeviceStatus,
    updateConnectionState,
    dismissRequest
  }
}
