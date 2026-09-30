/** Raster worker: runs Sharp in a plain Node process. @module @deepseek-ai/dsh-attachment-local/raster-worker */

import { once } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { AttachmentErrorCode } from '@deepseek-ai/dsh-attachment'
import * as operations from './raster-operations.ts'
import { RasterFrameDecoder, encodeRasterFrame } from './raster-protocol.ts'
import type { RasterRequest, RasterResponse, RasterResult } from './raster-protocol.ts'

interface OperationOutput {
  result: RasterResult
  binary?: Uint8Array
}

/** Attachment failure facts the host rebuilds a typed error from. */
interface FailureReply {
  ok: false
  code?: AttachmentErrorCode
  message: string
}

/**
 * Convert a failed operation into the facts its reply carries.
 * @param error - value thrown by one raster operation.
 * @returns reply facts carrying the attachment code when the failure has one.
 */
export function rasterFailureReply(error: unknown): FailureReply {
  return {
    ok: false,
    ...(error instanceof AttachmentError ? { code: error.code } : {}),
    message: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Execute one raster operation.
 * @param request - decoded request facts and the submitted image bytes.
 * @returns the operation's facts plus any produced bytes.
 */
export async function runRasterOperation(request: RasterRequest): Promise<OperationOutput> {
  switch (request.op) {
    case 'probeImage': {
      return { result: { op: 'probeImage', detected: await operations.probeImage(request.data) } }
    }
    case 'detectImage': {
      return { result: { op: 'detectImage', detected: await operations.detectImage(request.data, request.limits) } }
    }
    case 'normalizeImage': {
      const normalized = await operations.normalizeImage(request.data, request.detected, request.policy)
      return {
        result: {
          op: 'normalizeImage',
          mediaType: normalized.mediaType,
          width: normalized.width,
          height: normalized.height,
        },
        binary: normalized.data,
      }
    }
    case 'createRequestImage': {
      const encoded = await operations.createRequestImage(
        { data: request.data, ref: request.ref },
        request.target,
        request.hasAlpha,
      )
      return {
        result: {
          op: 'createRequestImage',
          mediaType: encoded.mediaType,
          width: encoded.width,
          height: encoded.height,
        },
        binary: encoded.data,
      }
    }
  }
}

/** Ordered frame writes that respect stream backpressure until the channel fails. */
class FrameWriter {
  private pending: Promise<void> = Promise.resolve()
  private readonly abort = new AbortController()
  private broken = false

  constructor(private readonly output: Writable, private readonly report: (error: unknown) => void) {
    output.on('error', (error: Error) => { this.fail(error) })
    output.on('close', () => { this.fail(new Error('attachment raster worker response channel closed')) })
  }

  /** Whether the channel can no longer carry frames. */
  get channelFailed(): boolean {
    return this.broken
  }

  /** Mark the channel unusable, release pending waits, and report why. */
  fail(error: unknown): void {
    this.broken = true
    this.abort.abort()
    this.report(error)
  }

  /** Queue one response frame; a failed channel stops writes instead of rejecting them. */
  send(response: RasterResponse, binary?: Uint8Array): void {
    if (this.broken) return
    this.pending = this.pending.then(async () => {
      if (this.output.write(encodeRasterFrame(response, binary))) return
      // A closed channel never drains, so waiting for backpressure ends with the channel.
      await once(this.output, 'drain', { signal: this.abort.signal })
    }).catch((error: unknown) => { this.fail(error) })
  }

  /** Resolve when every queued frame is written. */
  settled(): Promise<void> {
    return this.pending
  }
}

/**
 * Serve raster requests until the input stream ends.
 * @param input - frame stream of requests.
 * @param output - frame stream of responses.
 * @param diagnostics - human-readable failure destination; never the response stream.
 * @returns the process exit code: 1 for a channel failure, otherwise 0.
 */
export async function runRasterWorker(input: Readable, output: Writable, diagnostics: Writable): Promise<number> {
  const writer = new FrameWriter(output, (error: unknown) => {
    diagnostics.write(`attachment raster worker: channel failed: ${String(error)}\n`)
  })
  const queue: RasterRequest[] = []
  let running: Promise<void> = Promise.resolve()
  const pump = async (): Promise<void> => {
    for (let request = queue.shift(); request !== undefined; request = queue.shift()) {
      try {
        const executed = await runRasterOperation(request)
        writer.send({ id: request.id, ok: true, result: executed.result }, executed.binary)
      } catch (error) {
        writer.send({ id: request.id, ...rasterFailureReply(error) })
      }
    }
  }
  const decoder = new RasterFrameDecoder((jsonText, binary) => {
    // Requests queue behind the running pump, so responses keep request order.
    queue.push({ ...(JSON.parse(jsonText) as RasterRequest), data: new Uint8Array(binary) })
    running = running.then(pump)
  }, (error) => {
    writer.fail(error)
    input.destroy()
  })
  await new Promise<void>((resolve) => {
    input.on('data', (chunk: Buffer) => { decoder.push(chunk) })
    input.on('end', resolve)
    // A channel failure destroys the input, which reports neither end nor error.
    input.on('close', resolve)
    input.on('error', resolve)
  })
  // Ending the input only stops new requests: queued work and its responses still complete.
  await running
  await writer.settled()
  return writer.channelFailed ? 1 : 0
}

/* v8 ignore start -- only a built tree launches this entry; the packaged runtime smoke test covers it. */
if (import.meta.main) {
  process.exitCode = await runRasterWorker(process.stdin, process.stdout, process.stderr)
}
/* v8 ignore stop */
