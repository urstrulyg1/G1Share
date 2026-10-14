/// <reference types="vite/client" />
import type { OpenDeskBridge } from '../../shared/types'

declare global {
  interface Window {
    openDesk: OpenDeskBridge
  }
}

export {}
