// The renderer bundle never calls createRequire (only the Electron main process does), so the browser harness
// substitutes a stub for node:module. Calling it fails loudly rather than silently pretending to load native code.
export function createRequire(): never {
  throw new Error('node:module is not available in the browser harness')
}
