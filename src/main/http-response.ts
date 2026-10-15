export async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError('Response byte limit must be a positive safe integer.')
  const tooLargeMessage = `Signaling response exceeded the ${maximumBytes} byte safety limit.`
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(tooLargeMessage)
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesRead = 0
  let text = ''
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      bytesRead += result.value.byteLength
      if (bytesRead > maximumBytes) throw new Error(tooLargeMessage)
      try { text += decoder.decode(result.value, { stream: true }) }
      catch { throw new Error('Signaling server returned invalid UTF-8 data.') }
    }
    try { text += decoder.decode() }
    catch { throw new Error('Signaling server returned invalid UTF-8 data.') }
    return text
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}
