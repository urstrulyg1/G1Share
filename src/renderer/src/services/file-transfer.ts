import { sha256 } from '@noble/hashes/sha256'
import type { IncomingFileHandle, OpenDeskBridge } from '../../../shared/types'
import { REMOTE_INPUT_PREFIX } from '../../../shared/remote-input'

// Remote-control envelopes are serialized with `type` first; matching that prefix never mistakes
// clipboard or file text that merely contains the same characters for a control message.
function isRemoteInputEnvelope(data: unknown): boolean {
  return typeof data === 'string' && data.startsWith('{"type":"' + REMOTE_INPUT_PREFIX)
}

const MAX_FILE_BYTES = 1024 * 1024 * 1024
const CHUNK_BYTES = 16 * 1024
const FRAME_HEADER_BYTES = 20
// Bytes allowed to queue on the file channel before the sender waits. The SCTP association is shared with the
// input channel, so this bound also bounds how long a queued input message can wait behind file data
// (about 100 ms at 10 Mb/s). 128 KiB keeps that bounded while still pipelining across round trips up to ~100 ms.
const MAX_BUFFERED_BYTES = 128 * 1024
const MAX_CONTROL_BYTES = 64 * 1024
const MAX_CLIPBOARD_BYTES = 32 * 1024
const ACK_EVERY_CHUNKS = 16
const MAX_PENDING_RECEIVE_BYTES = 1024 * 1024
const INCOMING_IDLE_TIMEOUT_MS = 5 * 60 * 1000

export type TransferDirection = 'sending' | 'receiving'
export type TransferStatus = 'waiting' | 'transferring' | 'verifying' | 'complete' | 'cancelled' | 'failed'

export interface TransferRecord {
  id: string
  name: string
  size: number
  transferred: number
  direction: TransferDirection
  status: TransferStatus
  error?: string
}

interface TransferHandlers {
  allowFiles: boolean
  allowClipboard: boolean
  onIncomingOffer: (name: string, size: number) => Promise<IncomingFileHandle | null>
  onClipboardText: (text: string) => Promise<void>
  onTransfer: (record: TransferRecord) => void
  onError: (message: string) => void
}

interface FileOffer {
  type: 'file:offer'
  id: string
  name: string
  size: number
}

interface ControlMessage {
  type: string
  id?: string
  name?: string
  size?: number
  nextSequence?: number
  sha256?: string
  reason?: string
  text?: string
}

interface IncomingTransfer {
  id: string
  name: string
  size: number
  token: string
  transferred: number
  nextSequence: number
  hash: ReturnType<typeof sha256.create>
  lastNotify: number
  idleTimer: ReturnType<typeof setTimeout> | null
}

interface OutgoingTransfer {
  record: TransferRecord
  file: File
  hash: ReturnType<typeof sha256.create>
  transferred: number
  nextSequence: number
  accepted: Deferred<boolean>
  verified: Deferred<boolean>
  ack: Deferred<number> | null
  reader: ReadableStreamDefaultReader<Uint8Array> | null
  expectedHash?: string
  cancelled: boolean
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

function randomTransferId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

function isTransferId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

function transferError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 180)
  return 'The file transfer failed.'
}

export class FileTransferManager {
  private readonly incoming = new Map<string, IncomingTransfer>()
  private readonly outgoing = new Map<string, OutgoingTransfer>()
  private readonly pendingOffers = new Set<string>()
  private readonly cancelledOffers = new Set<string>()
  private receiveQueue: Promise<void> = Promise.resolve()
  private pendingBytes = 0
  private closed = false

  constructor(
    private readonly channel: RTCDataChannel,
    private readonly bridge: Pick<OpenDeskBridge, 'prepareIncomingFile' | 'writeIncomingFile' | 'finishIncomingFile' | 'cancelIncomingFile'>,
    private readonly handlers: TransferHandlers
  ) {
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = MAX_BUFFERED_BYTES / 2
    channel.addEventListener('message', event => {
      // Remote-control messages share this data channel; they are handled by RemoteSessionController.
      if (isRemoteInputEnvelope(event.data)) return
      this.queueMessage(event.data)
    })
    channel.addEventListener('close', () => { void this.close() }, { once: true })
  }

