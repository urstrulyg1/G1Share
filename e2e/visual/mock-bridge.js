/* Visual-only fixture bridge. Never included in the packaged application. */
(() => {
  document.documentElement.dataset.visualValidation = 'true'
  const device = {
    deviceId: '482 916 307',
    deviceName: 'OpenDesk Desktop',
    appVersion: '1.0.0',
    platform: 'linux',
    architecture: 'x64',
    identityReady: true,
    identityMessage: 'Visual fixture identity; not a real cryptographic device identity.',
    secureStorageBackend: 'visual fixture'
  }
  const localSummary = {
    id: device.deviceId,
    name: device.deviceName,
    publicKey: 'VISUAL_FIXTURE_ONLY',
    platform: device.platform,
    appVersion: device.appVersion,
    online: true,
    lastSeenAt: new Date().toISOString()
  }
  window.openDesk = {
    getDeviceInfo: async () => device,
    getSignalingUrl: async () => 'https://visual-validation.invalid',
    getCapabilities: async () => ({
      screenCapture: false,
      remoteInput: false,
      clipboard: false,
      fileTransfer: false,
      audioCapture: false,
      platform: 'visual-validation',
      unsupportedReasons: ['Visual-only browser harness; native desktop capabilities are not available.']
    }),
    listTrustedDevices: async () => [],
    getWindowMaximized: async () => false,
    onWindowMaximizedChange: () => () => {},
    copyText: async () => {},
    renameLocalDevice: async () => { throw new Error('Device renaming is disabled in visual-only validation.') },
    setSignalingUrl: async () => { throw new Error('Signaling is disabled in visual-only validation.') },
    signalingRequest: async request => {
      if (request.path === '/api/v1/devices/register') return { ...localSummary, id: request.body?.id || localSummary.id, name: request.body?.name || localSummary.name }
      if (request.path === '/api/v1/devices/heartbeat') return {}
      if (request.path.startsWith('/api/v1/events')) {
        const after = Number(new URLSearchParams(request.path.split('?')[1] || '').get('after') || 0)
        return { cursor: after, events: [], overflow: false }
      }
      if (request.path === '/api/v1/ice') return { iceServers: [] }
      throw new Error('This action is disabled in the visual-only harness.')
    },
    decideSession: async () => { throw new Error('Sessions are disabled in visual-only validation.') },
    verifyPeerSignal: async () => false,
    trustPeer: async () => false,
    forgetTrustedDevice: async () => false,
    resetDeviceIdentity: async () => null,
    minimizeWindow: async () => {},
    toggleWindowMaximize: async () => false,
    closeWindow: async () => {},
    openProjectPage: async () => {},
    openScreenCaptureSettings: async () => {},
    readText: async () => '',
    shareClipboardText: async () => null,
    receiveClipboardText: async () => false,
    prepareIncomingFile: async () => null,
    writeIncomingFile: async () => {},
    finishIncomingFile: async () => { throw new Error('File transfer is disabled in visual-only validation.') },
    cancelIncomingFile: async () => {},
    armScreenCapture: async () => { throw new Error('Screen capture is disabled in visual-only validation.') },
    startRemoteInput: async () => { throw new Error('Remote input is disabled in visual-only validation.') },
    stopRemoteInput: async () => {},
    injectRemoteInput: async () => { throw new Error('Remote input is disabled in visual-only validation.') }
  }
})()
