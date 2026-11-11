/** Carrier-neutral page zoom, independent of the embedding or the caller's layout. */

/** Zoom steps offered by the toolbar and the keyboard shortcuts; 1 is the page's own size. */
export const BROWSER_ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const

/** Default page zoom; restores the provider's own scale factor. */
export const DEFAULT_BROWSER_ZOOM = 1
/** Smallest and largest offered steps, kept beside the ladder so clamping never indexes a tuple. */
export const MIN_BROWSER_ZOOM = 0.5
/** Largest offered zoom step. */
export const MAX_BROWSER_ZOOM = 3

/** Optional page-zoom control; providers that can scale their page implement it. */
export interface BrowserZoomControl {
  /**
   * Apply a zoom factor to the page.
   * @param factor - one-based scale where 1 keeps the page's own size.
   */
  setZoom(factor: number): void
}

/**
 * Clamp a requested factor to the supported range.
 * @param factor - candidate factor.
 * @returns the nearest supported step, or 1 for a non-finite value.
 */
export function normalizeBrowserZoom(factor: number): number {
  if (!Number.isFinite(factor)) return DEFAULT_BROWSER_ZOOM
  const clamped = Math.min(MAX_BROWSER_ZOOM, Math.max(MIN_BROWSER_ZOOM, factor))
  const steps: readonly number[] = BROWSER_ZOOM_STEPS
  return steps.reduce((nearest, step) => Math.abs(step - clamped) < Math.abs(nearest - clamped) ? step : nearest,
    steps.find(step => step >= clamped) ?? MAX_BROWSER_ZOOM)
}

/**
 * Step through the zoom ladder.
 * @param current - current factor.
 * @param direction - next larger or next smaller step.
 * @returns the adjacent supported step, or the current factor at either end.
 */
export function stepBrowserZoom(current: number, direction: 'in' | 'out'): number {
  const value = normalizeBrowserZoom(current)
  const steps: readonly number[] = BROWSER_ZOOM_STEPS
  const index = steps.findIndex(step => step === value)
  const next = direction === 'in' ? index + 1 : index - 1
  return steps[Math.min(steps.length - 1, Math.max(0, next))] ?? value
}

/**
 * Format one zoom factor for the toolbar, without trailing zeros.
 * @param factor - Zoom factor normalized to the supported step range.
 * @returns the factor formatted for the toolbar, without trailing zeros.
 */
export function formatBrowserZoom(factor: number): string {
  return `${String(Math.round(normalizeBrowserZoom(factor) * 100))}%`
}