  async sendFiles(files: File[]): Promise<void> {
    if (!this.handlers.allowFiles) throw new Error('File transfer permission was not approved for this session.')
    if (this.closed || this.channel.readyState !== 'open') throw new Error('The secure data channel is not connected.')
    if (files.length === 0) return
    if (files.length > 16) throw new Error('Send no more than 16 files at once.')
    for (const file of files) await this.sendFile(file)
  }

  sendClipboardText(text: string): void {
    if (!this.handlers.allowClipboard) throw new Error('Clipboard permission was not approved for this session.')
    if (new TextEncoder().encode(text).byteLength > MAX_CLIPBOARD_BYTES) throw new Error('Clipboard text exceeds the 32 KiB peer-transfer limit.')
    this.sendControl({ type: 'clipboard:text', text })
  }

  cancel(id: string): void {
    const outgoing = this.outgoing.get(id)
    if (outgoing) {
      outgoing.cancelled = true
      outgoing.reader?.cancel().catch(() => undefined)
      outgoing.accepted.resolve(false)
      outgoing.verified.resolve(false)
      outgoing.ack?.resolve(-1)
      this.sendControl({ type: 'file:cancel', id })
      this.updateRecord({ ...outgoing.record, status: 'cancelled' })
      return
    }
    const incoming = this.incoming.get(id)
    if (incoming) {
      this.clearIncomingTimer(incoming)
      this.incoming.delete(id)
      void this.bridge.cancelIncomingFile(incoming.token).catch(error => {
        this.handlers.onError(`Could not remove the incomplete received file: ${transferError(error)}`)
      })
      this.sendControl({ type: 'file:cancel', id })
      this.handlers.onTransfer({ id, name: incoming.name, size: incoming.size, transferred: incoming.transferred, direction: 'receiving', status: 'cancelled' })
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const transfer of this.outgoing.values()) {
      transfer.cancelled = true
      transfer.reader?.cancel().catch(() => undefined)
      transfer.accepted.resolve(false)
      transfer.verified.resolve(false)
      transfer.ack?.resolve(-1)
      if (transfer.record.status !== 'complete') this.updateRecord({ ...transfer.record, status: 'cancelled' })
    }
    for (const id of this.pendingOffers) this.cancelledOffers.add(id)
    for (const transfer of this.incoming.values()) {
      this.clearIncomingTimer(transfer)
      let error: string | undefined
      try { await this.bridge.cancelIncomingFile(transfer.token) }
      catch (failure) {
        error = `Could not remove the incomplete received file: ${transferError(failure)}`
        this.handlers.onError(error)
      }
      this.handlers.onTransfer({ id: transfer.id, name: transfer.name, size: transfer.size, transferred: transfer.transferred, direction: 'receiving', status: 'cancelled', error })
    }
    this.incoming.clear()
    this.outgoing.clear()
  }

