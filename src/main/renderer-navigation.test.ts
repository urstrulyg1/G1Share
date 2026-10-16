import { describe, expect, it } from 'vitest'
import { isTrustedRendererUrl } from './renderer-navigation'

describe('isTrustedRendererUrl', () => {
  const renderer = 'file:///Applications/G1Viewer/resources/app/out/renderer/index.html'

  it('allows only the packaged renderer document and its fragment navigation', () => {
    expect(isTrustedRendererUrl(renderer, renderer)).toBe(true)
    expect(isTrustedRendererUrl(`${renderer}#settings`, renderer)).toBe(true)
    expect(isTrustedRendererUrl('file:///etc/passwd', renderer)).toBe(false)
    expect(isTrustedRendererUrl('file:///Applications/G1Viewer/resources/app/out/renderer/other.html', renderer)).toBe(false)
    expect(isTrustedRendererUrl('https://example.com/', renderer)).toBe(false)
    expect(isTrustedRendererUrl(`${renderer}?redirect=https://example.com`, renderer)).toBe(false)
  })

  it('allows same-origin development navigation only when a development URL is configured', () => {
    expect(isTrustedRendererUrl('http://localhost:5173/settings', renderer, 'http://localhost:5173/')).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5174/settings', renderer, 'http://localhost:5173/')).toBe(false)
    expect(isTrustedRendererUrl('file:///etc/passwd', renderer, 'http://localhost:5173/')).toBe(false)
    expect(isTrustedRendererUrl('not a URL', renderer, 'http://localhost:5173/')).toBe(false)
  })
})
