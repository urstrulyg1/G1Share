import { contextBridge, ipcRenderer } from 'electron'
import type {
  DesktopCapabilities,
  DeviceInfo,
  IncomingFileHandle,
  IncomingFileRequest,
  OpenDeskBridge,
  PeerSignalVerification,
  RemoteSession,
  SessionDecisionRequest,
  SignalingRequest,
  TrustedDevice
} from '../shared/types'

const bridge: OpenDeskBridge = {
  getDeviceInfo: () => ipcRenderer.invoke('device:get-info') as Promise<DeviceInfo>,
  getSignalingUrl: () => ipcRenderer.invoke('settings:get-signaling-url') as Promise<string>,
  setSignalingUrl: (url) => ipcRenderer.invoke('settings:set-signaling-url', url) as Promise<string>,
  signalingRequest: (request: SignalingRequest) => ipcRenderer.invoke('signaling:request', request) as Promise<unknown>,
  decideSession: (request: SessionDecisionRequest) => ipcRenderer.invoke('session:decide', request) as Promise<RemoteSession>,
  verifyPeerSignal: (signal: PeerSignalVerification) => ipcRenderer.invoke('signaling:verify-peer-signal', signal) as Promise<boolean>,
  trustPeer: (device) => ipcRenderer.invoke('devices:trust-peer', device) as Promise<boolean>,
  listTrustedDevices: () => ipcRenderer.invoke('devices:list-trusted') as Promise<TrustedDevice[]>,
  forgetTrustedDevice: (deviceId) => ipcRenderer.invoke('devices:forget-trusted', deviceId) as Promise<boolean>,
  copyText: (text) => ipcRenderer.invoke('system:copy-text', text) as Promise<void>,
  shareClipboardText: () => ipcRenderer.invoke('clipboard:share-text') as Promise<string | null>,
  receiveClipboardText: (text) => ipcRenderer.invoke('clipboard:receive-text', text) as Promise<boolean>,
  prepareIncomingFile: (request: IncomingFileRequest) => ipcRenderer.invoke('files:prepare-incoming', request) as Promise<IncomingFileHandle | null>,
  writeIncomingFile: (transferToken, chunk) => ipcRenderer.invoke('files:write-incoming', transferToken, chunk) as Promise<void>,
  finishIncomingFile: (transferToken, expectedSHA256) => ipcRenderer.invoke('files:finish-incoming', transferToken, expectedSHA256) as Promise<{ sha256: string; cleanupWarning?: string }>,
  cancelIncomingFile: (transferToken) => ipcRenderer.invoke('files:cancel-incoming', transferToken) as Promise<void>,
  resetDeviceIdentity: () => ipcRenderer.invoke('identity:reset') as Promise<DeviceInfo | null>,
  armScreenCapture: () => ipcRenderer.invoke('capture:arm') as Promise<void>,
  openScreenCaptureSettings: () => ipcRenderer.invoke('capture:open-settings') as Promise<void>,
  getCapabilities: () => ipcRenderer.invoke('system:get-capabilities') as Promise<DesktopCapabilities>,
  openProjectPage: () => ipcRenderer.invoke('project:open') as Promise<void>
}

contextBridge.exposeInMainWorld('openDesk', bridge)
