import { describe, expect, it } from 'vitest'
import { readBoundedResponse } from './http-response'

describe('readBoundedResponse', () => {
  it('rejects a response whose declared size exceeds the limit before reading it', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('too large')) },
      cancel() { cancelled = true }
    })
    const response = new Response(body, { headers: { 'content-length': '100' } })

    await expect(readBoundedResponse(response, 16)).rejects.toThrow('safety limit')
    expect(cancelled).toBe(true)
  })

  it('enforces the byte limit while streaming even when no length is declared', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8))
        controller.enqueue(new Uint8Array(9))
        controller.close()
      }
    }))

    await expect(readBoundedResponse(response, 16)).rejects.toThrow('safety limit')
  })

  it('decodes UTF-8 safely when a multibyte character crosses chunk boundaries', async () => {
    const euro = new TextEncoder().encode('€')
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(euro.slice(0, 1))
        controller.enqueue(euro.slice(1))
        controller.close()
      }
    }))

    await expect(readBoundedResponse(response, 3)).resolves.toBe('€')
    await expect(readBoundedResponse(new Response(new Uint8Array([0xff])), 8)).rejects.toThrow('invalid UTF-8')
  })

  it('returns an empty body when a response has no stream', async () => {
    await expect(readBoundedResponse(new Response(null), 8)).resolves.toBe('')
    await expect(readBoundedResponse(new Response('x'), 0)).rejects.toThrow('positive safe integer')
  })
})
