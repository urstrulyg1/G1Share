export interface DeviceInfo {
  deviceId: string
  appVersion: string
  platform: string
  architecture: string
}
export interface OpenDeskBridge {
  getDeviceInfo: () => Promise<DeviceInfo>
  copyText: (text: string) => Promise<void>
  openProjectPage: () => Promise<void>
}
