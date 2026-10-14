import { contextBridge, ipcRenderer } from 'electron'
import type { DeviceInfo, OpenDeskBridge } from '../shared/types'

const bridge: OpenDeskBridge = {
  getDeviceInfo: () => ipcRenderer.invoke('device:get-info') as Promise<DeviceInfo>,
  copyText: (text) => ipcRenderer.invoke('system:copy-text', text) as Promise<void>,
  openProjectPage: () => ipcRenderer.invoke('project:open') as Promise<void>
}
contextBridge.exposeInMainWorld('openDesk', bridge)
