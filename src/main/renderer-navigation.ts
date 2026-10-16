export function isTrustedRendererUrl(targetURL: string, expectedFileURL: string, devURL?: string): boolean {
  if (devURL) {
    try {
      const target = new URL(targetURL)
      const development = new URL(devURL)
      return target.protocol === development.protocol && target.origin === development.origin
    } catch {
      return false
    }
  }
  return targetURL === expectedFileURL || targetURL.startsWith(`${expectedFileURL}#`)
}
