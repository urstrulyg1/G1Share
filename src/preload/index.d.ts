import type { G1ViewerBridge, OpenDeskBridge } from '../shared/types'
declare global { interface Window { openDesk: OpenDeskBridge; g1Viewer: G1ViewerBridge } }
export {}
