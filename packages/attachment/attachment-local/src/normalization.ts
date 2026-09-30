/** Deterministic provider-independent image normalization. @module @deepseek-ai/dsh-attachment-local/normalization */

import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { detectImage, encodedAlphaIsCompatible } from './image.ts'
import { normalizeImage as dispatchNormalizeImage } from './raster.ts'
import { canPassThroughNormalization } from './raster-operations.ts'
import type { DetectedImage, NormalizationPolicy, NormalizedImage } from './raster-operations.ts'

export { canPassThroughNormalization } from './raster-operations.ts'
export type { NormalizationPolicy, NormalizedImage } from './raster-operations.ts'

/**
 * Assert that a normalized output is an 8-bit sRGB/sRGBA single-frame image with matching facts.
 *
 * Verification runs beside the store rather than beside the encoder: bytes
 * produced by a raster worker cross a process boundary, so their reported
 * facts are re-derived here before they are persisted.
 */
async function verifyNormalizedImage(
  image: NormalizedImage,
  expectedAlpha: boolean | undefined,
): Promise<NormalizedImage> {
  const detected = await detectImage(image.data)
  if (detected.mediaType !== image.mediaType
    || detected.width !== image.width
    || detected.height !== image.height
    || detected.animated
    || detected.carriesMetadata
    || detected.depth !== 'uchar'
    || detected.space !== 'srgb'
    || !encodedAlphaIsCompatible(expectedAlpha, detected)) {
    throw new AttachmentError(
      'Image normalization did not produce a single-frame 8-bit sRGB image with matching metadata.',
      'ATTACHMENT_WRITE_FAILED',
    )
  }
  return image
}

/**
 * Produce the persisted provider-independent normalized version of one fully decoded source.
 * The source is passed through only when it is already clean, single-frame, 8-bit sRGB/sRGBA,
 * and inside every normalization limit. Re-encoding never removes transparency. When every
 * ladder quality exceeds the byte target, the smallest ladder output is kept; provider byte
 * caps stay enforced at the route that transmits the bytes.
 * @param data - complete admitted source bytes.
 * @param detected - fully decoded source facts.
 * @param policy - resolved independent normalization limits.
 * @returns verified provider-independent normalized bytes and metadata.
 */
export async function normalizeImage(
  data: Uint8Array,
  detected: DetectedImage,
  policy: NormalizationPolicy,
): Promise<NormalizedImage> {
  if (canPassThroughNormalization(detected, data.byteLength, policy)) {
    return { data, mediaType: detected.mediaType, width: detected.width, height: detected.height }
  }
  const normalized = await dispatchNormalizeImage(data, detected, policy)
  return await verifyNormalizedImage(normalized, detected.mediaType === 'image/gif' ? undefined : detected.hasAlpha)
}
