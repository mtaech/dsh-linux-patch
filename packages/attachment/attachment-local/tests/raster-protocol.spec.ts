import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { RasterFrameDecoder, encodeRasterFrame } from '../src/raster-protocol.ts'

/** Collect decoded frames and the first protocol failure. */
function collector(): {
  frames: Array<{ json: string; binary: Buffer }>
  failures: Error[]
  decoder: RasterFrameDecoder
} {
  const frames: Array<{ json: string; binary: Buffer }> = []
  const failures: Error[] = []
  const decoder = new RasterFrameDecoder(
    (json, binary) => { frames.push({ json, binary }) },
    (error) => { failures.push(error) },
  )
  return { frames, failures, decoder }
}

describe('raster frame codec', () => {
  it('round-trips JSON facts and produced bytes through one frame', () => {
    const { frames, decoder } = collector()
    decoder.push(encodeRasterFrame({ id: 7, ok: true }, new Uint8Array([1, 2, 3])))
    expect(frames).toEqual([{ json: '{"id":7,"ok":true}', binary: Buffer.from([1, 2, 3]) }])
  })

  it('decodes frames that arrive in fragments and several frames per chunk', () => {
    const { frames, decoder } = collector()
    const first = encodeRasterFrame({ id: 1 }, new Uint8Array([9]))
    const second = encodeRasterFrame({ id: 2 })
    const joined = Buffer.concat([first, second])
    for (const byte of joined.subarray(0, 3)) decoder.push(Buffer.from([byte]))
    for (let offset = 3; offset < joined.byteLength; offset += 5) {
      decoder.push(joined.subarray(offset, Math.min(offset + 5, joined.byteLength)))
    }
    expect(frames.map(frame => frame.json)).toEqual(['{"id":1}', '{"id":2}'])
    expect(frames[1]?.binary.byteLength).toBe(0)
  })

  it('carries an empty binary section without dropping the JSON section', () => {
    const { frames, decoder } = collector()
    decoder.push(encodeRasterFrame({ id: 3 }))
    expect(frames).toEqual([{ json: '{"id":3}', binary: Buffer.alloc(0) }])
  })

  it('reports a declared section above the frame limit instead of allocating it', () => {
    const { failures, decoder } = collector()
    const frame = Buffer.alloc(4)
    frame.writeUInt32BE(0xffffffff, 0)
    decoder.push(frame)
    expect(failures.map(error => error.message)).toEqual(['attachment raster frame declares an oversized section'])
  })

  it('ignores every later chunk once the channel has failed', () => {
    const { frames, failures, decoder } = collector()
    const header = Buffer.alloc(4)
    header.writeUInt32BE(0xffffffff, 0)
    decoder.push(header)
    decoder.push(encodeRasterFrame({ id: 1 }))
    expect(failures).toHaveLength(1)
    expect(frames).toEqual([])
  })

  it('rejects a section above the limit at encode time', () => {
    expect(() => encodeRasterFrame({ big: true }, new Uint8Array(64 * 1024 * 1024 + 1)))
      .toThrow('attachment raster frame exceeds its size limit')
  })

  it('reports a non-Error decode failure through its message', () => {
    const failures: Error[] = []
    const decoder = new RasterFrameDecoder(() => { throw 'not an error' }, (error) => { failures.push(error) })
    decoder.push(encodeRasterFrame({ id: 1 }))
    expect(failures.map(error => error.message)).toEqual(['not an error'])
  })

  it('fails the channel when the frame consumer throws', () => {
    const failures: Error[] = []
    const decoder = new RasterFrameDecoder(() => { throw new Error('consumer rejected the frame') }, (error) => {
      failures.push(error)
    })
    decoder.push(encodeRasterFrame({ id: 1 }))
    expect(failures.map(error => error.message)).toEqual(['consumer rejected the frame'])
  })

  it('keeps decoder state isolated per instance', () => {
    const first = collector()
    const second = collector()
    first.decoder.push(encodeRasterFrame({ id: 1 }, new Uint8Array([1])))
    second.decoder.push(encodeRasterFrame({ id: 2 }, new Uint8Array([2])))
    expect(first.frames[0]?.json).toBe('{"id":1}')
    expect(second.frames[0]?.json).toBe('{"id":2}')
  })
})
