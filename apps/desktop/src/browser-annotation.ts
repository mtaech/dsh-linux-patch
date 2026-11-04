/** Main-process capture of user-annotated web elements from Sidebar browser guests. */
import type { WebContents } from 'electron'
import type { DesktopBrowserAnnotationRequestId, DesktopBrowserElementCapture,
  DesktopBrowserElementLocator, DesktopBrowserElementSnapshot, DesktopBrowserElementTarget,
  DesktopBrowserScreenshot } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopBrowserGuests } from './browser-guests.ts'
import { ANNOTATION_ARM_SCRIPT, ANNOTATION_CANCEL_SCRIPT } from './browser-annotation-scripts.ts'

/** Isolated world reserved for annotation scripts; page scripts cannot see its state. */
const ANNOTATION_WORLD_ID = 1001
/** One armed annotation session per guest; the user must finish or cancel within this window. */
const CAPTURE_TIMEOUT_MS = 120_000
const MAX_REQUEST_ID_LENGTH = 64
const REQUEST_ID_PATTERN = /^[\w.-]+$/
/** Screenshot budget shared with other Browser surfaces; oversized captures are dropped. */
const MAX_PNG_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_EDGE = 1600

const MAX_URL_LENGTH = 4096
const MAX_ROUTE_LENGTH = 2048
const MAX_TITLE_LENGTH = 200
const MAX_TEXT_LENGTH = 500
const MAX_NAME_LENGTH = 200
const MAX_ATTRIBUTE_COUNT = 20
const MAX_ATTRIBUTE_VALUE_LENGTH = 200
const MAX_HTML_SUMMARY_LENGTH = 1000
const MAX_ANCESTORS = 6
const MAX_CANDIDATES = 5
const MAX_CSS_PATH_LENGTH = 1024
/** One additive pick session stays small enough to quote in one message. */
const MAX_TARGETS = 8
const MAX_COMPONENT_NAME_LENGTH = 80

/** Attributes the page may report; anything else is dropped before persistence. */
const ATTRIBUTE_ALLOWLIST = new Set(['id', 'class', 'name', 'type', 'placeholder', 'alt', 'title', 'role', 'aria-label', 'data-testid', 'data-test'])

interface AnnotationSession {
  readonly owner: WebContents
  readonly guest: WebContents
  readonly requestId: DesktopBrowserAnnotationRequestId
  readonly resolve: (value: DesktopBrowserElementCapture | undefined) => void
  readonly timer: NodeJS.Timeout
  settle(value: DesktopBrowserElementCapture | undefined): void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Strips control characters and truncates an untrusted string field.
 * @param value - value reported by the annotated page.
 * @param max - maximum persisted length.
 * @returns the cleaned string, or undefined when the field is absent or not text.
 */
function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  // Control characters (except tab, newline, carriage return) can corrupt logs and persistence.
  const stripped = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
  return stripped.slice(0, max)
}

/** @returns a finite number, or undefined for anything a page could not honestly report. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Rebuilds the element locator from page-reported fields, enforcing every persisted limit.
 * @returns undefined when a required locator field is missing or mistyped.
 */
function cleanLocator(value: unknown): DesktopBrowserElementLocator | undefined {
  if (!isRecord(value)) return undefined
  const cssPath = cleanText(value.cssPath, MAX_CSS_PATH_LENGTH)
  const tagName = cleanText(value.tagName, 64)
  const fingerprint = cleanText(value.fingerprint, MAX_CSS_PATH_LENGTH)
  if (cssPath === undefined || cssPath.length === 0 || tagName === undefined || tagName.length === 0
    || fingerprint === undefined || fingerprint.length === 0 || !Array.isArray(value.ancestors)
    || !Array.isArray(value.candidates)) {
    return undefined
  }
  const ancestors = value.ancestors.slice(0, MAX_ANCESTORS)
    .map(entry => cleanText(entry, MAX_CSS_PATH_LENGTH))
    .filter((entry): entry is string => entry !== undefined)
  const candidates = value.candidates.slice(0, MAX_CANDIDATES)
    .map(entry => cleanText(entry, MAX_CSS_PATH_LENGTH))
    .filter((entry): entry is string => entry !== undefined)
  const testId = cleanText(value.testId, MAX_ATTRIBUTE_VALUE_LENGTH)
  const id = cleanText(value.id, MAX_ATTRIBUTE_VALUE_LENGTH)
  const role = cleanText(value.role, 64)
  const name = cleanText(value.name, MAX_NAME_LENGTH)
  const text = cleanText(value.text, MAX_TEXT_LENGTH)
  // Conditional spreads keep absent optional fields absent under exactOptionalPropertyTypes.
  return {
    cssPath,
    candidates,
    tagName,
    ancestors,
    fingerprint,
    ...(testId === undefined ? {} : { testId }),
    ...(id === undefined ? {} : { id }),
    ...(role === undefined ? {} : { role }),
    ...(name === undefined ? {} : { name }),
    ...(text === undefined ? {} : { text }),
  }
}

