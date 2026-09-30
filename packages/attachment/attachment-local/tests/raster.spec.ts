import { fileURLToPath } from 'node:url'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRequestImage,
  workerEntry,
  detectImage,
  disposeRaster,
  installRasterWorker,
  normalizeImage,
  probeImage,
  rasterWorkerRequired,
  unpackedSibling,
} from '../src/raster.ts'

const okFixture = fileURLToPath(new URL('./fixtures/raster-worker-ok.mjs', import.meta.url))

async function png(width = 8, height = 4): Promise<Uint8Array> {
  return new Uint8Array(await sharp({
    create: { width, height, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer())
}

afterEach(async () => {
  await disposeRaster()
})

describe('raster dispatch', () => {
  it('requires a worker process only for Electron on Linux', () => {
    const electron = { electron: '44.0.0' }
    expect(rasterWorkerRequired(electron, 'linux')).toBe(true)
    expect(rasterWorkerRequired(electron, 'darwin')).toBe(false)
    expect(rasterWorkerRequired(electron, 'win32')).toBe(false)
    expect(rasterWorkerRequired({}, 'linux')).toBe(false)
  })

  it('maps an archived entry to its unpacked sibling', () => {
    const packaged = '/opt/app/resources/app.asar/node_modules/pkg/lib/raster-worker.js'
    expect(unpackedSibling('/plain/lib/raster-worker.js')).toBeUndefined()
    expect(unpackedSibling(packaged))
      .toBe('/opt/app/resources/app.asar.unpacked/node_modules/pkg/lib/raster-worker.js')
  })

  it('resolves the built worker entry beside the module', () => {
    expect(workerEntry('file:///plain/lib/index.js', () => true)).toBe('/plain/lib/raster-worker.js')
    expect(() => workerEntry('file:///plain/lib/index.js', () => false)).toThrow(/requires the built worker entry/u)
  })

  it('resolves a packaged module to the worker entry the packaging step unpacks', () => {
    const packaged = 'file:///opt/app/resources/app.asar/node_modules/pkg/lib/index.js'
    const unpacked = '/opt/app/resources/app.asar.unpacked/node_modules/pkg/lib/raster-worker.js'
    expect(workerEntry(packaged, path => path === unpacked)).toBe(unpacked)
    // The archived copy is readable by Electron only, so its absence fails loudly.
    expect(() => workerEntry(packaged, () => false)).toThrow(/requires the unpacked worker entry/u)
  })

  it('runs in this process until a worker is installed', async () => {
    const data = await png()
    await expect(probeImage(data)).resolves.toMatchObject({ mediaType: 'image/png', width: 8, height: 4 })
    await expect(detectImage(data, { maxPixels: 64 })).resolves.toMatchObject({ width: 8 })
  })

  it('routes every operation to the installed worker', async () => {
    const worker = installRasterWorker(process.execPath, process.env, okFixture)
    expect(installRasterWorker(process.execPath, process.env, okFixture)).toBe(worker)
    const data = await png()
    // The fixture reports fixed 2x3 facts and reversed bytes, so its replies prove the route.
    await expect(probeImage(data)).resolves.toMatchObject({ mediaType: 'image/png', width: 2, height: 3 })
    await expect(detectImage(data)).resolves.toMatchObject({ width: 2 })
    const detected = await detectImage(data)
    const normalized = await normalizeImage(data, detected, { maxPixels: 64, maxDimension: 64, maxBytes: 4096 })
    expect([...normalized.data]).toEqual([...data].reverse())
    const requested = await createRequestImage({
      data,
      ref: {
        attachmentId: AttachmentId(`sha256:${'d'.repeat(64)}`),
        mediaType: 'image/png',
        width: 8,
        height: 4,
        bytes: data.byteLength,
      },
    }, { width: 4, height: 4, maxBytes: 4096 }, false)
    expect([...requested.data]).toEqual([...data].reverse())
  })

  it('returns to in-process work after disposal', async () => {
    const data = await png()
    installRasterWorker(process.execPath, process.env, okFixture)
    await disposeRaster()
    await expect(probeImage(data)).resolves.toMatchObject({ width: 8, height: 4 })
    await expect(disposeRaster()).resolves.toBeUndefined()
  })

  it('fails loudly when the built worker entry is missing beside the module', () => {
    expect(() => installRasterWorker(process.execPath)).toThrow(/requires the built worker entry/u)
  })
})
