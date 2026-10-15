import { createHash, randomUUID } from 'node:crypto'
import { open, lstat, link, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { IncomingFileHandle } from '../shared/types'

const MAX_FILE_BYTES = 1024 * 1024 * 1024
const MAX_FILE_CHUNK = 64 * 1024

interface IncomingSink {
  temporaryPath: string
  destinationPath: string
  handle: FileHandle
  size: number
  written: number
  hash: ReturnType<typeof createHash>
  queue: Promise<void>
  finalizing: boolean
  closing: boolean
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function validatedToken(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new TypeError('Incoming file transfer token is invalid.')
  return value
}

export class IncomingFileStore {
  private readonly sinks = new Map<string, IncomingSink>()

  async prepare(destinationPath: string, size: number): Promise<IncomingFileHandle> {
    if (typeof destinationPath !== 'string' || !isAbsolute(destinationPath)) throw new TypeError('The selected destination path is invalid.')
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new TypeError('File exceeds the configured 1 GiB transfer limit.')
    try {
      await lstat(destinationPath)
      throw new Error('That destination already exists. Choose a different file name; OpenDesk never overwrites received files.')
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }

    const temporaryPath = join(dirname(destinationPath), `.opendesk-${randomUUID()}.part`)
    let handle: FileHandle
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
    } catch {
      throw new Error('OpenDesk could not create a private temporary file in the selected folder. Check folder permissions and available disk space.')
    }
    const transferToken = randomUUID()
    this.sinks.set(transferToken, {
      temporaryPath,
      destinationPath,
      handle,
      size,
      written: 0,
      hash: createHash('sha256'),
      queue: Promise.resolve(),
      finalizing: false,
      closing: false
    })
    return { transferToken, destinationName: basename(destinationPath) }
  }

  write(transferToken: string, chunk: Uint8Array): Promise<void> {
    const token = validatedToken(transferToken)
    const sink = this.sinks.get(token)
    if (!sink || sink.closing || sink.finalizing) throw new Error('Incoming file transfer is no longer accepting data.')
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength > MAX_FILE_CHUNK) {
      throw new TypeError('Incoming file chunk is invalid or exceeds the 64 KiB chunk limit.')
    }
    const copy = chunk.slice()
    return this.enqueue(sink, async () => {
      if (sink.closing || this.sinks.get(token) !== sink) throw new Error('Incoming file transfer is no longer active.')
      if (sink.written + copy.byteLength > sink.size) throw new TypeError('Incoming file chunk exceeds the declared file size.')
      const buffer = Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength)
      let offset = 0
      while (offset < buffer.length) {
        const result = await sink.handle.write(buffer, offset, buffer.length - offset, null)
        if (result.bytesWritten <= 0) throw new Error('Could not write the incoming file to disk.')
        offset += result.bytesWritten
      }
      sink.hash.update(buffer)
      sink.written += buffer.length
    })
  }

  finish(transferToken: string, expectedSHA256: string): Promise<{ sha256: string }> {
    const token = validatedToken(transferToken)
    const sink = this.sinks.get(token)
    if (!sink || sink.closing || sink.finalizing) throw new Error('Incoming file transfer is no longer active.')
    sink.finalizing = true
    return this.enqueue(sink, async () => {
      if (sink.closing || this.sinks.get(token) !== sink) throw new Error('Incoming file transfer is no longer active.')
      if (!/^[a-f0-9]{64}$/i.test(expectedSHA256) || sink.written !== sink.size) {
        await this.removeSink(token, sink)
        throw new Error('Incoming file size or integrity metadata does not match. The temporary file was removed.')
      }
      const actual = sink.hash.digest('hex')
      if (actual.toLowerCase() !== expectedSHA256.toLowerCase()) {
        await this.removeSink(token, sink)
        throw new Error('SHA-256 verification failed. The temporary file was removed.')
      }
      try {
        await sink.handle.sync()
        await sink.handle.close()
        await link(sink.temporaryPath, sink.destinationPath)
        this.sinks.delete(token)
        try {
          await unlink(sink.temporaryPath)
          return { sha256: actual }
        } catch (cleanupError) {
          if (errorCode(cleanupError) === 'ENOENT') return { sha256: actual }
          return {
            sha256: actual,
            cleanupWarning: 'The received file was saved, but OpenDesk could not remove its hidden temporary link. Remove the .opendesk-*.part file from the destination folder manually.'
          }
        }
      } catch (error) {
        this.sinks.delete(token)
        await sink.handle.close().catch(() => undefined)
        let cleanupError: unknown
        try { await this.cleanupTemporary(sink) } catch (failure) { cleanupError = failure }
        if (errorCode(error) === 'EEXIST') {
          if (cleanupError) throw new Error(`That destination was created during the transfer. OpenDesk did not overwrite it, but incomplete-file cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : 'remove the hidden .opendesk-*.part file manually.'}`)
          throw new Error('That destination was created during the transfer. OpenDesk never overwrites files; the incomplete temporary file was removed.')
        }
        if (cleanupError) throw new Error(`OpenDesk could not securely finalize the received file, and incomplete-file cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : 'remove the hidden .opendesk-*.part file manually.'}`)
        throw new Error('OpenDesk could not securely finalize the received file. The incomplete temporary file was removed.')
      }
    })
  }

  cancel(transferToken: string): Promise<void> {
    const token = validatedToken(transferToken)
    const sink = this.sinks.get(token)
    if (!sink) return Promise.resolve()
    if (sink.closing) return sink.queue
    sink.closing = true
    return this.enqueue(sink, async () => {
      if (this.sinks.get(token) === sink) await this.removeSink(token, sink)
    })
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.sinks.keys()].map(token => this.cancel(token)))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) throw new Error(`${failures.length} incomplete file transfer(s) could not be cleaned up. Remove any hidden .opendesk-*.part files manually.`)
  }

  private enqueue<T>(sink: IncomingSink, operation: () => Promise<T>): Promise<T> {
    const result = sink.queue.then(operation)
    sink.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async removeSink(token: string, sink: IncomingSink): Promise<void> {
    this.sinks.delete(token)
    sink.closing = true
    await sink.handle.close().catch(() => undefined)
    await this.cleanupTemporary(sink)
  }

  private async cleanupTemporary(sink: IncomingSink): Promise<void> {
    try {
      await unlink(sink.temporaryPath)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw new Error('OpenDesk could not remove the incomplete temporary file. Check folder permissions and remove the hidden .opendesk-*.part file manually.')
      }
    }
  }
}
