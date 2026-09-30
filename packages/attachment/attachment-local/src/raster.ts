/** Raster dispatch: run Sharp in this process or in a plain-Node worker. @module @deepseek-ai/dsh-attachment-local/raster */

import { existsSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RasterWorker } from './raster-client.ts'
import * as operations from './raster-operations.ts'
import type { RasterRunner } from './raster-operations.ts'

/** Worker entry built beside this module by the package's own build. */
const WORKER_FILENAME = 'raster-worker.js'

/**
 * Physical sibling of one archived path.
 *
 * A packaged Electron host reads this package from `app.asar` through its own
 * ASAR layer, which no other process can use; the packaging step unpacks the
 * files a plain Node child opens into `app.asar.unpacked` beside the archive.
 * @param resolved - absolute path that may contain an `app.asar` segment.
 * @returns the `app.asar.unpacked` sibling path, or undefined for a real path.
 */
export function unpackedSibling(resolved: string): string | undefined {
  const marker = `${sep}app.asar${sep}`
  const index = resolved.indexOf(marker)
  if (index === -1) return undefined
  return `${resolved.slice(0, index)}${sep}app.asar.unpacked${sep}${resolved.slice(index + marker.length)}`
}

/**
 * Absolute worker entry a plain Node child can open.
 * @param moduleUrl - `import.meta.url` of the built module that needs the entry.
 * @param exists - existence probe for candidate paths.
 * @returns absolute path of the worker entry.
 * @throws when the built entry, or the unpacked copy a packaged host needs, is missing.
 */
export function workerEntry(moduleUrl: string, exists: (path: string) => boolean): string {
  const resolved = fileURLToPath(new URL(`./${WORKER_FILENAME}`, moduleUrl))
  const packaged = unpackedSibling(resolved)
  if (packaged !== undefined) {
    if (exists(packaged)) return packaged
    throw new Error(`attachment-local: rasterWorker requires the unpacked worker entry, missing ${packaged}`)
  }
  if (exists(resolved)) return resolved
  throw new Error(`attachment-local: rasterWorker requires the built worker entry, missing ${resolved}`)
}

/** Worker entry beside this module, resolved through {@link workerEntry}. */
function workerScriptPath(): string {
  return workerEntry(import.meta.url, existsSync)
}

let runner: RasterRunner = operations
let worker: RasterWorker | undefined
let refusal: string | undefined

/**
 * Whether this process must run raster work elsewhere.
 *
 * Electron links the system GLib and leaks its symbols into the process space,
 * where they interpose the GLib that Sharp's prebuilt libvips links statically;
 * decoding any image then crashes the process. Only Electron on Linux links
 * that way, so every other runtime keeps the in-process path.
 * @param versions - runtime version facts; defaults to this process.
 * @param platform - runtime platform; defaults to this process.
 * @returns whether raster work needs a separate plain-Node process.
 */
export function rasterWorkerRequired(
  versions: Readonly<Partial<NodeJS.ProcessVersions>> = process.versions,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return versions.electron !== undefined && platform === 'linux'
}

/**
 * Run raster work in a plain Node worker.
 * @param node - absolute plain Node executable.
 * @param environment - host environment the worker's variables are selected from.
 * @param script - absolute worker entry; defaults to the built entry beside this module.
 * @returns the worker for direct disposal; later dispatches stay routed to it.
 */
export function installRasterWorker(
  node: string,
  environment: NodeJS.ProcessEnv = process.env,
  script: string = workerScriptPath(),
): RasterWorker {
  refusal = undefined
  if (worker !== undefined) return worker
  worker = new RasterWorker(node, script, environment)
  runner = worker
  return worker
}

/**
 * Stop the worker and restore in-process raster work.
 * @returns completion once the worker process has exited.
 */
export async function disposeRaster(): Promise<void> {
  const running = worker
  worker = undefined
  runner = operations
  refusal = undefined
  await running?.dispose()
}

/**
 * Refuse raster work in this process with an actionable reason.
 *
 * A host that must not load Sharp in-process but has no plain Node executable
 * keeps mounting — non-image attachments stay usable — and fails every raster
 * operation with this reason instead of crashing the process.
 * @param reason - why this host cannot run raster work in its own process.
 */
export function refuseRasterWork(reason: string): void {
  refusal = reason
}

/** Resolve the configured runner, failing loudly when this host refused raster work. */
function activeRunner(): RasterRunner {
  if (refusal !== undefined) throw new Error(refusal)
  return runner
}

/**
 * Parse a supported raster's header without decoding pixels.
 * @param data - complete encoded image bytes.
 * @returns verified format and dimensions.
 */
export async function probeImage(data: Uint8Array): Promise<operations.DetectedImage> {
  return await activeRunner().probeImage(data)
}

/**
 * Fully decode a supported raster.
 * @param data - complete encoded image bytes.
 * @param limits - intrinsic-dimension admission limits.
 * @returns verified format and dimensions.
 */
export async function detectImage(
  data: Uint8Array,
  limits?: operations.DecodedImageLimits,
): Promise<operations.DetectedImage> {
  return await activeRunner().detectImage(data, limits)
}

/**
 * Produce the provider-independent normalized form of one decoded source.
 * @param data - complete admitted source bytes.
 * @param detected - fully decoded source facts.
 * @param policy - resolved independent normalization limits.
 * @returns verified provider-independent normalized bytes and metadata.
 */
export async function normalizeImage(
  data: Uint8Array,
  detected: operations.DetectedImage,
  policy: operations.NormalizationPolicy,
): Promise<operations.NormalizedImage> {
  return await activeRunner().normalizeImage(data, detected, policy)
}

/**
 * Transform one stored normalized attachment into the encoded model-request form.
 * @param attachment - durable normalized attachment bytes and reference.
 * @param target - route-chosen request dimensions and byte target.
 * @param hasAlpha - decoded source alpha fact selecting the ladder codec.
 * @returns encoded request bytes at the first ladder quality within the byte target.
 */
export async function createRequestImage(
  attachment: Parameters<RasterRunner['createRequestImage']>[0],
  target: Parameters<RasterRunner['createRequestImage']>[1],
  hasAlpha: boolean,
): Promise<operations.EncodedRequestImage> {
  return await activeRunner().createRequestImage(attachment, target, hasAlpha)
}
