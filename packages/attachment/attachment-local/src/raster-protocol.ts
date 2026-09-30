/** Length-prefixed frames between the host and the raster worker.
 * @module @deepseek-ai/dsh-attachment-local/raster-protocol */

import { Buffer } from 'node:buffer'
import type { AttachmentErrorCode, ImageAttachmentRef, ImageMediaType, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import type { DecodedImageLimits, DetectedImage, NormalizationPolicy } from './raster-operations.ts'

/** Largest accepted frame section; a raster request carries at most one admitted image. */
export const RASTER_MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Facts identifying one raster operation; its input bytes travel in the frame's binary section. */
export type RasterRequestJson =
  | { op: 'probeImage' }
  | { op: 'detectImage'; limits?: DecodedImageLimits }
  | { op: 'normalizeImage'; detected: DetectedImage; policy: NormalizationPolicy }
  | { op: 'createRequestImage'; ref: ImageAttachmentRef; target: ImageRequestTarget; hasAlpha: boolean }

/** One raster operation request: JSON facts, its request id, and the submitted image bytes. */
export type RasterRequest = RasterRequestJson & { id: number; data: Uint8Array }

/** Facts returned by one raster operation, with any produced bytes carried separately. */
export type RasterResult =
  | { op: 'probeImage' | 'detectImage'; detected: DetectedImage }
  | { op: 'normalizeImage' | 'createRequestImage'; mediaType: ImageMediaType; width: number; height: number }

/** Worker reply to one {@link RasterRequest}. */
export type RasterResponse =
  | { id: number; ok: true; result: RasterResult }
  | { id: number; ok: false; code?: AttachmentErrorCode; message: string }

/**
 * Encode one frame as `[jsonLength][json][binaryLength][binary]`.
 * @param json - JSON-serializable section; carries the request or response facts.
 * @param binary - optional produced or submitted bytes; empty when the operation carries none.
 * @returns one frame ready to write to the channel.
 * @throws when either section exceeds {@link RASTER_MAX_FRAME_BYTES}.
 */
export function encodeRasterFrame(json: unknown, binary: Uint8Array = new Uint8Array()): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
  const binaryBytes = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength)
  if (jsonBytes.byteLength > RASTER_MAX_FRAME_BYTES || binaryBytes.byteLength > RASTER_MAX_FRAME_BYTES) {
    throw new Error('attachment raster frame exceeds its size limit')
  }
  const frame = Buffer.allocUnsafe(8 + jsonBytes.byteLength + binaryBytes.byteLength)
  frame.writeUInt32BE(jsonBytes.byteLength, 0)
  jsonBytes.copy(frame, 4)
  frame.writeUInt32BE(binaryBytes.byteLength, 4 + jsonBytes.byteLength)
  binaryBytes.copy(frame, 8 + jsonBytes.byteLength)
  return frame
}

type DecoderStage = 'jsonLength' | 'json' | 'binaryLength' | 'binary'

/**
 * Incremental frame parser for one duplex channel.
 *
 * Each payload is copied once into a buffer sized from its declared length, so
 * arriving chunks never re-copy a frame body, and a declared length above
 * {@link RASTER_MAX_FRAME_BYTES} fails the channel instead of allocating.
 */
export class RasterFrameDecoder {
  private stage: DecoderStage = 'jsonLength'
  private readonly header = Buffer.alloc(4)
  private headerBytes = 0
  private section: Buffer = Buffer.alloc(0)
  private sectionBytes = 0
  private jsonSection: Buffer = Buffer.alloc(0)
  private failed = false

  /**
   * @param onFrame - receives one complete frame's JSON text and binary section.
   * @param onFailure - receives the first protocol failure; the channel is unusable afterwards.
   */
  constructor(
    private readonly onFrame: (jsonText: string, binary: Buffer) => void,
    private readonly onFailure: (error: Error) => void,
  ) {}

  /** Consume one channel chunk. */
  push(chunk: Buffer): void {
    if (this.failed) return
    let offset = 0
    try {
      while (offset < chunk.byteLength) {
        if (this.stage === 'json' || this.stage === 'binary') {
          const bytes = Math.min(this.section.byteLength - this.sectionBytes, chunk.byteLength - offset)
          chunk.copy(this.section, this.sectionBytes, offset, offset + bytes)
          this.sectionBytes += bytes
          offset += bytes
          if (this.sectionBytes < this.section.byteLength) return
          this.completeSection(this.section)
          continue
        }
        const bytes = Math.min(4 - this.headerBytes, chunk.byteLength - offset)
        chunk.copy(this.header, this.headerBytes, offset, offset + bytes)
        this.headerBytes += bytes
        offset += bytes
        if (this.headerBytes < 4) return
        const length = this.header.readUInt32BE(0)
        if (length > RASTER_MAX_FRAME_BYTES) throw new Error('attachment raster frame declares an oversized section')
        this.headerBytes = 0
        this.section = Buffer.allocUnsafe(length)
        this.sectionBytes = 0
        this.stage = this.stage === 'jsonLength' ? 'json' : 'binary'
        if (length === 0) this.completeSection(this.section)
      }
    } catch (error) {
      this.failed = true
      this.onFailure(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private completeSection(section: Buffer): void {
    this.section = Buffer.alloc(0)
    this.sectionBytes = 0
    if (this.stage === 'json') {
      this.jsonSection = section
      this.stage = 'binaryLength'
      return
    }
    this.stage = 'jsonLength'
    this.onFrame(this.jsonSection.toString('utf8'), section)
  }
}
