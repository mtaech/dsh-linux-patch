/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's approved, process-local storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
  /** Renderer-initiated element capture for one guest; absent in older shells that predate annotation support. */
  readonly annotations?: DesktopBrowserAnnotationBridge
  /** Page zoom for one guest; absent in older shells that predate zoom support. */
  readonly zoom?: DesktopBrowserZoomBridge
}

/** Renderer-minted identity of one element-capture round trip. */
export type DesktopBrowserAnnotationRequestId = Branded<'DesktopBrowserAnnotationRequestId'>

/** Locates one captured element inside its page, with redundant selector candidates for later re-matching. */
export interface DesktopBrowserElementLocator {
  /** Canonical CSS path from the document root. */
  readonly cssPath: string
  /** Fallback selectors ordered by preference; used when the element has moved. */
  readonly candidates: readonly string[]
  readonly testId?: string
  readonly id?: string
  readonly role?: string
  readonly name?: string
  /** Visible text content, truncated by the capturer. */
  readonly text?: string
  readonly tagName: string
  /** Tag names from the document root down to the element's parent. */
  readonly ancestors: readonly string[]
  /** Attribute-derived digest that detects same-location drift. */
  readonly fingerprint: string
}

/** Trusted, capturer-extracted description of the element's content and geometry. */
export interface DesktopBrowserElementSnapshot {
  readonly text: string
  readonly role: string
  readonly name: string
  readonly tagName: string
  readonly attributes: Readonly<Record<string, string>>
  /** Truncated outer HTML excerpt; never the full source. */
  readonly htmlSummary: string
  /** Owning component name read from the page's framework internals, when the page exposes one. */
  readonly componentName?: string
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly viewport: {
    readonly width: number
    readonly height: number
    readonly devicePixelRatio: number
    readonly scrollX: number
    readonly scrollY: number
  }
}

/** PNG bytes clipped to the element rect when {@link DesktopBrowserScreenshot.cropped} is set. */
export interface DesktopBrowserScreenshot {
  readonly mediaType: 'image/png'
  readonly bytes: Uint8Array
  readonly width: number
  readonly height: number
  /** Whether the bytes contain only the element region instead of the full viewport. */
  readonly cropped: boolean
}

/** One selected element: its stable locator plus the content read at capture time. */
export interface DesktopBrowserElementTarget {
  readonly locator: DesktopBrowserElementLocator
  readonly snapshot: DesktopBrowserElementSnapshot
}

/** One completed element capture from the guest page; the source content is untrusted page data. */
export interface DesktopBrowserElementCapture {
  /** Page address at capture time; may differ from the current address when the page has navigated since. */
  readonly url: string
  readonly title: string
  /** History origin of the frame's current entry. */
  readonly route: string
  /** Selected elements in pick order; a plain click yields one, additive clicks yield several. */
  readonly targets: readonly DesktopBrowserElementTarget[]
  readonly screenshot?: DesktopBrowserScreenshot
  readonly capturedAt: string
}

/** Outcome of re-matching a stored locator against the current page. */
export interface DesktopBrowserElementResolution {
  readonly status: 'fresh' | 'shifted' | 'stale'
  readonly matchedSelector?: string
  readonly score: number
}

/**
 * Main-process element-capture operations for one guest, offered only by shells whose capturer supports them.
 * Captured page content is untrusted: renderers must not execute or trust its structure.
 */
export interface DesktopBrowserAnnotationBridge {
  /**
   * @param lease - originating guest. @param requestId - renderer-minted round-trip identity.
   * @returns the capture, or undefined when the guest cannot capture.
   */
  capture(lease: DesktopBrowserLeaseId, requestId: DesktopBrowserAnnotationRequestId): Promise<DesktopBrowserElementCapture | undefined>
  /**
   * @param lease - originating guest. @param requestId - the in-flight capture to drop.
   * @returns after the main process has stopped preparing it.
   */
  cancel(lease: DesktopBrowserLeaseId, requestId: DesktopBrowserAnnotationRequestId): Promise<void>
}

/** Page-zoom operations for one guest; the factor is the guest's own scale where 1 keeps the page size. */
export interface DesktopBrowserZoomBridge {
  /**
   * @param lease - originating guest. @param factor - requested scale, already clamped by the renderer.
   * @returns after the guest applied the scale, or undefined when the guest cannot be scaled.
   */
  setZoom(lease: DesktopBrowserLeaseId, factor: number): Promise<number | undefined>
  /** @param lease - originating guest. @returns the guest's current scale. */
  getZoom(lease: DesktopBrowserLeaseId): Promise<number | undefined>
}
