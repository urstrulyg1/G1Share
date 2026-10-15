// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { DeviceInfo, DeviceSummary, DesktopCapabilities, OpenDeskBridge, RemoteSession } from '../../shared/types'
import type { ActiveSession, IncomingSessionRequest } from './hooks/useOpenDesk'
import App from './App'
import { ActiveSessionView } from './components/ActiveSessionView'

// UI fixtures live in this test only; production App always calls the real useOpenDesk hook.
let runtime: Record<string, unknown>
let bridge: Partial<OpenDeskBridge>
vi.mock('./hooks/useOpenDesk', () => ({ useOpenDesk: () => runtime }))

const local: DeviceInfo = {
  deviceId: '11223344-55667788-99AABBCC-DDEEFF00', deviceName: 'My workstation', appVersion: '0.1.0',
  platform: 'linux', architecture: 'x64', identityReady: true, identityMessage: '', secureStorageBackend: 'gnome_libsecret'
}
const peer: DeviceSummary = {
  id: 'AABBCCDD-EEFF0011-22334455-66778899', name: 'Remote workstation', publicKey: 'A'.repeat(43),
  platform: 'linux', appVersion: '0.1.0', online: true
}
const capabilities: DesktopCapabilities = {
  platform: 'linux', architecture: 'x64', screenCapture: 'OS permission required.', secureStorage: 'gnome_libsecret',
  remoteInput: 'Wayland input is unavailable.', remoteInputSupported: false,
  audioCapture: 'Audio is Windows-only.', audioCaptureSupported: false, clipboard: 'Manual clipboard.'
}
const session: RemoteSession = {
  id: '1'.repeat(32), fromDeviceId: peer.id, toDeviceId: local.deviceId!,
  requestedPermissions: ['view', 'files', 'clipboard', 'input', 'audio'], status: 'pending',
  createdAt: '2026-10-15T12:00:00.000Z', expiresAt: '2026-10-15T12:01:30.000Z'
}

function initialState(overrides: Record<string, unknown> = {}) {
  runtime = {
    device: local, localDevice: null, capabilities, capabilitiesError: '', trustedDevices: [], trustedDevicesError: '',
    knownDevices: [], incomingRequests: [], activeSession: null, recentSessions: [], signals: [],
    serviceState: 'unconfigured', serviceError: 'No signaling server configured. Add a self-hosted HTTPS origin in Settings to connect.',
    signalingUrl: '', signalingClient: null,
    requestSession: vi.fn(), approveSession: vi.fn(), rejectSession: vi.fn(), finishSession: vi.fn(),
    refreshTrustedDevices: vi.fn().mockResolvedValue(undefined), refreshKnownDevices: vi.fn().mockResolvedValue(undefined),
    refreshCapabilities: vi.fn().mockResolvedValue(undefined), forgetTrustedDevice: vi.fn(), renameLocalDevice: vi.fn(),
    resetDeviceIdentity: vi.fn(), setServerURL: vi.fn(), updateConnectionState: vi.fn(),
    ...overrides
  }
  return runtime
}