  private async sendFile(file: File): Promise<void> {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) throw new Error('Each file must be no larger than 1 GiB.')
    const id = randomTransferId()
    const record: TransferRecord = { id, name: file.name.slice(0, 240) || 'unnamed-file', size: file.size, transferred: 0, direction: 'sending', status: 'waiting' }
    const transfer: OutgoingTransfer = {
      record, file, hash: sha256.create(), transferred: 0, nextSequence: 0,
      accepted: deferred<boolean>(), verified: deferred<boolean>(), ack: null, reader: null, cancelled: false
    }
    this.outgoing.set(id, transfer)
    this.updateRecord(record)
    this.sendControl({ type: 'file:offer', id, name: record.name, size: file.size })
    try {
      const accepted = await withTimeout(transfer.accepted.promise, 60_000, 'The remote user did not approve the file destination in time.')
      if (!accepted) throw new Error('The remote user declined this file.')
      if (transfer.cancelled) throw new Error('Transfer cancelled.')
      transfer.record = { ...transfer.record, status: 'transferring' }
      this.updateRecord(transfer.record)
      transfer.reader = file.stream().getReader()
      let done = false
      while (!done) {
        const result = await transfer.reader.read()
        done = result.done
        if (done || !result.value) break
        const source = result.value
        for (let offset = 0; offset < source.byteLength; offset += CHUNK_BYTES) {
          if (transfer.cancelled || this.closed) throw new Error('Transfer cancelled.')
          const chunk = source.subarray(offset, Math.min(offset + CHUNK_BYTES, source.byteLength))
          transfer.hash.update(chunk)
          await this.waitForBuffer()
          this.channel.send(this.createFrame(id, transfer.nextSequence, chunk))
          transfer.nextSequence += 1
          transfer.transferred += chunk.byteLength
          transfer.record = { ...transfer.record, transferred: transfer.transferred }
          this.updateRecord(transfer.record)
          if (transfer.nextSequence % ACK_EVERY_CHUNKS === 0) {
            transfer.ack = deferred<number>()
            const acknowledged = await withTimeout(transfer.ack.promise, 30_000, 'The remote file receiver stopped acknowledging data.')
            if (acknowledged !== transfer.nextSequence) throw new Error('File receiver sequence acknowledgement was invalid.')
            transfer.ack = null
          }
        }
      }
      if (transfer.cancelled) throw new Error('Transfer cancelled.')
      if (transfer.transferred !== file.size) throw new Error('File size changed while it was being transferred.')
      transfer.record = { ...transfer.record, status: 'verifying' }
      this.updateRecord(transfer.record)
      transfer.expectedHash = hex(transfer.hash.digest())
      this.sendControl({ type: 'file:end', id, size: transfer.transferred, sha256: transfer.expectedHash })
      const verified = await withTimeout(transfer.verified.promise, 60_000, 'The receiver did not confirm file integrity.')
      if (!verified) throw new Error('The receiver could not verify the file.')
      transfer.record = { ...transfer.record, status: 'complete', transferred: transfer.file.size }
      this.updateRecord(transfer.record)
    } catch (error) {
      const cancelled = transfer.cancelled || this.closed || transferError(error).includes('cancelled')
      const next: TransferRecord = { ...transfer.record, status: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : transferError(error) }
      this.updateRecord(next)
      if (!cancelled) this.sendControl({ type: 'file:cancel', id, reason: transferError(error) })
      if (!cancelled) this.handlers.onError(transferError(error))
    } finally {
      transfer.reader?.releaseLock()
      this.outgoing.delete(id)
    }
  }

  private queueMessage(data: unknown): void {
    const size = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data instanceof ArrayBuffer ? data.byteLength : 0
    const validSize = typeof data === 'string'
      ? data.length > 0 && size <= MAX_CONTROL_BYTES
      : data instanceof ArrayBuffer && data.byteLength >= FRAME_HEADER_BYTES && data.byteLength <= CHUNK_BYTES + FRAME_HEADER_BYTES
    if (!validSize || size === 0) {
      this.protocolFailure('Remote peer sent an invalid or oversized data-channel message.')
      return
    }
    this.pendingBytes += size
    if (this.pendingBytes > MAX_PENDING_RECEIVE_BYTES) {
      this.protocolFailure('Remote peer exceeded the bounded file-transfer receive buffer.')
      return
    }
    this.receiveQueue = this.receiveQueue
      .then(() => this.receiveMessage(data))
      .catch(error => this.protocolFailure(transferError(error)))
      .finally(() => { this.pendingBytes = Math.max(0, this.pendingBytes - size) })
  }

  private async receiveMessage(data: unknown): Promise<void> {
    if (this.closed) return
    if (typeof data === 'string') {
      let message: ControlMessage
      try { message = JSON.parse(data) as ControlMessage } catch { throw new Error('Remote peer sent malformed transfer metadata.') }
      if (!message || typeof message.type !== 'string' || new TextEncoder().encode(data).byteLength > MAX_CONTROL_BYTES) throw new Error('Remote peer sent invalid transfer metadata.')
      await this.receiveControl(message)
      return
    }
    if (!(data instanceof ArrayBuffer)) throw new Error('Remote peer sent an unsupported binary frame.')
    await this.receiveFrame(data)
  }

  private async receiveControl(message: ControlMessage): Promise<void> {
    const id = message.id
    if (message.type === 'clipboard:text') {
      if (!this.handlers.allowClipboard || typeof message.text !== 'string' || new TextEncoder().encode(message.text).byteLength > MAX_CLIPBOARD_BYTES) {
        throw new Error('Remote clipboard message is unauthorized or exceeds the size limit.')
      }
      await this.handlers.onClipboardText(message.text)
      return
    }
    if (message.type === 'file:offer') {
      if (!isTransferId(id) || typeof message.name !== 'string' || !Number.isSafeInteger(message.size) || message.size! < 0 || message.size! > MAX_FILE_BYTES) {
        throw new Error('Remote file offer is invalid or exceeds 1 GiB.')
      }
      if (!this.handlers.allowFiles) {
        this.sendControl({ type: 'file:reject', id, reason: 'File transfer was not approved for this session.' })
        return
      }
      if (this.incoming.size + this.pendingOffers.size >= 4 || this.incoming.has(id) || this.pendingOffers.has(id)) {
        this.sendControl({ type: 'file:reject', id, reason: 'Too many active transfers.' })
        return
      }
      this.pendingOffers.add(id)
      void this.prepareIncomingOffer(id, message.name.slice(0, 240), message.size!)
      return
    }
    if (!isTransferId(id)) throw new Error('Remote transfer control message has an invalid ID.')
    const outgoing = this.outgoing.get(id)
    const incoming = this.incoming.get(id)
    switch (message.type) {
      case 'file:accept':
        outgoing?.accepted.resolve(true)
        return
      case 'file:reject':
        outgoing?.accepted.resolve(false)
        if (outgoing?.record.status === 'verifying') outgoing.verified.resolve(false)
        return
      case 'file:ack':
        if (!outgoing || !Number.isSafeInteger(message.nextSequence)) return
        if (outgoing.ack) outgoing.ack.resolve(message.nextSequence!)
        return
      case 'file:end':
        if (!incoming || !Number.isSafeInteger(message.size) || message.size !== incoming.size || incoming.transferred !== incoming.size || typeof message.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(message.sha256)) {
          if (incoming) await this.abortIncoming(incoming, 'File size or integrity metadata did not match.')
          this.sendControl({ type: 'file:failed', id, reason: 'File size or integrity metadata did not match.' })
          return
        }
        const rendererHash = hex(incoming.hash.digest())
        const expectedHash = message.sha256.toLowerCase()
        if (rendererHash !== expectedHash) {
          await this.abortIncoming(incoming, 'SHA-256 verification failed; partial file removed.')
          this.sendControl({ type: 'file:failed', id, reason: 'SHA-256 verification failed.' })
          this.handlers.onError('SHA-256 verification failed; the partial file was removed.')
          return
        }
        this.clearIncomingTimer(incoming)
        const result = await this.bridge.finishIncomingFile(incoming.token, expectedHash)
        this.incoming.delete(id)
        if (result.sha256.toLowerCase() !== expectedHash) throw new Error('Destination file hash verification failed.')
        if (result.cleanupWarning) this.handlers.onError(result.cleanupWarning)
        this.sendControl({ type: 'file:verified', id, sha256: result.sha256 })
        this.handlers.onTransfer({ id, name: incoming.name, size: incoming.size, transferred: incoming.size, direction: 'receiving', status: 'complete' })
        return
      case 'file:verified':
        if (outgoing && typeof message.sha256 === 'string') outgoing.verified.resolve(message.sha256.toLowerCase() === outgoing.expectedHash)
        return
      case 'file:cancel':
      case 'file:failed': {
        if (this.pendingOffers.has(id)) this.cancelledOffers.add(id)
        const remoteReason = typeof message.reason === 'string' ? message.reason.slice(0, 180) : ''
        if (incoming) await this.abortIncoming(incoming, remoteReason || 'Remote transfer was cancelled.')
        if (outgoing) {
          const remoteFailed = message.type === 'file:failed'
          outgoing.cancelled = !remoteFailed
          outgoing.reader?.cancel().catch(() => undefined)
          outgoing.accepted.resolve(false)
          outgoing.verified.resolve(false)
          outgoing.ack?.resolve(-1)
          this.updateRecord({ ...outgoing.record, status: remoteFailed ? 'failed' : 'cancelled', error: remoteFailed ? remoteReason || 'The receiver could not verify this file.' : undefined })
        }
        return
      }
      default:
        throw new Error('Remote peer sent an unsupported file-transfer command.')
    }
  }

  private async prepareIncomingOffer(id: string, name: string, size: number): Promise<void> {
    let file: IncomingFileHandle | null = null
    try {
      file = await this.handlers.onIncomingOffer(name, size)
      if (this.closed || this.cancelledOffers.delete(id)) {
        if (file) {
          try { await this.bridge.cancelIncomingFile(file.transferToken) }
          catch (error) { this.handlers.onError(`Could not remove the incomplete received file: ${transferError(error)}`) }
        }
        return
      }
      if (!file) {
        this.sendControl({ type: 'file:reject', id, reason: 'The destination was not approved.' })
        this.handlers.onTransfer({ id, name, size, transferred: 0, direction: 'receiving', status: 'cancelled' })
        return
      }
      const incoming: IncomingTransfer = { id, name: file.destinationName, size, token: file.transferToken, transferred: 0, nextSequence: 0, hash: sha256.create(), lastNotify: 0, idleTimer: null }
      this.incoming.set(id, incoming)
      this.refreshIncomingTimer(incoming)
      this.handlers.onTransfer({ id, name: incoming.name, size: incoming.size, transferred: 0, direction: 'receiving', status: 'transferring' })
      this.sendControl({ type: 'file:accept', id })
    } catch (error) {
      if (file) await this.bridge.cancelIncomingFile(file.transferToken).catch(() => undefined)
      if (!this.closed) {
        this.sendControl({ type: 'file:reject', id, reason: 'The destination could not be prepared.' })
        this.handlers.onTransfer({ id, name, size, transferred: 0, direction: 'receiving', status: 'failed', error: transferError(error) })
        this.handlers.onError(`Could not prepare the incoming file: ${transferError(error)}`)
      }
    } finally {
      this.pendingOffers.delete(id)
      this.cancelledOffers.delete(id)
    }
  }

  private async receiveFrame(frame: ArrayBuffer): Promise<void> {
    if (frame.byteLength < FRAME_HEADER_BYTES || frame.byteLength > FRAME_HEADER_BYTES + CHUNK_BYTES) throw new Error('Remote peer sent an invalid file chunk.')
    const bytes = new Uint8Array(frame)
    const id = hex(bytes.subarray(0, 16))
    const sequence = new DataView(frame).getUint32(16, false)
    const transfer = this.incoming.get(id)
    const chunk = bytes.subarray(FRAME_HEADER_BYTES)
    if (!transfer || sequence !== transfer.nextSequence || chunk.byteLength === 0 || transfer.transferred + chunk.byteLength > transfer.size) {
      throw new Error('Remote file chunk sequence or size is invalid.')
    }
    await this.bridge.writeIncomingFile(transfer.token, chunk)
    transfer.hash.update(chunk)
    transfer.transferred += chunk.byteLength
    transfer.nextSequence += 1
    this.refreshIncomingTimer(transfer)
    const now = Date.now()
    if (transfer.nextSequence % ACK_EVERY_CHUNKS === 0 || transfer.transferred === transfer.size) {
      this.sendControl({ type: 'file:ack', id, nextSequence: transfer.nextSequence })
    }
    if (now - transfer.lastNotify >= 100 || transfer.transferred === transfer.size) {
      transfer.lastNotify = now
      this.handlers.onTransfer({ id, name: transfer.name, size: transfer.size, transferred: transfer.transferred, direction: 'receiving', status: 'transferring' })
    }
  }

  private createFrame(id: string, sequence: number, chunk: Uint8Array): ArrayBuffer {
    const frame = new ArrayBuffer(FRAME_HEADER_BYTES + chunk.byteLength)
    const bytes = new Uint8Array(frame)
    for (let index = 0; index < 16; index++) bytes[index] = Number.parseInt(id.slice(index * 2, index * 2 + 2), 16)
    new DataView(frame).setUint32(16, sequence, false)
    bytes.set(chunk, FRAME_HEADER_BYTES)
    return frame
  }

  private async waitForBuffer(): Promise<void> {
    if (this.closed || this.channel.readyState !== 'open') throw new Error('Secure data channel closed during transfer.')
    if (this.channel.bufferedAmount <= MAX_BUFFERED_BYTES) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for data-channel backpressure.')) }, 30_000)
      const onLow = () => { cleanup(); resolve() }
      const onClose = () => { cleanup(); reject(new Error('Secure data channel closed during transfer.')) }
      const cleanup = () => {
        clearTimeout(timer)
        this.channel.removeEventListener('bufferedamountlow', onLow)
        this.channel.removeEventListener('close', onClose)
      }
      this.channel.addEventListener('bufferedamountlow', onLow, { once: true })
      this.channel.addEventListener('close', onClose, { once: true })
      if (this.channel.bufferedAmount <= MAX_BUFFERED_BYTES) onLow()
    })
  }

  private sendControl(message: ControlMessage): void {
    if (this.closed || this.channel.readyState !== 'open') return
    const json = JSON.stringify(message)
    if (new TextEncoder().encode(json).byteLength > MAX_CONTROL_BYTES) throw new Error('Transfer control message exceeds its size limit.')
    this.channel.send(json)
  }

  private refreshIncomingTimer(transfer: IncomingTransfer): void {
    this.clearIncomingTimer(transfer)
    transfer.idleTimer = setTimeout(() => {
      if (this.incoming.get(transfer.id) !== transfer) return
      void this.abortIncoming(transfer, 'Incoming file transfer timed out due to inactivity.').then(() => {
        this.sendControl({ type: 'file:failed', id: transfer.id, reason: 'Incoming transfer timed out.' })
      })
    }, INCOMING_IDLE_TIMEOUT_MS)
  }

  private clearIncomingTimer(transfer: IncomingTransfer): void {
    if (transfer.idleTimer) clearTimeout(transfer.idleTimer)
    transfer.idleTimer = null
  }

  private async abortIncoming(transfer: IncomingTransfer, reason: string): Promise<void> {
    this.clearIncomingTimer(transfer)
    this.incoming.delete(transfer.id)
    let error = reason.slice(0, 180)
    try { await this.bridge.cancelIncomingFile(transfer.token) }
    catch (failure) {
      error = `${error} Incomplete-file cleanup failed: ${transferError(failure)}`.slice(0, 240)
      this.handlers.onError(error)
    }
    this.handlers.onTransfer({ id: transfer.id, name: transfer.name, size: transfer.size, transferred: transfer.transferred, direction: 'receiving', status: 'failed', error })
  }

  private protocolFailure(message: string): void {
    if (this.closed) return
    this.handlers.onError(message)
    this.channel.close()
    void this.close()
  }

  private updateRecord(record: TransferRecord): void {
    const { error: _error, ...withoutError } = record
    this.handlers.onTransfer(record.error ? { ...withoutError, error: record.error } : withoutError)
  }
}
