/** Iframe DOM and revision-tagged load observations. */
import type { BrowserTarget } from '../browser/url.ts'
import type { BrowserPresentation } from './BrowserPresentation.ts'
import css from './Browser.module.css'

/** Fixed iframe policy; top navigation and downloads are not granted directly. */
export const WEB_BROWSER_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox'

interface IframeDocument {
  readonly target: BrowserTarget
  readonly revision: number
  readonly sandboxed: boolean
}

/** The iframe is laid out at the reciprocal size so a page keeping its own viewport still fits. */
function applyWebZoom(element: HTMLIFrameElement, factor: number): void {
  const scale = Number.isFinite(factor) && factor > 0 ? factor : 1
  element.style.transform = scale === 1 ? '' : `scale(${String(scale)})`
  element.style.transformOrigin = scale === 1 ? '' : 'top left'
  element.style.width = scale === 1 ? '' : `${String(100 / scale)}%`
  element.style.height = scale === 1 ? '' : `${String(100 / scale)}%`
}

/** Reports only what an iframe can observe without inspecting cross-origin content. */
export interface IframePresentationEvents {
  readonly loaded: (revision: number) => void
  readonly failed: (revision: number) => void
  readonly remounted: () => void
}

/** Owns the iframe element; navigation and history remain in IframeImpl. */
export class IframePresentation implements BrowserPresentation {
  private host: HTMLElement | undefined
  private element: HTMLIFrameElement | undefined
  private document: IframeDocument | undefined
  private rendered = false
  private zoom = 1

  /** @param events - provider-owned load and remount callbacks. */
  constructor(private readonly events: IframePresentationEvents) {}

  /** @param viewportId - mounted placeholder. @returns removes only the iframe presentation. */
  mount(viewportId: string): () => void {
    const host = document.getElementById(viewportId)
    if (host === null) throw new Error('iframe presentation: viewport is not mounted')
    this.element?.remove()
    this.element = undefined
    this.host = host
    if (this.rendered) this.events.remounted()
    else this.render()
    return () => {
      if (this.host !== host) return
      this.element?.remove()
      this.element = undefined
      this.host = undefined
    }
  }

  /**
   * Retain the prepared document and render it when a container is mounted.
   * @param value - prepared document and event generation.
   */
  show(value: IframeDocument): void {
    this.document = value
    this.render()
  }

  /**
   * Scale the embedded page; a cross-origin page keeps its own layout viewport, so scaling the
   * frame is the only web-side equivalent of page zoom.
   * @param factor - one-based scale where 1 restores the frame's own size.
   */
  setZoom(factor: number): void {
    this.zoom = factor
    if (this.element !== undefined) applyWebZoom(this.element, factor)
  }

  /** Remove the owned DOM and retained presentation data. */
  dispose(): void {
    this.element?.remove()
    this.element = undefined
    this.host = undefined
    this.document = undefined
  }

  private render(): void {
    const current = this.document
    const host = this.host
    if (current === undefined || host === undefined) return
    this.element?.remove()
    const element = document.createElement('iframe')
    element.className = css.frame as string
    element.src = current.target.url
    element.title = current.target.title
    element.referrerPolicy = 'no-referrer'
    element.dataset.sidebarBrowserFrame = 'iframe'
    if (current.sandboxed) element.setAttribute('sandbox', WEB_BROWSER_SANDBOX)
    element.addEventListener('load', () => {
      if (this.element === element) this.events.loaded(current.revision)
    })
    element.addEventListener('error', () => {
      if (this.element === element) this.events.failed(current.revision)
    })
    applyWebZoom(element, this.zoom)
    this.element = element
    this.rendered = true
    host.append(element)
  }
}