beforeEach(() => {
  localStorage.clear()
  bridge = {
    copyText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue('AABBCCDD-EEFF0011-22334455-66778899'),
    openProjectPage: vi.fn().mockResolvedValue(undefined),
    minimizeWindow: vi.fn().mockResolvedValue(undefined),
    toggleWindowMaximize: vi.fn().mockResolvedValue(true),
    getWindowMaximized: vi.fn().mockResolvedValue(false),
    onWindowMaximizedChange: vi.fn().mockReturnValue(() => undefined),
    closeWindow: vi.fn().mockResolvedValue(undefined)
  }
  Object.defineProperty(window, 'openDesk', { configurable: true, value: bridge as OpenDeskBridge })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('account-free application UI', () => {
  it('starts on the dashboard with honest empty state and no login/signup route', () => {
    initialState()
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Access Your Devices Anywhere' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Connect to a Device' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /log in|sign up|create account|reset password/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /log in|sign up|create account|reset password/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect to remote device' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByText(/No signaling server configured/)).toBeTruthy()
    expect(screen.getAllByText(local.deviceId!).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('No recent devices')).toBeTruthy()
    expect(screen.queryByText('EXAMPLE DATA · NOT VERIFIED')).toBeNull()
    expect(screen.queryByText('My Desktop')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Devices' }))
    expect(screen.getByText('No looked-up devices yet')).toBeTruthy()
    expect(screen.queryByText('Remote workstation')).toBeNull()
    expect(screen.getByText(/No device fingerprints are trusted yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Recent sessions' }))
    expect(screen.getByRole('heading', { name: 'No recent sessions' })).toBeTruthy()
    expect(screen.queryByText(/Connected to/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'File Transfer' }))
    expect(screen.getByText(/Connect and request file transfer/)).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByLabelText('Signaling server origin')).toHaveProperty('value', '')
    expect(screen.queryByText(/account profile/i)).toBeNull()
  })

  it('never treats stale or unreachable devices as online in the redesigned dashboard', () => {
    initialState({ serviceState: 'online', serviceError: '', signalingUrl: 'https://signaling.example.test',
      knownDevices: [{ ...peer, checkedAt: new Date(Date.now() - 90_000).toISOString() }] })
    render(<App />)
    expect(screen.getByText(/Status unknown — refresh/)).toBeTruthy()
    expect(screen.queryByText('Online at last lookup')).toBeNull()
    expect(screen.getByRole('button', { name: `Connect to ${peer.name}` })).toBeTruthy()
  })

  it('shows an unavailable device ID rather than a fabricated fallback when secure storage fails', () => {
    initialState({ device: { ...local, deviceId: null, identityReady: false, identityMessage: 'Unlock your keyring.' }, serviceState: 'blocked', serviceError: 'Unlock your keyring.' })
    render(<App />)
    expect(screen.getByText('Unavailable — unlock your OS credential store')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy device ID' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText(local.deviceId!)).toBeNull()
  })

  it('reports request failures without a fake success or a remote session', async () => {
    const requestSession = vi.fn().mockRejectedValue(new Error('Unable to reach the signaling server.'))
    initialState({ serviceState: 'online', serviceError: '', signalingUrl: 'https://signaling.example.test', requestSession })
    render(<App />)
    fireEvent.change(screen.getByLabelText('Remote device ID'), { target: { value: peer.id } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect to remote device' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Unable to reach the signaling server.'))
    expect(requestSession).toHaveBeenCalledWith(peer.id, [])
    expect(screen.queryByText(/Session request sent/)).toBeNull()
    expect(screen.getByRole('heading', { name: 'Connect to a Device' })).toBeTruthy()
  })

  it('leaves optional permissions off and grants each extra independently', async () => {
    const approveSession = vi.fn().mockResolvedValue(undefined)
    const incoming: IncomingSessionRequest = { session, peer }
    initialState({ incomingRequests: [incoming], serviceState: 'online', serviceError: '', approveSession })
    render(<App />)
    const file = screen.getByRole('checkbox', { name: 'Grant file transfer' }) as HTMLInputElement
    const clipboard = screen.getByRole('checkbox', { name: 'Grant one-time clipboard text' }) as HTMLInputElement
    const input = screen.getByRole('checkbox', { name: /Grant remote keyboard and mouse/ }) as HTMLInputElement
    const audio = screen.getByRole('checkbox', { name: /Grant system audio/ }) as HTMLInputElement
    expect([file.checked, clipboard.checked, input.checked, audio.checked]).toEqual([false, false, false, false])
    expect(input.disabled).toBe(true)
    expect(audio.disabled).toBe(true)
    fireEvent.click(file)
    fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }))
    await waitFor(() => expect(approveSession).toHaveBeenCalledWith(session.id, ['view', 'files']))
  })

  it('copies and pastes the real device ID and saves aliases through the existing device service', async () => {
    const renameLocalDevice = vi.fn().mockResolvedValue(undefined)
    initialState({ serviceState: 'online', serviceError: '', renameLocalDevice })
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy device ID' }))
    await waitFor(() => expect(bridge.copyText).toHaveBeenCalledWith(local.deviceId))
    fireEvent.click(screen.getByRole('button', { name: 'Paste device ID from clipboard' }))
    await waitFor(() => expect(screen.getByLabelText('Remote device ID')).toHaveProperty('value', peer.id))
    expect(bridge.readText).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Set Custom Alias (Optional)' }))
    fireEvent.change(screen.getByLabelText('Device alias'), { target: { value: 'Studio workstation' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(renameLocalDevice).toHaveBeenCalledWith('Studio workstation'))
    expect(screen.getByText(/Device alias saved as/)).toBeTruthy()
  })

  it('rejects incoming session requests when the incoming-request switch is turned off', async () => {
    const rejectSession = vi.fn().mockResolvedValue(undefined)
    const incoming: IncomingSessionRequest = { session, peer }
    initialState({ serviceState: 'online', serviceError: '', incomingRequests: [incoming], rejectSession })
    render(<App />)
    fireEvent.click(screen.getByRole('switch', { name: 'Allow incoming session requests' }))
    await waitFor(() => expect(rejectSession).toHaveBeenCalledWith(session.id))
    expect(localStorage.getItem('opendesk.incomingRequests.v1')).toBe('false')
    expect(screen.queryByText('Incoming session requests')).toBeNull()
  })

  it('displays real known devices in recent devices and connects to real device IDs', async () => {
    initialState({ serviceState: 'online', serviceError: '', signalingUrl: 'https://signaling.example.test', knownDevices: [peer] })
    render(<App />)
    expect(screen.getByText(peer.name)).toBeTruthy()
    expect(screen.queryByText('EXAMPLE DATA · NOT VERIFIED')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `Connect to ${peer.name}` }))
    await waitFor(() => expect(runtime.requestSession).toHaveBeenCalledWith(peer.id, []))
  })

  it('uses native window APIs for minimize, maximize, and close controls', async () => {
    initialState()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }))
    await waitFor(() => expect(bridge.minimizeWindow).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Maximize window' }))
    await waitFor(() => expect(bridge.toggleWindowMaximize).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore window' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }))
    await waitFor(() => expect(bridge.closeWindow).toHaveBeenCalledOnce())
  })
})

describe('active session diagnostics', () => {
  it('shows unavailable metrics and no synthetic remote display while waiting for approval', () => {
    initialState()
    const active: ActiveSession = { role: 'viewer', peer, session, connectionState: 'connecting' }
    const { container } = render(<ActiveSessionView active={active} localDevice={local} client={null} signals={[]}
      onState={vi.fn()} onFinish={vi.fn()} onError={vi.fn()}/> )
    const grid = container.querySelector('.metric-grid')!
    expect(within(grid as HTMLElement).getAllByText('Unavailable').length).toBeGreaterThan(5)
    expect(container.querySelector('video.remote-video')).toBeNull()
    expect(screen.getByText('Approval is required')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send file(s)' })).toBeNull()
  })
})