/**
 * Rebuilds the element snapshot from page-reported fields, enforcing every persisted limit.
 * @returns undefined when a required snapshot field is missing or mistyped.
 */
function cleanSnapshot(value: unknown): DesktopBrowserElementSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const text = cleanText(value.text, MAX_TEXT_LENGTH)
  const tagName = cleanText(value.tagName, 64)
  const htmlSummary = cleanText(value.htmlSummary, MAX_HTML_SUMMARY_LENGTH)
  const rect = cleanRect(value.rect)
  const viewport = cleanViewport(value.viewport)
  if (text === undefined || tagName === undefined || htmlSummary === undefined
    || rect === undefined || viewport === undefined) {
    return undefined
  }
  const attributes: Record<string, string> = {}
  if (isRecord(value.attributes)) {
    for (const [key, entry] of Object.entries(value.attributes)) {
      if (Object.keys(attributes).length >= MAX_ATTRIBUTE_COUNT) break
      const name = cleanText(key, MAX_ATTRIBUTE_VALUE_LENGTH)
      const attributeValue = cleanText(entry, MAX_ATTRIBUTE_VALUE_LENGTH)
      if (name === undefined || attributeValue === undefined || !ATTRIBUTE_ALLOWLIST.has(name)) continue
      attributes[name] = attributeValue
    }
  }
  const componentName = cleanText(value.componentName, MAX_COMPONENT_NAME_LENGTH)
  return {
    text,
    role: cleanText(value.role, 64) ?? '',
    name: cleanText(value.name, MAX_NAME_LENGTH) ?? '',
    tagName,
    attributes,
    htmlSummary,
    ...(componentName === undefined || componentName.length === 0 ? {} : { componentName }),
    rect,
    viewport,
  }
}

function cleanRect(value: unknown): DesktopBrowserElementSnapshot['rect'] | undefined {
  if (!isRecord(value)) return undefined
  const x = finiteNumber(value.x)
  const y = finiteNumber(value.y)
  const width = finiteNumber(value.width)
  const height = finiteNumber(value.height)
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined : { x, y, width, height }
}

function cleanViewport(value: unknown): DesktopBrowserElementSnapshot['viewport'] | undefined {
  if (!isRecord(value)) return undefined
  const width = finiteNumber(value.width)
  const height = finiteNumber(value.height)
  const devicePixelRatio = finiteNumber(value.devicePixelRatio)
  const scrollX = finiteNumber(value.scrollX)
  const scrollY = finiteNumber(value.scrollY)
  return width === undefined || height === undefined || devicePixelRatio === undefined
    || scrollX === undefined || scrollY === undefined
    ? undefined
    : { width, height, devicePixelRatio, scrollX, scrollY }
}

/**
 * Owns element annotation capture for Sidebar browser guests: scripts, ownership, one
 * armed session per guest, sanitization, and screenshot budgeting all stay in the main process.
 */
export class DesktopBrowserAnnotations {
  private readonly sessions = new Map<number, AnnotationSession>()

  /** @param guests - the guest registry that verifies lease ownership for every request. */
  constructor(private readonly guests: DesktopBrowserGuests) {}

  /**
   * Arms element picking on the lease's guest and resolves with the captured element.
   * @param owner - authenticated IPC sender.
   * @param leaseId - lease received over IPC; must belong to this window and have a live guest.
   * @param requestId - caller-supplied identifier matching `[\w.-]{1,64}`.
   * @returns the capture, or undefined when the user cancels, presses Escape, the timeout
   *   expires, navigation or destruction interrupts the session, or the page reports unusable data.
   * @throws when the lease has no live guest for this window, mirroring lease release errors.
   */
  async capture(owner: WebContents, leaseId: unknown, requestId: unknown):
  Promise<DesktopBrowserElementCapture | undefined> {
    const id = validateRequestId(requestId)
    const guest = this.guests.guest(owner, leaseId)
    if (guest === undefined) {
      throw new Error('desktop browser annotation: the lease has no live guest for this window')
    }
    // One armed session per guest: an interrupted predecessor settles to undefined first.
    const previous = this.sessions.get(guest.id)
    if (previous !== undefined) previous.settle(undefined)
    return new Promise<DesktopBrowserElementCapture | undefined>((resolve) => {
      const session = this.arm(owner, guest, id, resolve)
      this.sessions.set(guest.id, session)
    })
  }

