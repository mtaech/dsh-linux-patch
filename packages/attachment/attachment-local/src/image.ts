/** Raster inspection: full decode at admission, header-only probe on verified reads. @module @deepseek-ai/dsh-attachment-local/image */

import { detectImage as dispatchDetectImage, probeImage as dispatchProbeImage } from './raster.ts'
import type { DecodedImageLimits, DetectedImage } from './raster-operations.ts'

export { encodedAlphaIsCompatible } from './raster-operations.ts'
export type { DecodedImageLimits, DetectedImage } from './raster-operations.ts'

/**
 * Parse a supported raster's header and return its intrinsic metadata without
 * decoding pixels. Digest-verified reads use this: admission already proved
 * that these exact bytes decode completely, so the read path only re-derives
 * the reference fields instead of paying the full-raster decode again.
 * @param data - complete encoded image bytes.
 * @returns verified format and dimensions.
 */
export async function probeImage(data: Uint8Array): Promise<DetectedImage> {
  return await dispatchProbeImage(data)
}

/**
 * Fully decode a supported raster and return its intrinsic metadata.
 * @param data - complete encoded image bytes.
 * @param limits - intrinsic-dimension admission limits.
 * @returns verified format and dimensions.
 */
export async function detectImage(data: Uint8Array, limits?: DecodedImageLimits): Promise<DetectedImage> {
  return await dispatchDetectImage(data, limits)
}
