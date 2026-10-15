import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopCapabilities,
  DeviceInfo,
  DeviceSummary,
  IncomingFileHandle,
  IncomingFileRequest,
  OpenDeskBridge,
  PeerSignalVerification,
  RemoteSession,
  SessionDecisionRequest,
  SignalingRequest,
  TrustedDevice
} from '../shared/types'
import type { RemoteInputMessage } from '../shared/remote-input'

const bridge: OpenDeskBridge = {
  getDeviceInfo: () => ipcRenderer.invoke('device:get-info') as Promise<DeviceInfo>,
  renameLocalDevice: (name) => ipcRenderer.invoke('device:rename', name) as Promise<DeviceSummary>,
  getSignalingUrl: () => ipcRenderer.invoke('settings:get-signaling-url') as Promise<string>,
  setSignalingUrl: (url) => ipcRenderer.invoke('settings:set-signaling-url', url) as Promise<string>,
  signalingRequest: (request: SignalingRequest) => ipcRenderer.invoke('signaling:request', request) as Promise<unknown>,
  decideSession: (request: SessionDecisionRequest) => ipcRenderer.invoke('session:decide', request) as Promise<RemoteSession>,
  verifyPeerSignal: (signal: PeerSignalVerification) => ipcRenderer.invoke('signaling:verify-peer-signal', signal) as Promise<boolean>,
  trustPeer: (device) => ipcRenderer.invoke('devices:trust-peer', device) as Promise<boolean>,
  listTrustedDevices: () => ipcRenderer.invoke('devices:list-trusted') as Promise<TrustedDevice[]>,
  forgetTrustedDevice: (deviceId) => ipcRenderer.invoke('devices:forget-trusted', deviceId) as Promise<boolean>,
  copyText: (text) => ipcRenderer.invoke('system:copy-text', text) as Promise<void>,
  readText: () => ipcRenderer.invoke('system:read-text') as Promise<string>,
  minimizeWindow: () => ipcRenderer.invoke('window:minimize') as Promise<void>,
  toggleWindowMaximize: (options?: { altKey?: boolean }) => ipcRenderer.invoke('window:toggle-maximize', options) as Promise<boolean>,
  getWindowMaximized: () => ipcRenderer.invoke('window:get-maximized') as Promise<boolean>,
  onWindowMaximizedChange: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: unknown) => listener(maximized === true)
    ipcRenderer.on('window:maximized-changed', handler)
    return () => ipcRenderer.removeListener('window:maximized-changed', handler)
  },
  closeWindow: () => ipcRenderer.invoke('window:close') as Promise<void>,
  shareClipboardText: () => ipcRenderer.invoke('clipboard:share-text') as Promise<string | null>,
  receiveClipboardText: (text) => ipcRenderer.invoke('clipboard:receive-text', text) as Promise<boolean>,
  prepareIncomingFile: (request: IncomingFileRequest) => ipcRenderer.invoke('files:prepare-incoming', request) as Promise<IncomingFileHandle | null>,
  writeIncomingFile: (transferToken, chunk) => ipcRenderer.invoke('files:write-incoming', transferToken, chunk) as Promise<void>,
  finishIncomingFile: (transferToken, expectedSHA256) => ipcRenderer.invoke('files:finish-incoming', transferToken, expectedSHA256) as Promise<{ sha256: string; cleanupWarning?: string }>,
  cancelIncomingFile: (transferToken) => ipcRenderer.invoke('files:cancel-incoming', transferToken) as Promise<void>,
  resetDeviceIdentity: () => ipcRenderer.invoke('identity:reset') as Promise<DeviceInfo | null>,
  armScreenCapture: (options) => ipcRenderer.invoke('capture:arm', options) as Promise<void>,
  startRemoteInput: (sessionId) => ipcRenderer.invoke('input:start', sessionId) as Promise<void>,
  stopRemoteInput: (sessionId) => ipcRenderer.invoke('input:stop', sessionId) as Promise<void>,
  injectRemoteInput: (message: RemoteInputMessage) => ipcRenderer.invoke('input:inject', message) as Promise<void>,
  openScreenCaptureSettings: () => ipcRenderer.invoke('capture:open-settings') as Promise<void>,
  getCapabilities: () => ipcRenderer.invoke('system:get-capabilities') as Promise<DesktopCapabilities>,
  openProjectPage: () => ipcRenderer.invoke('project:open') as Promise<void>
}

contextBridge.exposeInMainWorld('openDesk', bridge)
contextBridge.exposeInMainWorld('g1Viewer', bridge)