  /**
   * Cancels the armed session when the request identifies it; stale cancels are ignored so a
   * later capture on the same guest is never killed by an earlier window's cancel.
   */
  async cancel(owner: WebContents, leaseId: unknown, requestId: unknown): Promise<void> {
    if (!REQUEST_ID_PATTERN.test(String(requestId))) return
    const guest = this.guests.guest(owner, leaseId)
    if (guest === undefined) return
    const session = this.sessions.get(guest.id)
    if (session === undefined || session.owner !== owner || session.requestId !== requestId) return
    session.settle(undefined)
  }

  /**
   * Arms the isolated-world script and wires every interrupt path into one settle function.
   * @returns the armed session, already registered by the caller.
   */
  private arm(owner: WebContents, guest: WebContents, requestId: DesktopBrowserAnnotationRequestId,
    resolve: (value: DesktopBrowserElementCapture | undefined) => void): AnnotationSession {
    let settled = false
    const settle = (value: DesktopBrowserElementCapture | undefined): void => {
      if (settled) return
      settled = true
      // Single-flight per guest means the registered session with this requestId is still ours.
      if (this.sessions.get(guest.id)?.requestId === requestId) this.sessions.delete(guest.id)
      detach()
      clearTimeout(timer)
      runCancelScript(guest)
      resolve(value)
    }
    const onNavigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean): void => {
      if (mainFrame) settle(undefined)
    }
    const onInput = (_event: { preventDefault(): void }, input: { type: string; key: string }): void => {
      if (input.type === 'keyDown' && input.key === 'Escape') settle(undefined)
    }
    const onDestroyed = (): void => { settle(undefined) }
    const timer = setTimeout(() => { settle(undefined) }, CAPTURE_TIMEOUT_MS)
    const detach = (): void => {
      guest.removeListener('did-start-navigation', onNavigation)
      guest.removeListener('before-input-event', onInput)
      guest.removeListener('destroyed', onDestroyed)
    }
    const session: AnnotationSession = {
      owner, guest, requestId, resolve, timer,
      settle: (value) => { settle(value) },
    }
    guest.on('did-start-navigation', onNavigation)
    guest.on('before-input-event', onInput)
    guest.once('destroyed', onDestroyed)
    guest.focus()
    void guest.executeJavaScriptInIsolatedWorld(ANNOTATION_WORLD_ID, [{ code: ANNOTATION_ARM_SCRIPT }])
      .then(async (raw) => {
        const captured = await this.buildCapture(guest, raw)
        settle(captured)
      })
      .catch((error: unknown) => {
        console.error('desktop browser annotation: the arm script failed', error)
        settle(undefined)
      })
    return session
  }

  /**
   * Sanitizes the page-reported payload and appends the budgeted screenshot.
   * @returns the finished capture, or undefined when the payload is unusable.
   */
  private async buildCapture(guest: WebContents, raw: unknown):
  Promise<DesktopBrowserElementCapture | undefined> {
    if (!isRecord(raw)) return undefined
    const rawTargets = raw.elements
    if (!Array.isArray(rawTargets) || rawTargets.length === 0 || rawTargets.length > MAX_TARGETS) return undefined
    const targets: DesktopBrowserElementTarget[] = []
    for (const entry of rawTargets) {
      if (!isRecord(entry)) return undefined
      const locator = cleanLocator(entry.locator)
      const snapshot = cleanSnapshot(entry.snapshot)
      if (locator === undefined || snapshot === undefined) return undefined
      targets.push({ locator, snapshot })
    }
    // The crop covers the union of every selected element so one screenshot shows all picks.
    const target = await this.captureScreenshot(guest, targets.map(item => item.snapshot))
    return {
      url: guestUrl(guest),
      title: cleanText(raw.title, MAX_TITLE_LENGTH) ?? '',
      route: guestRoute(guest),
      targets,
      ...(target === undefined ? {} : { screenshot: target }),
      capturedAt: new Date().toISOString(),
    }
  }

  /**
   * Captures the union of the selected element rectangles in DIP viewport coordinates,
   * falling back to the full viewport when the rectangles are invalid or the crop fails.
   */
  private async captureScreenshot(guest: WebContents,
    snapshots: readonly DesktopBrowserElementSnapshot[]): Promise<DesktopBrowserScreenshot | undefined> {
    const zoom = guest.getZoomFactor()
    const rect = clampRects(snapshots.map(snapshot => ({ rect: snapshot.rect, viewport: snapshot.viewport })), zoom)
    let image = rect === undefined
      ? undefined
      : await guest.capturePage(rect).catch((error: unknown) => {
        console.error('desktop browser annotation: the element screenshot failed', error)
        return undefined
      })
    if (image === undefined || image.isEmpty()) {
      image = await guest.capturePage().catch((error: unknown) => {
        console.error('desktop browser annotation: the viewport screenshot failed', error)
        return undefined
      })
      if (image === undefined || image.isEmpty()) return undefined
    }
    const size = image.getSize()
    const longEdge = Math.max(size.width, size.height)
    const scaled = longEdge > MAX_IMAGE_EDGE
      ? image.resize(size.width >= size.height
        ? { width: MAX_IMAGE_EDGE }
        : { height: MAX_IMAGE_EDGE })
      : image
    const png = scaled.toPNG()
    if (png.byteLength > MAX_PNG_BYTES) return undefined
    const finalSize = scaled.getSize()
    return {
      mediaType: 'image/png',
      bytes: png,
      width: finalSize.width,
      height: finalSize.height,
      cropped: rect !== undefined,
    }
  }
}

