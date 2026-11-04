/** Main-process page zoom for Sidebar browser guests, scoped to an approved lease. */

import type { WebContents } from 'electron'
import type { DesktopBrowserGuests } from './browser-guests.ts'

/** Electron's supported scale range; the renderer clamps to its own steps first. */
const MIN_ZOOM = 0.25
const MAX_ZOOM = 5

/**
 * Applies page zoom to guests owned by one application window.
 * @throws when the lease has no live guest for this window.
 */
export class DesktopBrowserZoom {
  /** @param guests - lease ownership authority shared with the other Browser operations. */
  constructor(private readonly guests: DesktopBrowserGuests) {}

  /**
   * Apply one zoom factor to the lease's guest.
   * @param owner - authenticated IPC sender.
   * @param leaseId - lease received over IPC.
   * @param factor - requested scale, where 1 keeps the page's own size.
   * @returns the scale the guest reports afterwards.
   * @throws when the lease is not this window's or has no live guest.
   */
  async set(owner: WebContents, leaseId: unknown, factor: unknown): Promise<number | undefined> {
    if (typeof factor !== 'number' || !Number.isFinite(factor)) {
      throw new Error('desktop browser zoom: a finite factor is required')
    }
    const guest = this.guests.guest(owner, leaseId)
    if (guest === undefined) throw new Error('desktop browser zoom: the lease has no live guest for this window')
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, factor))
    guest.setZoomFactor(clamped)
    return guest.getZoomFactor()
  }

  /**
   * Read the lease's current page zoom.
   * @param owner - authenticated IPC sender.
   * @param leaseId - lease received over IPC.
   * @returns the guest's scale, or undefined when the lease has no live guest.
   */
  get(owner: WebContents, leaseId: unknown): number | undefined {
    const guest = this.guests.guest(owner, leaseId)
    return guest === undefined ? undefined : guest.getZoomFactor()
  }
}
