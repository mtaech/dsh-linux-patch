/** Page-zoom ladder helpers: clamping, stepping, and display formatting. */
import { describe, expect, it } from 'vitest'
import {
  BROWSER_ZOOM_STEPS, DEFAULT_BROWSER_ZOOM, formatBrowserZoom, normalizeBrowserZoom, stepBrowserZoom,
} from '../src/client/browser/BrowserZoom.ts'

describe('normalizeBrowserZoom', () => {
  it('keeps supported factors and clamps the ends', () => {
    expect(normalizeBrowserZoom(1)).toBe(1)
    expect(normalizeBrowserZoom(1.25)).toBe(1.25)
    expect(normalizeBrowserZoom(0.1)).toBe(0.5)
    expect(normalizeBrowserZoom(10)).toBe(3)
  })

  it('falls back to the page size for a non-finite factor', () => {
    expect(normalizeBrowserZoom(Number.NaN)).toBe(DEFAULT_BROWSER_ZOOM)
    expect(normalizeBrowserZoom(Number.POSITIVE_INFINITY)).toBe(DEFAULT_BROWSER_ZOOM)
  })
})

describe('stepBrowserZoom', () => {
  it('moves to the adjacent step in both directions', () => {
    expect(stepBrowserZoom(1, 'in')).toBe(1.1)
    expect(stepBrowserZoom(1, 'out')).toBe(0.9)
  })

  it('stops at the ladder ends', () => {
    const smallest = BROWSER_ZOOM_STEPS[0] ?? 0.5
    const largest = BROWSER_ZOOM_STEPS[BROWSER_ZOOM_STEPS.length - 1] ?? 3
    expect(stepBrowserZoom(smallest, 'out')).toBe(smallest)
    expect(stepBrowserZoom(largest, 'in')).toBe(largest)
  })

  it('nearest-routes an off-ladder value before stepping', () => {
    // 0.88 snaps to 0.9 and steps up to 1; 0.71 snaps to 0.67 and steps down to 0.5.
    expect(stepBrowserZoom(0.88, 'in')).toBe(1)
    expect(stepBrowserZoom(0.71, 'out')).toBe(0.5)
  })
})

describe('formatBrowserZoom', () => {
  it('renders whole percentages', () => {
    expect(formatBrowserZoom(1)).toBe('100%')
    expect(formatBrowserZoom(1.25)).toBe('125%')
    expect(formatBrowserZoom(0.5)).toBe('50%')
  })
})