/**
 * Runs the fixed cancel script so an interrupted session never leaves an overlay behind.
 * Failed teardown is logged, never surfaced: the capture result is already decided.
 */
function runCancelScript(guest: WebContents): void {
  if (guest.isDestroyed()) return
  guest.executeJavaScriptInIsolatedWorld(ANNOTATION_WORLD_ID, [{ code: ANNOTATION_CANCEL_SCRIPT }])
    .catch((error: unknown) => {
      console.error('desktop browser annotation: the cancel script failed', error)
    })
}

/** @returns the authenticated request id, rejecting anything a renderer could spoof with. */
function validateRequestId(requestId: unknown): DesktopBrowserAnnotationRequestId {
  if (typeof requestId !== 'string' || requestId.length === 0
    || requestId.length > MAX_REQUEST_ID_LENGTH || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('desktop browser annotation: invalid annotation request identifier')
  }
  return requestId as DesktopBrowserAnnotationRequestId
}

/** @returns the live guest URL, truncated; the page never self-reports its address. */
function guestUrl(guest: WebContents): string {
  return (cleanText(guest.getURL(), MAX_URL_LENGTH) ?? '')
}

/** @returns the guest route (path plus query), truncated, derived from the live URL. */
function guestRoute(guest: WebContents): string {
  const url = guest.getURL()
  if (!URL.canParse(url)) return ''
  const parsed = new URL(url)
  return cleanText(`${parsed.pathname}${parsed.search}`, MAX_ROUTE_LENGTH) ?? ''
}

/**
 * Clamps the union of the selected element rectangles into the guest viewport and converts
 * CSS pixels to DIP.
 * @returns the capture rectangle, or undefined when every rectangle is off-viewport or degenerate.
 */
function clampRects(items: readonly { rect: DesktopBrowserElementSnapshot['rect']
  viewport: DesktopBrowserElementSnapshot['viewport'] }[],
zoom: number): { x: number; y: number; width: number; height: number } | undefined {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = 0
  let bottom = 0
  for (const { rect, viewport } of items) {
    const clampedLeft = Math.max(0, rect.x)
    const clampedTop = Math.max(0, rect.y)
    const clampedRight = Math.min(rect.x + rect.width, viewport.width)
    const clampedBottom = Math.min(rect.y + rect.height, viewport.height)
    if (!(clampedRight > clampedLeft) || !(clampedBottom > clampedTop)) continue
    left = Math.min(left, clampedLeft)
    top = Math.min(top, clampedTop)
    right = Math.max(right, clampedRight)
    bottom = Math.max(bottom, clampedBottom)
  }
  if (!Number.isFinite(left) || !Number.isFinite(top) || right <= left || bottom <= top) return undefined
  return {
    x: Math.round(left * scale),
    y: Math.round(top * scale),
    width: Math.max(1, Math.round((right - left) * scale)),
    height: Math.max(1, Math.round((bottom - top) * scale)),
  }
}
