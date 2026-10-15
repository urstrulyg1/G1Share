import type { RemoteInputMessage } from './remote-input'
import type { SessionPermission } from './permissions'

export type { SessionPermission } from './permissions'

export interface DeviceInfo {
  // Null when the OS credential store cannot unlock/generate a genuine signing identity.
  // A display-only random ID must never be presented as a usable device identity.
  deviceId: string | null
  deviceName: string
  appVersion: string
  platform: string
  architecture: string
  identityReady: boolean
  identityMessage: string
  secureStorageBackend: string
}

export type SessionStatus = 'pending' | 'accepted' | 'rejected' | 'closed' | 'expired'

export interface DeviceSummary {
  id: string
  name: string
  publicKey: string
  platform: string
  appVersion: string
  online: boolean
  lastSeenAt?: string
}

export interface RemoteSession {
  id: string
  fromDeviceId: string
  toDeviceId: string
  requestedPermissions: SessionPermission[]
  permissions?: SessionPermission[]
  status: SessionStatus
  createdAt: string
  expiresAt: string
}

export interface PeerSignalMessage {
  fromDeviceId: string
  type: 'offer' | 'answer' | 'hangup'
  payload: Record<string, unknown>
  signature: string
}

export interface SignalingEvent {
  sequence: number
  type: 'session.request' | 'session.accepted' | 'session.rejected' | 'session.closed' | 'session.expired' | 'signal'
  sessionId?: string
  session?: RemoteSession
  peer?: DeviceSummary
  message?: PeerSignalMessage
  reason?: string
  createdAt: string
}

export interface EventBatch {
  cursor: number
  events: SignalingEvent[]
  overflow?: boolean
}

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

export interface IceConfiguration {
  iceServers: IceServer[]
}

export interface SignalingRequest {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
}

export interface SessionDecisionRequest {
  sessionId: string
  accepted: boolean
  permissions: SessionPermission[]
}

export interface PeerSignalVerification {
  sessionId: string
  peerDeviceId: string
  peerPublicKey: string
  fromDeviceId: string
  type: 'offer' | 'answer' | 'hangup'
  payload: Record<string, unknown>
  signature: string
}

export interface IncomingFileRequest {
  name: string
  size: number
}

export interface IncomingFileHandle {
  transferToken: string
  destinationName: string
}

export interface TrustedDevice {
  id: string
  name: string
  fingerprint: string
  trustedAt: string
}

export interface DesktopCapabilities {
  platform: string
  architecture: string
  screenCapture: string
  secureStorage: string
  remoteInput: string
  remoteInputSupported: boolean
  audioCapture: string
  audioCaptureSupported: boolean
  clipboard: string
}

export interface OpenDeskBridge {
  getDeviceInfo: () => Promise<DeviceInfo>
  renameLocalDevice: (name: string) => Promise<DeviceSummary>
  getSignalingUrl: () => Promise<string>
  setSignalingUrl: (url: string) => Promise<string>
  signalingRequest: (request: SignalingRequest) => Promise<unknown>
  decideSession: (request: SessionDecisionRequest) => Promise<RemoteSession>
  verifyPeerSignal: (signal: PeerSignalVerification) => Promise<boolean>
  trustPeer: (device: Pick<DeviceSummary, 'id' | 'name' | 'publicKey'>) => Promise<boolean>
  listTrustedDevices: () => Promise<TrustedDevice[]>
  forgetTrustedDevice: (deviceId: string) => Promise<boolean>
  copyText: (text: string) => Promise<void>
  readText: () => Promise<string>
  minimizeWindow: () => Promise<void>
  toggleWindowMaximize: (options?: { altKey?: boolean }) => Promise<boolean>
  getWindowMaximized: () => Promise<boolean>
  onWindowMaximizedChange: (listener: (maximized: boolean) => void) => () => void
  closeWindow: () => Promise<void>
  shareClipboardText: () => Promise<string | null>
  receiveClipboardText: (text: string) => Promise<boolean>
  prepareIncomingFile: (request: IncomingFileRequest) => Promise<IncomingFileHandle | null>
  writeIncomingFile: (transferToken: string, chunk: Uint8Array) => Promise<void>
  finishIncomingFile: (transferToken: string, expectedSHA256: string) => Promise<{ sha256: string; cleanupWarning?: string }>
  cancelIncomingFile: (transferToken: string) => Promise<void>
  resetDeviceIdentity: () => Promise<DeviceInfo | null>
  armScreenCapture: (options: { sessionId: string; audio: boolean }) => Promise<void>
  startRemoteInput: (sessionId: string) => Promise<void>
  stopRemoteInput: (sessionId: string) => Promise<void>
  injectRemoteInput: (message: RemoteInputMessage) => Promise<void>
  openScreenCaptureSettings: () => Promise<void>
  getCapabilities: () => Promise<DesktopCapabilities>
  openProjectPage: () => Promise<void>
}
