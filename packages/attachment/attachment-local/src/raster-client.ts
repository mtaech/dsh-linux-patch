/** Host side of the raster worker channel. @module @deepseek-ai/dsh-attachment-local/raster-client */

import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { isAttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageRequestTarget, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { RasterFrameDecoder, encodeRasterFrame } from './raster-protocol.ts'
import type { RasterRequestJson, RasterResult } from './raster-protocol.ts'
import type {
  DecodedImageLimits,
  DetectedImage,
  EncodedRequestImage,
  NormalizationPolicy,
  NormalizedImage,
  RasterRunner,
} from './raster-operations.ts'

/** Grace a worker receives to finish queued frames before it is killed during disposal. */
const WORKER_EXIT_TIMEOUT_MS = 5_000

interface PendingRequest {
  /** Worker that owns this request; a replaced worker's failures leave it alone. */
  child: ChildProcess
  resolve(result: RasterResult, binary: Uint8Array): void
  reject(error: unknown): void
}

/** Whether one child handle can retain this process's event loop. */
function retainsLoop(value: object): value is { ref(): void } {
  return 'ref' in value
}

/** Whether one child handle can release this process's event loop. */
function releasesLoop(value: object): value is { unref(): void } {
  return 'unref' in value
}

/**
 * Release or retain this process's event loop for one worker.
 *
 * An idle worker must not keep a short-lived host — a one-shot CLI run or a
 * startup check — alive after its last request, while a request in flight must
 * keep the process running until the reply arrives. Worker stdio arrives as
 * sockets, which expose their own `ref`/`unref`; a non-piped stream has none.
 * @param child - worker whose handles change retention.
 * @param referenced - whether the worker may keep this process alive.
 */
function setWorkerReferenced(child: ChildProcess, referenced: boolean): void {
  for (const handle of [child, child.stdin, child.stdout, child.stderr]) {
    if (handle === null) continue
    if (referenced && retainsLoop(handle)) handle.ref()
    else if (!referenced && releasesLoop(handle)) handle.unref()
  }
}

/** Environment names a raster worker inherits; credentials and host loader flags stay out. */
const WORKER_ENVIRONMENT_NAMES = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR'] as const

/**
 * Run raster operations in a plain Node process.
 *
 * Sharp's prebuilt Linux binaries interpose symbols leaked by Electron's
 * process-space GLib, so image decoding inside an Electron host process
 * crashes; the worker keeps those binaries in a process that never loads
 * Electron. See https://github.com/electron/electron/issues/46323.
 */
export class RasterWorker implements RasterRunner {
  private child: ChildProcess | undefined
  private decoder: RasterFrameDecoder | undefined
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private writes: Promise<void> = Promise.resolve()
  private inFlight = 0
  private disposed = false

  /**
   * @param node - absolute plain Node executable that runs the worker.
   * @param worker - absolute worker script path readable by that executable.
   * @param environment - host environment the worker's own variables are selected from.
   * @param launch - process launcher for the worker; defaults to this runtime's own spawn.
   */
  constructor(
    private readonly node: string,
    private readonly worker: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly launch: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess = spawn,
  ) {}

  async probeImage(data: Uint8Array): Promise<DetectedImage> {
    const { result } = await this.request({ op: 'probeImage' }, data)
    if (result.op !== 'probeImage') throw new Error('attachment raster worker returned an unexpected result')
    return result.detected
  }

  async detectImage(data: Uint8Array, limits?: DecodedImageLimits): Promise<DetectedImage> {
    const { result } = await this.request({ op: 'detectImage', ...(limits === undefined ? {} : { limits }) }, data)
    if (result.op !== 'detectImage') throw new Error('attachment raster worker returned an unexpected result')
    return result.detected
  }

  async normalizeImage(
    data: Uint8Array,
    detected: DetectedImage,
    policy: NormalizationPolicy,
  ): Promise<NormalizedImage> {
    const { result, binary } = await this.request({ op: 'normalizeImage', detected, policy }, data)
    if (result.op !== 'normalizeImage') throw new Error('attachment raster worker returned an unexpected result')
    return { data: binary, mediaType: result.mediaType, width: result.width, height: result.height }
  }

  async createRequestImage(
    attachment: StoredImageAttachment,
    target: ImageRequestTarget,
    hasAlpha: boolean,
  ): Promise<EncodedRequestImage> {
    const { result, binary } = await this.request(
      { op: 'createRequestImage', ref: attachment.ref, target, hasAlpha },
      attachment.data,
    )
    if (result.op !== 'createRequestImage') throw new Error('attachment raster worker returned an unexpected result')
    return { data: binary, mediaType: result.mediaType, width: result.width, height: result.height }
  }

  /**
   * Stop the worker and resolve only after it has exited.
   * @returns completion after the process is gone; a worker that ignores the closing
   *   stdin is killed once {@link WORKER_EXIT_TIMEOUT_MS} elapses.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    this.child = undefined
    this.rejectAll(new Error('attachment raster worker stopped'))
    if (child === undefined) return
    const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
    child.stdin?.end()
    const timer = setTimeout(() => { child.kill('SIGKILL') }, WORKER_EXIT_TIMEOUT_MS)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  }

  private async request(json: RasterRequestJson, data: Uint8Array): Promise<{ result: RasterResult; binary: Uint8Array }> {
    if (this.disposed) throw new Error('attachment raster worker was disposed')
    const child = this.start()
    const id = this.nextId
    this.nextId += 1
    const settled = new Promise<{ result: RasterResult; binary: Uint8Array }>((resolve, reject) => {
      this.pending.set(id, {
        child,
        resolve: (result, binary) => { resolve({ result, binary }) },
        reject,
      })
    })
    this.inFlight += 1
    setWorkerReferenced(child, true)
    const frame = encodeRasterFrame({ ...json, id }, data)
    this.writes = this.writes.then(async () => {
      if (child.stdin === null || child.stdin.destroyed) throw new Error('attachment raster worker channel is closed')
      if (!child.stdin.write(frame)) {
        await new Promise<void>((resolve) => { child.stdin?.once('drain', resolve) })
      }
    }).catch((error: unknown) => {
      this.reject(id, error)
    })
    return settled.finally(() => { this.releaseLoop() })
  }

  private start(): ChildProcess {
    const child = this.child
    if (child !== undefined) return child
    const started = this.launch(this.node, [this.worker], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...Object.fromEntries(WORKER_ENVIRONMENT_NAMES.flatMap((name) => {
          const value = this.environment[name]
          return value === undefined ? [] : [[name, value]]
        })),
        // Host loader and inspector flags must not reach the worker's own module resolution.
        NODE_OPTIONS: '',
      },
    })
    started.stdout?.on('data', this.onData)
    // A worker that closes its side of the channel leaves writes to fail asynchronously.
    started.stdin?.on('error', (error: unknown) => { this.rejectFrom(started, error) })
    started.stderr?.setEncoding('utf8')
    started.stderr?.on('data', (chunk: string) => {
      process.stderr.write(`attachment raster worker: ${chunk}`)
    })
    started.once('exit', (code, signal) => {
      if (this.child === started) this.child = undefined
      this.rejectFrom(started, new Error(`attachment raster worker exited (code ${String(code)}, signal ${String(signal)})`))
    })
    started.once('error', (error) => {
      if (this.child === started) this.child = undefined
      this.rejectFrom(started, error)
    })
    this.decoder = new RasterFrameDecoder((jsonText, binary) => { this.onFrame(jsonText, binary) }, (error) => {
      this.rejectAll(error)
      started.kill('SIGKILL')
    })
    this.child = started
    // An idle worker never holds this process open; each request retains it again.
    setWorkerReferenced(started, false)
    return started
  }

  private readonly onData = (chunk: Buffer): void => { this.decoder?.push(chunk) }

  private onFrame(jsonText: string, binary: Buffer): void {
    const message = JSON.parse(jsonText) as { id?: unknown; ok?: unknown; result?: unknown; code?: unknown; message?: unknown }
    if (typeof message.id !== 'number' || typeof message.ok !== 'boolean') {
      throw new Error('attachment raster worker sent an unreadable reply')
    }
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    if (message.ok) {
      if (message.result === undefined) {
        pending.reject(new Error('attachment raster worker replied without a result'))
        return
      }
      pending.resolve(message.result as RasterResult, new Uint8Array(binary))
      return
    }
    const detail = typeof message.message === 'string' ? message.message : 'attachment raster operation failed'
    // The worker reports typed attachment failures by code; frame contents are unvalidated, so a
    // code outside the published set stays a plain error instead of impersonating a typed failure.
    const failure = Object.assign(new Error(detail), { name: 'AttachmentError', code: message.code })
    pending.reject(isAttachmentError(failure) ? failure : new Error(detail))
  }

  private reject(id: number, error: unknown): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    pending.reject(error)
  }

  /** Release this process's event loop once no request is pending. */
  private releaseLoop(): void {
    this.inFlight -= 1
    if (this.inFlight > 0 || this.child === undefined) return
    setWorkerReferenced(this.child, false)
  }

  /** Reject the requests one worker owns, leaving a replacement worker's requests pending. */
  private rejectFrom(child: ChildProcess, error: unknown): void {
    for (const [id, request] of [...this.pending]) {
      if (request.child !== child) continue
      this.pending.delete(id)
      request.reject(error)
    }
  }

  private rejectAll(error: unknown): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const request of pending) request.reject(error)
  }
}
