import { Buffer } from 'node:buffer'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import { PassThrough, Writable } from 'node:stream'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { rasterFailureReply, runRasterWorker } from '../src/raster-worker.ts'
import { RasterFrameDecoder, encodeRasterFrame } from '../src/raster-protocol.ts'
import type { RasterRequest, RasterResponse } from '../src/raster-protocol.ts'

const policy = { maxPixels: 2048 * 2048, maxDimension: 64, maxBytes: 4 * 1024 * 1024 }

async function png(width = 8, height = 4): Promise<Uint8Array> {
  return new Uint8Array(await sharp({
    create: { width, height, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
  }).png().toBuffer())
}

/**
 * Serve the given frames over in-memory streams and collect the worker's replies.
 * @param frames - encoded request frames, written before the input closes.
 * @returns replies decoded as the worker writes them, its diagnostics, and its exit code.
 */
async function serve(frames: readonly Buffer[]): Promise<{
  replies: RasterResponse[]
  binaries: Buffer[]
  diagnostics: string
  code: number
}> {
  const replies: RasterResponse[] = []
  const binaries: Buffer[] = []
  // A synchronous writable decodes each frame as it is written, so assertions need no extra tick.
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      decoder.push(chunk)
      callback()
    },
  })
  const decoder = new RasterFrameDecoder((json, binary) => {
    replies.push(JSON.parse(json) as RasterResponse)
    binaries.push(binary)
  }, () => {})
  const input = new PassThrough()
  const diagnostics = new PassThrough()
  let text = ''
  diagnostics.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
  const served = runRasterWorker(input, output, diagnostics)
  for (const frame of frames) input.write(frame)
  input.end()
  return { replies, binaries, diagnostics: text, code: await served }
}

function request(json: RasterRequest, data: Uint8Array): Buffer {
  return encodeRasterFrame(json, data)
}

