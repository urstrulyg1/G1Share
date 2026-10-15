// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DeviceInfo, OpenDeskBridge } from '../../../shared/types'
import { useOpenDesk } from './useOpenDesk'

const local: DeviceInfo = {
  deviceId: '11223344-55667788-99AABBCC-DDEEFF00', deviceName: 'OS hostname', appVersion: '0.1.0',
  platform: 'linux', architecture: 'x64', identityReady: true, identityMessage: '', secureStorageBackend: 'gnome_libsecret'
}

function StateProbe() {
  const state = useOpenDesk()
  return <div>
    <span data-testid="service">{state.serviceState}</span>
    <span data-testid="local-id">{state.device?.deviceId || 'Unavailable'}</span>
    <span data-testid="known-devices">{state.knownDevices.length}</span>
    <span data-testid="known-check">{state.knownDevices[0]?.checkedAt || 'Unknown'}</span>
    <span data-testid="history">{state.recentSessions.length}</span>
    <span data-testid="active-session">{state.activeSession?.session.id || 'None'}</span>
    <button onClick={() => { void state.requestSession('AABBCCDD-EEFF0011-22334455-66778899', []).catch(error => {
      document.getElementById('request-error')!.textContent = error.message
    }) }}>Request</button>
    <span id="request-error"/>
    <button onClick={() => { void state.refreshKnownDevices().catch(error => {
      document.getElementById('refresh-error')!.textContent = error.message
    }) }}>Refresh</button>
    <span id="refresh-error"/>
  </div>
}

let signalingRequest: ReturnType<typeof vi.fn>
beforeEach(() => {
  localStorage.clear()
  signalingRequest = vi.fn()
  Object.defineProperty(window, 'openDesk', { configurable: true, value: {
    getDeviceInfo: vi.fn().mockResolvedValue(local),
    getSignalingUrl: vi.fn().mockResolvedValue(''),
    getCapabilities: vi.fn().mockResolvedValue(null),
    listTrustedDevices: vi.fn().mockResolvedValue([]),
    signalingRequest
  } as Partial<OpenDeskBridge> })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('useOpenDesk bootstrap without accounts or sample data', () => {
  it('generates/displays only the supplied real identity; ignores legacy sample caches and shows unconfigured state', async () => {
    localStorage.setItem('opendesk.knownDevices.v1', JSON.stringify([{ id: 'FAKE0000-00000000-00000000-00000000', name: 'Demo workstation', online: true }]))
    localStorage.setItem('opendesk.recentSessions.v1', JSON.stringify([{ id: 'demo', result: 'Connected', peerName: 'Demo workstation' }]))
    render(<StateProbe />)
    await waitFor(() => expect(screen.getByTestId('service').textContent).toBe('unconfigured'))
    expect(screen.getByTestId('local-id').textContent).toBe(local.deviceId)
    expect(screen.getByTestId('known-devices').textContent).toBe('0')
    expect(screen.getByTestId('history').textContent).toBe('0')
    expect(localStorage.getItem('opendesk.knownDevices.v1')).toBeNull()
    expect(localStorage.getItem('opendesk.recentSessions.v1')).toBeNull()
    expect(signalingRequest).not.toHaveBeenCalled()
  })

  it('keeps the dashboard available but rejects requests when the signaling service fails', async () => {
    const bridge = window.openDesk
    bridge.getSignalingUrl = vi.fn().mockResolvedValue('https://signaling.example.test')
    signalingRequest.mockRejectedValue(new Error('Unable to reach the signaling server.'))
    render(<StateProbe />)
    await waitFor(() => expect(screen.getByTestId('service').textContent).toBe('offline'))
    expect(screen.getByTestId('known-devices').textContent).toBe('0')
    expect(screen.getByTestId('active-session').textContent).toBe('None')
    screen.getByRole('button', { name: 'Request' }).click()
    await waitFor(() => expect(screen.getByText(/Unable to reach the signaling server/)).toBeTruthy())
  })

  it('marks a failed device recheck unknown instead of retaining its old online claim', async () => {
    window.openDesk.getSignalingUrl = vi.fn().mockResolvedValue('https://signaling.example.test')
    const peerId = 'AABBCCDD-EEFF0011-22334455-66778899'
    const peer = { id: peerId, name: 'Looked-up device', publicKey: 'A'.repeat(43), platform: 'linux', appVersion: '0.1.0', online: false }
    signalingRequest.mockImplementation(async ({ path }: { path: string }) => {
      if (path === '/api/v1/devices/register') return { ...peer, id: local.deviceId, name: local.deviceName }
      if (path === '/api/v1/devices/heartbeat') return {}
      if (path.startsWith('/api/v1/events')) return await new Promise(() => {})
      if (path === `/api/v1/devices/${peerId}`) return peer
      throw new Error('Unexpected signaling request')
    })
    render(<StateProbe />)
    await waitFor(() => expect(screen.getByTestId('service').textContent).toBe('online'))
    fireEvent.click(screen.getByRole('button', { name: 'Request' }))
    await waitFor(() => expect(screen.getByTestId('known-check').textContent).not.toBe('Unknown'))
    signalingRequest.mockImplementation(async ({ path }: { path: string }) => {
      if (path === `/api/v1/devices/${peerId}`) throw new Error('Signaling lookup failed')
      if (path.startsWith('/api/v1/events')) return await new Promise(() => {})
      return {}
    })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.getByTestId('known-check').textContent).toBe('Unknown'))
    expect(screen.getByText(/Some devices could not be checked/)).toBeTruthy()
  })

  it('does not show a non-cryptographic device ID when OS secure storage is blocked', async () => {
    window.openDesk.getDeviceInfo = vi.fn().mockResolvedValue({ ...local, deviceId: null, identityReady: false, identityMessage: 'Unlock the system keyring.' })
    render(<StateProbe />)
    await waitFor(() => expect(screen.getByTestId('service').textContent).toBe('blocked'))
    expect(screen.getByTestId('local-id').textContent).toBe('Unavailable')
    expect(signalingRequest).not.toHaveBeenCalled()
  })
})
