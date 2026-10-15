import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { IncomingFileHandle, OpenDeskBridge } from '../../../shared/types'
import { FileTransferManager } from './file-transfer'
import type { TransferRecord } from './file-transfer'

class FakeDataChannel extends EventTarget {
  binaryType: BinaryType = 'arraybuffer'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  readyState: RTCDataChannelState = 'open'
  peer: FakeDataChannel | null = null
  corruptEndHash = false

  send(value: string | ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error('channel is closed')
    let data: string | ArrayBuffer = typeof value === 'string' ? value : value.slice(0)
    if (this.corruptEndHash && typeof data === 'string') {
      const message = JSON.parse(data) as { type?: string; sha256?: string }
      if (message.type === 'file:end' && message.sha256) {
        message.sha256 = '0'.repeat(64)
        data = JSON.stringify(message)
      }
    }
    const target = this.peer
    if (target) queueMicrotask(() => target.dispatchEvent(new MessageEvent('message', { data })))
  }

  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
    if (this.peer?.readyState !== 'closed') {
      this.peer!.readyState = 'closed'
      this.peer!.dispatchEvent(new Event('close'))
    }
  }
}

function linkedChannels(): [FakeDataChannel, FakeDataChannel] {
  const left = new FakeDataChannel()
  const right = new FakeDataChannel()
  left.peer = right
  right.peer = left
  return [left, right]
}

function createFileBridge() {
  const disk = new Map<string, { size: number; chunks: Uint8Array[] }>()
  const cancelled: string[] = []
  let nextToken = 0
  const bridge: Pick<OpenDeskBridge, 'prepareIncomingFile' | 'writeIncomingFile' | 'finishIncomingFile' | 'cancelIncomingFile'> = {
    prepareIncomingFile: async ({ name, size }) => {
      const transferToken = `file-token-${++nextToken}`
      disk.set(transferToken, { size, chunks: [] })
      return { transferToken, destinationName: name } satisfies IncomingFileHandle
    },
    writeIncomingFile: async (transferToken, chunk) => {
      const file = disk.get(transferToken)
      if (!file) throw new Error('missing sink')
      file.chunks.push(chunk.slice())
    },
    finishIncomingFile: async (transferToken, expectedSHA256) => {
      const file = disk.get(transferToken)
      if (!file) throw new Error('missing sink')
      const bytes = Buffer.concat(file.chunks.map(chunk => Buffer.from(chunk)))
      if (bytes.length !== file.size) throw new Error('received size mismatch')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (sha256 !== expectedSHA256) throw new Error('hash mismatch')
      return { sha256 }
    },
    cancelIncomingFile: async transferToken => {
      cancelled.push(transferToken)
      disk.delete(transferToken)
    }
  }
  return { bridge, disk, cancelled }
}

function createManager(
  channel: FakeDataChannel,
  bridge: ReturnType<typeof createFileBridge>['bridge'],
  options: { accept?: boolean; allowFiles?: boolean; allowClipboard?: boolean; transfers?: TransferRecord[]; errors?: string[]; clipboardTexts?: string[] } = {}
): FileTransferManager {
  return new FileTransferManager(channel as unknown as RTCDataChannel, bridge, {
    allowFiles: options.allowFiles ?? true,
    allowClipboard: options.allowClipboard ?? false,
    onIncomingOffer: async (name, size) => options.accept === false ? null : bridge.prepareIncomingFile({ name, size }),
    onClipboardText: async text => { options.clipboardTexts?.push(text) },
    onTransfer: transfer => options.transfers?.unshift(transfer),
    onError: message => options.errors?.push(message)
  })
}

function storedBytes(disk: Map<string, { size: number; chunks: Uint8Array[] }>): Buffer {
  const [file] = disk.values()
  return Buffer.concat(file.chunks.map(chunk => Buffer.from(chunk)))
}

