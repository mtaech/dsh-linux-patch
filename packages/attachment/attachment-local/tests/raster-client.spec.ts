import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId, isAttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ChildProcess } from 'node:child_process'
import { encodeRasterFrame } from '../src/raster-protocol.ts'
import { RasterWorker } from '../src/raster-client.ts'
import type { DetectedImage } from '../src/raster-operations.ts'

/** Fixture entries: one file per reply strategy, selected by its module path. */
function fixture(mode: string): string {
  return fileURLToPath(new URL(`./fixtures/raster-worker-${mode}.mjs`, import.meta.url))
}

const detected: DetectedImage = {
  mediaType: 'image/png',
  width: 2,
  height: 3,
  animated: false,
  carriesMetadata: false,
  depth: 'uchar',
  space: 'srgb',
  hasAlpha: false,
}
const target = { width: 8, height: 8, maxBytes: 1024 }
const attachment = {
  data: new Uint8Array([5, 6, 7]),
  ref: {
    attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`),
    mediaType: 'image/png' as const,
    width: 16,
    height: 16,
    bytes: 3,
  },
}
const image = new Uint8Array([1, 2, 3, 4])
const workers: RasterWorker[] = []

/** Start one fixture worker the test owns; every case disposes what it starts. */
function worker(mode: string): RasterWorker {
  const client = new RasterWorker(process.execPath, fixture(mode), process.env)
  workers.push(client)
  return client
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map(client => client.dispose()))
})

describe('raster worker client', () => {
  it('returns the reported facts for probe and detect', async () => {
    const client = worker('ok')
    await expect(client.probeImage(image)).resolves.toEqual(detected)
    await expect(client.detectImage(image, { maxPixels: 10 })).resolves.toEqual(detected)
    await expect(client.detectImage(image)).resolves.toEqual(detected)
  })

  it('returns produced bytes beside the facts the worker reported', async () => {
    const client = worker('ok')
    const normalized = await client.normalizeImage(image, detected, { maxPixels: 16, maxDimension: 16, maxBytes: 1024 })
    expect([...normalized.data]).toEqual([...image].reverse())
    expect(normalized).toMatchObject({ mediaType: 'image/png', width: 2, height: 3 })
    const requested = await client.createRequestImage(attachment, target, false)
    expect([...requested.data]).toEqual([...attachment.data].reverse())
    expect(requested).toMatchObject({ mediaType: 'image/png', width: 2, height: 3 })
  })

  it('rejects with the attachment failure the worker reported by code', async () => {
    const failure = await worker('failure').probeImage(image).catch((error: unknown) => error)
    expect(isAttachmentError(failure)).toBe(true)
    expect(failure).toMatchObject({ code: 'INVALID_IMAGE', message: 'fixture rejected the image' })
  })

  it('keeps a foreign code as a plain error instead of a typed attachment failure', async () => {
    const failure = await worker('foreign-code').probeImage(image).catch((error: unknown) => error)
    expect(isAttachmentError(failure)).toBe(false)
    expect(failure).toMatchObject({ message: 'fixture failed with a foreign code' })
  })

  it('keeps an uncoded failure as a plain error', async () => {
    const failure = await worker('plain-failure').probeImage(image).catch((error: unknown) => error)
    expect(isAttachmentError(failure)).toBe(false)
    expect(failure).toMatchObject({ message: 'fixture failed without a code' })
  })

  it('rejects in-flight work when the worker exits', async () => {
    await expect(worker('crash').probeImage(image))
      .rejects.toThrow('attachment raster worker exited (code 7, signal null)')
  })

  it('fails the channel when the worker writes an unreadable frame', async () => {
    await expect(worker('garbage').probeImage(image)).rejects.toThrow('oversized section')
  })

  it('rejects a reply that cannot identify its request', async () => {
    await expect(worker('unreadable-reply').probeImage(image))
      .rejects.toThrow('attachment raster worker sent an unreadable reply')
  })

  it('rejects a successful reply that carries no result', async () => {
    await expect(worker('no-result').probeImage(image))
      .rejects.toThrow('attachment raster worker replied without a result')
  })

  it('rejects a result for a different operation', async () => {
    await expect(worker('wrong-op').probeImage(image))
      .rejects.toThrow('attachment raster worker returned an unexpected result')
    await expect(worker('probe-reply').detectImage(image))
      .rejects.toThrow('attachment raster worker returned an unexpected result')
    await expect(worker('probe-reply').normalizeImage(image, detected, { maxPixels: 16, maxDimension: 16, maxBytes: 1024 }))
      .rejects.toThrow('attachment raster worker returned an unexpected result')
    await expect(worker('probe-reply').createRequestImage(attachment, target, false))
      .rejects.toThrow('attachment raster worker returned an unexpected result')
  })

  it('describes a failure reply that carries no message', async () => {
    await expect(worker('empty-failure').probeImage(image))
      .rejects.toThrow('attachment raster operation failed')
  })

  it('ignores a reply addressed to an unknown request', async () => {
    await expect(worker('misidentified').probeImage(image)).resolves.toEqual(detected)
  })

  it('rejects a request made after disposal instead of starting another worker', async () => {
    const client = worker('ok')
    await client.dispose()
    await expect(client.probeImage(image)).rejects.toThrow('attachment raster worker was disposed')
  })

  it('disposes without a worker having started, and disposes once', async () => {
    const client = new RasterWorker(process.execPath, fixture('ok'), process.env)
    await client.dispose()
    await expect(client.dispose()).resolves.toBeUndefined()
  })

  it('kills a worker that ignores a closed channel', async () => {
    vi.useFakeTimers()
    try {
      const client = worker('ignore')
      await client.probeImage(image)
      const disposed = client.dispose()
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(disposed).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards worker diagnostics without touching the response stream', async () => {
    const written: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    try {
      const client = worker('diagnostic')
      await expect(client.probeImage(image)).resolves.toEqual(detected)
      await new Promise((resolve) => { setImmediate(resolve) })
      expect(written.join('')).toContain('fixture diagnostic line')
    } finally {
      spy.mockRestore()
    }
  })

  it('reports a missing worker executable through its pending request', async () => {
    const client = new RasterWorker(fileURLToPath(new URL('./fixtures/no-such-node', import.meta.url)),
      fixture('ok'), process.env)
    workers.push(client)
    await expect(client.probeImage(image)).rejects.toThrow(/ENOENT/u)
  })
})

/** A child process stand-in whose channel a test drives directly. */
function fakeChild(): { child: ChildProcess; stdin: PassThrough; stdout: PassThrough } {
  const child = new EventEmitter() as ChildProcess
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  // A non-piped stream: the client must tolerate handles that cannot be retained.
  const stderr = null
  // A real worker exits when its channel closes, and a real kill ends in an exit event.
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill: () => { child.emit('exit', 0, 'SIGKILL'); return true },
  })
  for (const ended of ['finish', 'close'] as const) {
    stdin.on(ended, () => { setImmediate(() => { child.emit('exit', 0, null) }) })
  }
  return { child, stdin, stdout }
}

describe('raster worker channel failures', () => {
  it('rejects in-flight requests when the channel itself errors', async () => {
    const { child, stdin } = fakeChild()
    stdin.destroy()
    const client = new RasterWorker('node', 'worker', process.env, () => child)
    const pending = client.probeImage(image)
    // The channel fails before the queued write runs, so nothing is left to reject for that id.
    stdin.emit('error', new Error('pipe broke'))
    await expect(pending).rejects.toThrow('pipe broke')
    await client.dispose()
  })

  it('ignores a failure reported by a worker it has already replaced', async () => {
    const children = [fakeChild(), fakeChild()]
    let started = 0
    const client = new RasterWorker('node', 'worker', process.env, () => {
      const next = children[started]
      started += 1
      if (next === undefined) throw new Error('no further fake child')
      return next.child
    })
    const first = client.probeImage(image)
    children[0]?.child.emit('exit', 1, null)
    await expect(first).rejects.toThrow('attachment raster worker exited (code 1, signal null)')
    const second = client.probeImage(image)
    // The replaced worker's late failure must not reject the request its successor owns.
    children[0]?.child.emit('error', new Error('stale worker failed'))
    expect(started).toBe(2)
    children[1]?.stdout.write(encodeRasterFrame({ id: 2, ok: true, result: { op: 'probeImage', detected } }))
    await expect(second).resolves.toEqual(detected)
    await client.dispose()
  })

  it('rejects a request whose write reaches a closed channel', async () => {
    const { child, stdin } = fakeChild()
    stdin.destroy()
    const client = new RasterWorker('node', 'worker', process.env, () => child)
    await expect(client.probeImage(image)).rejects.toThrow('attachment raster worker channel is closed')
    await client.dispose()
  })
})
