/* Visual-only Electron bridge. This is never included in the packaged application. */
(() => {
  const unavailableDevice = {
    deviceId: null,
    deviceName: 'Visual validation',
    appVersion: 'Visual test',
    platform: 'linux',
    architecture: 'x64',
    identityReady: false,
    identityMessage: 'Visual validation runs without an OS credential store.',
    secureStorageBackend: 'unavailable'
  }
  window.openDesk = {
    getDeviceInfo: async () => unavailableDevice,
    getSignalingUrl: async () => '',
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
    copyText: async () => { throw new Error('Clipboard is disabled in visual-only validation.') },
    renameLocalDevice: async () => { throw new Error('Device identity is unavailable in visual-only validation.') },
    getSignalingUrl: async () => '',
    setSignalingUrl: async () => { throw new Error('Signaling is disabled in visual-only validation.') },
    signalingRequest: async () => { throw new Error('Signaling is disabled in visual-only validation.') },
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