describe('FileTransferManager', () => {
  it('transfers large files in bounded chunks and verifies SHA-256 at the receiver', async () => {
    const [senderChannel, receiverChannel] = linkedChannels()
    const receiverDisk = createFileBridge()
    const senderTransfers: TransferRecord[] = []
    const receiverTransfers: TransferRecord[] = []
    const senderErrors: string[] = []
    const sender = createManager(senderChannel, createFileBridge().bridge, { transfers: senderTransfers, errors: senderErrors })
    const receiver = createManager(receiverChannel, receiverDisk.bridge, { transfers: receiverTransfers })
    const bytes = Uint8Array.from({ length: 300 * 1024 + 37 }, (_, index) => (index * 31 + 17) & 0xff)
    const source = new File([bytes], 'bounded-payload.bin', { type: 'application/octet-stream' })

    await sender.sendFiles([source])

    expect(senderErrors).toEqual([])
    expect(receiverDisk.disk.size).toBe(1)
    expect(storedBytes(receiverDisk.disk)).toEqual(Buffer.from(bytes))
    expect(senderTransfers[0].status).toBe('complete')
    expect(receiverTransfers.find(record => record.direction === 'receiving')?.status).toBe('complete')
    expect(senderTransfers[0].transferred).toBe(source.size)
    await Promise.all([sender.close(), receiver.close()])
  })

  it('cancels a partial destination and reports checksum mismatch', async () => {
    const [senderChannel, receiverChannel] = linkedChannels()
    senderChannel.corruptEndHash = true
    const receiverDisk = createFileBridge()
    const senderTransfers: TransferRecord[] = []
    const receiverErrors: string[] = []
    const sender = createManager(senderChannel, createFileBridge().bridge, { transfers: senderTransfers })
    const receiver = createManager(receiverChannel, receiverDisk.bridge, { errors: receiverErrors })
    const source = new File([Uint8Array.from({ length: 128_000 }, (_, index) => index & 0xff)], 'integrity.bin')

    await sender.sendFiles([source])

    expect(receiverDisk.cancelled).toHaveLength(1)
    expect(receiverDisk.disk.size).toBe(0)
    expect(receiverErrors.some(message => message.includes('SHA-256'))).toBe(true)
    expect(senderTransfers[0].status).toBe('failed')
    await Promise.all([sender.close(), receiver.close()])
  })

  it('does not transfer when the remote destination is declined', async () => {
    const [senderChannel, receiverChannel] = linkedChannels()
    const senderTransfers: TransferRecord[] = []
    const sender = createManager(senderChannel, createFileBridge().bridge, { transfers: senderTransfers })
    const receiver = createManager(receiverChannel, createFileBridge().bridge, { accept: false })
    await sender.sendFiles([new File(['secret bytes'], 'private.txt')])
    expect(senderTransfers[0].status).toBe('failed')
    expect(senderTransfers[0].error).toContain('declined')
    await Promise.all([sender.close(), receiver.close()])
  })

  it('transfers one-time clipboard text only when both session sides allow it', async () => {
    const [senderChannel, receiverChannel] = linkedChannels()
    const received: string[] = []
    const sender = createManager(senderChannel, createFileBridge().bridge, { allowClipboard: true })
    const receiver = createManager(receiverChannel, createFileBridge().bridge, { allowClipboard: true, clipboardTexts: received })
    const text = 'Shared once: 東京 €'

    sender.sendClipboardText(text)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(received).toEqual([text])
    expect(() => sender.sendClipboardText('€'.repeat(11_000))).toThrow('32 KiB')
    await Promise.all([sender.close(), receiver.close()])
  })

  it('rejects clipboard messages when the receiver permission was not approved', async () => {
    const [senderChannel, receiverChannel] = linkedChannels()
    const receiverErrors: string[] = []
    const sender = createManager(senderChannel, createFileBridge().bridge, { allowClipboard: true })
    const receiver = createManager(receiverChannel, createFileBridge().bridge, { errors: receiverErrors })
    sender.sendClipboardText('must not be applied')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(receiverErrors).toContain('Remote clipboard message is unauthorized or exceeds the size limit.')
    await Promise.all([sender.close(), receiver.close()])
  })

  it('enforces the session file permission before sending or accepting files', async () => {
    const [senderChannel, receiverChannel] = linkedChannels()
    const sender = createManager(senderChannel, createFileBridge().bridge, { allowFiles: false })
    const receiver = createManager(receiverChannel, createFileBridge().bridge, { allowFiles: false })
    await expect(sender.sendFiles([new File(['x'], 'x.txt')])).rejects.toThrow('permission was not approved')
    await Promise.all([sender.close(), receiver.close()])
  })

  it('cleans up a destination when cancellation arrives during the approval prompt', async () => {
    const [senderChannel, receiverChannel] = linkedChannels()
    const receiverDisk = createFileBridge()
    const senderTransfers: TransferRecord[] = []
    let resolvePrompt!: (handle: IncomingFileHandle) => void
    const prompt = new Promise<IncomingFileHandle>(resolve => { resolvePrompt = resolve })
    const sender = createManager(senderChannel, createFileBridge().bridge, { transfers: senderTransfers })
    const receiver = new FileTransferManager(receiverChannel as unknown as RTCDataChannel, receiverDisk.bridge, {
      allowFiles: true,
      allowClipboard: false,
      onIncomingOffer: async () => prompt,
      onClipboardText: async () => undefined,
      onTransfer: () => undefined,
      onError: () => undefined
    })
    const sendPromise = sender.sendFiles([new File(['transfer data'], 'cancel-me.txt')])
    await new Promise(resolve => setTimeout(resolve, 0))
    const transferId = senderTransfers[0].id
    sender.cancel(transferId)
    await new Promise(resolve => setTimeout(resolve, 0))
    const destination = await receiverDisk.bridge.prepareIncomingFile({ name: 'cancel-me.txt', size: 13 })
    if (!destination) throw new Error('test destination was not prepared')
    resolvePrompt(destination)
    await sendPromise
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(senderTransfers[0].status).toBe('cancelled')
    expect(receiverDisk.disk.size).toBe(0)
    expect(receiverDisk.cancelled).toEqual(['file-token-1'])
    await Promise.all([sender.close(), receiver.close()])
  })
})
