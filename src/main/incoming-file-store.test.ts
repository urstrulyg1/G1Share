import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IncomingFileStore } from './incoming-file-store'

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'opendesk-incoming-file-test-'))
  try { await run(directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('IncomingFileStore', () => {
  it('writes to a private temporary file, verifies it, and publishes without overwriting', async () => {
    await withTempDir(async directory => {
      const store = new IncomingFileStore()
      const destination = join(directory, 'received.bin')
      const bytes = Uint8Array.from({ length: 150_000 }, (_, index) => (index * 13 + 5) & 0xff)
      const incoming = await store.prepare(destination, bytes.byteLength)
      expect(incoming.destinationName).toBe('received.bin')
      expect(await readdir(directory)).toEqual([expect.stringMatching(/^\.opendesk-[0-9a-f-]+\.part$/i)])

      for (let offset = 0; offset < bytes.byteLength; offset += 16_384) {
        await store.write(incoming.transferToken, bytes.slice(offset, offset + 16_384))
      }
      await expect(store.finish(incoming.transferToken, digest(bytes))).resolves.toEqual({ sha256: digest(bytes) })
      expect(await readFile(destination)).toEqual(Buffer.from(bytes))
      expect(await readdir(directory)).toEqual(['received.bin'])
      await store.closeAll()
    })
  })

  it('rejects an existing destination and preserves its contents', async () => {
    await withTempDir(async directory => {
      const store = new IncomingFileStore()
      const destination = join(directory, 'already-here.txt')
      await writeFile(destination, 'do not replace')

      await expect(store.prepare(destination, 3)).rejects.toThrow('never overwrites')
      expect(await readFile(destination, 'utf8')).toBe('do not replace')
      expect(await readdir(directory)).toEqual(['already-here.txt'])
    })
  })

  it('handles concurrent IPC writes in sequence and rejects bytes beyond the declared size', async () => {
    await withTempDir(async directory => {
      const store = new IncomingFileStore()
      const incoming = await store.prepare(join(directory, 'bounded.bin'), 5)
      const first = store.write(incoming.transferToken, Uint8Array.from([1, 2, 3]))
      const second = store.write(incoming.transferToken, Uint8Array.from([4, 5, 6]))
      const results = await Promise.allSettled([first, second])
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
      await expect(store.finish(incoming.transferToken, digest(Uint8Array.from([1, 2, 3])))).rejects.toThrow('size or integrity metadata')
      expect(await readdir(directory)).toEqual([])
    })
  })

  it('removes temporary data on a checksum mismatch or user cancellation', async () => {
    await withTempDir(async directory => {
      const store = new IncomingFileStore()
      const rejected = await store.prepare(join(directory, 'rejected.bin'), 4)
      await store.write(rejected.transferToken, Uint8Array.from([1, 2, 3, 4]))
      await expect(store.finish(rejected.transferToken, '0'.repeat(64))).rejects.toThrow('SHA-256 verification failed')
      expect(await readdir(directory)).toEqual([])

      const cancelled = await store.prepare(join(directory, 'cancelled.bin'), 4)
      await store.write(cancelled.transferToken, Uint8Array.from([9, 8]))
      await store.cancel(cancelled.transferToken)
      expect(await readdir(directory)).toEqual([])
    })
  })

  it('does not replace a destination created while the transfer is in progress', async () => {
    await withTempDir(async directory => {
      const store = new IncomingFileStore()
      const destination = join(directory, 'raced.bin')
      const bytes = Uint8Array.from([4, 2])
      const incoming = await store.prepare(destination, bytes.length)
      await store.write(incoming.transferToken, bytes)
      await writeFile(destination, 'another local file')

      await expect(store.finish(incoming.transferToken, digest(bytes))).rejects.toThrow('created during the transfer')
      expect(await readFile(destination, 'utf8')).toBe('another local file')
      expect(await readdir(directory)).toEqual(['raced.bin'])
    })
  })

  it('validates destination paths and transfer sizes before creating temporary files', async () => {
    await withTempDir(async directory => {
      const store = new IncomingFileStore()
      await expect(store.prepare('relative.bin', 1)).rejects.toThrow('destination path is invalid')
      await expect(store.prepare(join(directory, 'too-large.bin'), 1024 * 1024 * 1024 + 1)).rejects.toThrow('1 GiB')
      expect(await readdir(directory)).toEqual([])
    })
  })
})