describe('raster worker', () => {
  it('probes a submitted image without decoding its pixels', async () => {
    const { replies, code } = await serve([request({ id: 1, op: 'probeImage', data: new Uint8Array() }, await png())])
    expect(code).toBe(0)
    expect(replies).toEqual([{
      id: 1,
      ok: true,
      result: {
        op: 'probeImage',
        detected: {
          mediaType: 'image/png',
          width: 8,
          height: 4,
          animated: false,
          carriesMetadata: false,
          depth: 'uchar',
          space: 'srgb',
          hasAlpha: true,
        },
      },
    }])
  })

  it('decodes a submitted image and applies admission limits', async () => {
    const data = await png(16, 16)
    const accepted = await serve([request({ id: 1, op: 'detectImage', data: new Uint8Array(), limits: { maxPixels: 4096, maxDimension: 16 } }, data)])
    const rejected = await serve([request({ id: 2, op: 'detectImage', data: new Uint8Array(), limits: { maxPixels: 1 } }, data)])
    expect(accepted.replies[0]).toMatchObject({ id: 1, ok: true, result: { op: 'detectImage', detected: { width: 16, height: 16 } } })
    expect(rejected.replies[0]).toMatchObject({ id: 2, ok: false, code: 'IMAGE_TOO_MANY_PIXELS' })
  })

  it('normalizes submitted bytes and returns them beside their facts', async () => {
    const data = await png(32, 32)
    const detected = (await serve([request({ id: 0, op: 'detectImage', data: new Uint8Array() }, data)]))
      .replies[0]
    if (detected?.ok !== true || detected.result.op !== 'detectImage') throw new Error('detect reply was not usable')
    const { replies, binaries } = await serve([
      request({ id: 3, op: 'normalizeImage', detected: detected.result.detected, policy, data: new Uint8Array() }, data),
    ])
    expect(replies[0]).toMatchObject({ id: 3, ok: true, result: { op: 'normalizeImage', width: 32, height: 32 } })
    expect(binaries[0]?.byteLength).toBeGreaterThan(0)
  })

  it('produces request-image bytes for a stored attachment', async () => {
    const data = await png(32, 32)
    const { replies, binaries } = await serve([
      request({
        id: 4,
        op: 'createRequestImage',
        data: new Uint8Array(),
        ref: {
          attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
          mediaType: 'image/png',
          width: 32,
          height: 32,
          bytes: data.byteLength,
        },
        target: { width: 8, height: 8, maxBytes: 64 * 1024 },
        hasAlpha: true,
      }, data),
    ])
    expect(replies[0]).toMatchObject({ id: 4, ok: true, result: { op: 'createRequestImage', width: 8, height: 8 } })
    expect(binaries[0]?.byteLength).toBeGreaterThan(0)
  })

  it('reports malformed submitted bytes as an attachment failure', async () => {
    const { replies, diagnostics, code } = await serve([
      request({ id: 1, op: 'probeImage', data: new Uint8Array() }, Buffer.from('not an image')),
    ])
    expect(code).toBe(0)
    expect(replies[0]).toMatchObject({ id: 1, ok: false, code: 'INVALID_IMAGE' })
    expect(diagnostics).toBe('')
  })

  it('reports an unreadable operation without inventing an attachment code', async () => {
    const { replies } = await serve([encodeRasterFrame({ id: 5, op: 'unknown' }, new Uint8Array())])
    expect(replies[0]).toMatchObject({ id: 5, ok: false })
    expect(replies[0]).not.toHaveProperty('code')
  })

  it('diagnoses an unreadable frame on its diagnostics stream and exits 1', async () => {
    const { diagnostics, code, replies } = await serve([Buffer.from([0xff, 0xff, 0xff, 0xff])])
    expect(diagnostics).toContain('oversized section')
    expect(code).toBe(1)
    expect(replies).toEqual([])
  })

  it('reports a failed response channel and exits 1', async () => {
    const input = new PassThrough()
    const diagnostics = new PassThrough()
    let text = ''
    diagnostics.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
    const failing = new Writable({
      write(_chunk: Buffer, _encoding, callback) { callback(new Error('response pipe failed')) },
    })
    failing.on('error', () => {})
    const served = runRasterWorker(input, failing, diagnostics)
    input.write(encodeRasterFrame({ id: 1, op: 'probeImage' }, await png()))
    // The second response is dropped: a failed channel stops accepting frames.
    input.write(encodeRasterFrame({ id: 2, op: 'probeImage' }, await png()))
    input.end()
    expect(await served).toBe(1)
    expect(text).toContain('channel failed')
  })

  it('stops with a clean exit once its input ends', async () => {
    expect(await serve([])).toMatchObject({ code: 0, replies: [] })
  })

  it('waits for a full response stream before writing the next frame', async () => {
    const written: Buffer[] = []
    let release: (() => void) | undefined
    const held = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        written.push(chunk)
        // The first frame stays unacknowledged; later frames complete so the worker can finish.
        if (release === undefined) release = () => { callback() }
        else callback()
      },
    })
    const input = new PassThrough()
    const served = runRasterWorker(input, held, new PassThrough())
    input.write(encodeRasterFrame({ id: 1, op: 'probeImage' }, await png()))
    input.write(encodeRasterFrame({ id: 2, op: 'probeImage' }, await png()))
    input.end()
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(written).toHaveLength(1)
    release?.()
    expect(await served).toBe(0)
    expect(written).toHaveLength(2)
  })
})

describe('raster failure facts', () => {
  it('carries the attachment code of a typed failure', () => {
    expect(rasterFailureReply(new AttachmentError('bad image', 'INVALID_IMAGE')))
      .toEqual({ ok: false, code: 'INVALID_IMAGE', message: 'bad image' })
  })

  it('describes a thrown value that is not an Error', () => {
    expect(rasterFailureReply('thrown string')).toEqual({ ok: false, message: 'thrown string' })
  })
})
