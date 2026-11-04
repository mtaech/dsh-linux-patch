import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DesktopBrowserAnnotations } from '../src/browser-annotation.ts'
import { ANNOTATION_ARM_SCRIPT, ANNOTATION_CANCEL_SCRIPT, annotationResolveCode } from '../src/browser-annotation-scripts.ts'

// The annotation capture path touches no Electron runtime exports, so Electron is not mocked here.
type GuestFixture = EventEmitter & Pick<WebContents,
  'id' | 'isDestroyed' | 'focus' | 'getURL' | 'getZoomFactor' | 'capturePage' | 'executeJavaScriptInIsolatedWorld'>
type GuestsFixture = { guest: (owner: WebContents, id: unknown) => WebContents | undefined }

const LEASE = 'lease-1' as DesktopBrowserLeaseId
const REQUEST_ID = 'request-1'

const makeImage = (pngBytes = 16) => ({
  isEmpty: () => false,
  getSize: () => ({ width: 200, height: 100 }),
  toPNG: () => Buffer.alloc(pngBytes),
  resize: vi.fn(() => makeImage(pngBytes)),
})

/** Builds a guest whose ARM evaluation resolves with the given payload, as a picked element would. */
const makeGuest = (armResult: Promise<unknown> | unknown, options: Partial<GuestFixture> = {}): GuestFixture => {
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    focus: vi.fn(),
    getURL: () => 'https://example.com/app?token=secret&page=2#section',
    getZoomFactor: () => 1,
    capturePage: vi.fn(async () => makeImage()),
    // The cancel teardown script resolves to nothing; only the arm script returns page data.
    executeJavaScriptInIsolatedWorld: vi.fn(async (_worldId: number, scripts: ReadonlyArray<{ code: string }>) =>
      scripts[0]?.code.includes('cancel()') === true ? null : armResult),
  }) as unknown as GuestFixture
  return Object.assign(guest, options)
}

const makeGuests = (guest: WebContents | undefined): GuestsFixture => ({
  guest: vi.fn((_owner: WebContents, _id: unknown) => guest),
})

const payload = (): unknown => ({
  title: 'Example',
  elements: [{
    locator: {
      cssPath: 'html > body > main > button#submit', candidates: ['#submit'],
      testId: 'submit-button', id: 'submit', role: 'button', name: 'Send it', text: 'Send',
      tagName: 'button', ancestors: ['html', 'body', 'main'], fingerprint: 'button|submit||html>body',
    },
    snapshot: {
      text: 'Send', role: 'button', name: 'Send it', tagName: 'button',
      attributes: { id: 'submit', type: 'button', style: 'color:red', value: 'x' },
      htmlSummary: '<button id="submit" type="button">',
      rect: { x: 10, y: 20, width: 120, height: 40 },
      viewport: { width: 800, height: 600, devicePixelRatio: 2, scrollX: 0, scrollY: 0 },
    },
  }],
})

describe('annotation scripts', () => {
  it('arms a fixed crosshair overlay source that never receives renderer input', () => {
    expect(ANNOTATION_ARM_SCRIPT).toContain('cursor:crosshair !important')
    expect(ANNOTATION_ARM_SCRIPT).toContain('z-index:2147483647 !important')
    expect(ANNOTATION_ARM_SCRIPT).toContain('document.elementFromPoint')
    expect(ANNOTATION_ARM_SCRIPT).toContain('stopImmediatePropagation()')
    expect(ANNOTATION_ARM_SCRIPT).toContain("'Escape'")
    expect(ANNOTATION_ARM_SCRIPT).toContain('120000')
    expect(ANNOTATION_ARM_SCRIPT).toContain('new MutationObserver')
  })

  it('cancels through the fixed no-op-safe teardown script', () => {
    expect(ANNOTATION_CANCEL_SCRIPT).toBe(`(() => {
  if (globalThis.__dshAnno && typeof globalThis.__dshAnno.cancel === 'function') globalThis.__dshAnno.cancel();
})()`)
  })

  it('serializes validated payloads as one JSON literal, never concatenated page data', () => {
    expect(annotationResolveCode({ a: 1 })).toBe('globalThis.__dshAnno.resolve({"a":1})')
    expect(annotationResolveCode({ text: 'a"b\nc' }))
      .toBe('globalThis.__dshAnno.resolve({"text":"a\\"b\\nc"})')
  })
})

describe('DesktopBrowserAnnotations', () => {
  it('rejects a lease that belongs to another window', async () => {
    const annotations = new DesktopBrowserAnnotations(makeGuests(undefined) as never)
    await expect(annotations.capture({} as WebContents, LEASE, REQUEST_ID)).rejects
      .toThrow('the lease has no live guest for this window')
  })

  it('rejects malformed request identifiers before touching the guest', async () => {
    const guest = makeGuest(payload())
    const annotations = new DesktopBrowserAnnotations(makeGuests(guest as WebContents) as never)
    for (const bad of ['', 'a'.repeat(65), 'bad id', 'no/slashes']) {
      await expect(annotations.capture({} as WebContents, LEASE, bad)).rejects.toThrow('invalid annotation request identifier')
    }
    expect(guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('ignores a stale cancel that names a different request', async () => {
    const owner = {} as WebContents
    const guest = makeGuest(new Promise(() => {}))
    const annotations = new DesktopBrowserAnnotations(makeGuests(guest as WebContents) as never)
    const pending = annotations.capture(owner, LEASE, REQUEST_ID)
    await annotations.cancel(owner, LEASE, 'request-other')
    const raced = await Promise.race([pending.then(() => 'settled'), Promise.resolve('pending')])
    expect(raced).toBe('pending')
    await annotations.cancel(owner, LEASE, REQUEST_ID)
    await expect(pending).resolves.toBeUndefined()
  })

  it('keeps url and route derived from the guest and sanitizes page-reported fields', async () => {
    const dirty = payload() as Record<string, unknown>
    const element = (dirty.elements as Record<string, unknown>[])[0]!
    const snapshot = element.snapshot as Record<string, unknown>
    snapshot.text = 'a'.repeat(600) + '\u0000\u0007'
    snapshot.htmlSummary = '<button>'.concat('x'.repeat(1200))
    const locator = element.locator as Record<string, unknown>
    locator.candidates = Array.from({ length: 8 }, (_, index) => `#candidate-${index}`)
    locator.ancestors = Array.from({ length: 9 }, (_, index) => `div-${index}`)
    locator.cssPath = 'div > '.repeat(400) + 'button'
    const guest = makeGuest(dirty)
    const annotations = new DesktopBrowserAnnotations(makeGuests(guest as WebContents) as never)
    const capture = await annotations.capture({} as WebContents, LEASE, REQUEST_ID)
    expect(capture).toBeDefined()
    expect(capture?.url).toBe('https://example.com/app?token=secret&page=2#section')
    expect(capture?.route).toBe('/app?token=secret&page=2')
    expect(capture?.targets[0]?.snapshot.text.length).toBeLessThanOrEqual(500)
    expect(capture?.targets[0]?.snapshot.text).not.toContain('\u0000')
    expect(capture?.targets[0]?.snapshot.htmlSummary.length).toBeLessThanOrEqual(1000)
    expect(capture?.targets[0]?.locator.candidates).toHaveLength(5)
    expect(capture?.targets[0]?.locator.ancestors).toHaveLength(6)
    expect(capture?.targets[0]?.locator.cssPath.length).toBeLessThanOrEqual(1024)
    expect(Object.keys(capture?.targets[0]?.snapshot.attributes ?? {})).toEqual(['id', 'type'])
  })

  it('drops unknown payloads instead of failing the capture promise', async () => {
    const annotations = new DesktopBrowserAnnotations(makeGuests(makeGuest(null) as WebContents) as never)
    await expect(annotations.capture({} as WebContents, LEASE, REQUEST_ID)).resolves.toBeUndefined()
    const partialGuest = makeGuest({ elements: [{ locator: { cssPath: 'div' } }] })
    const partial = new DesktopBrowserAnnotations(makeGuests(partialGuest as WebContents) as never)
    await expect(partial.capture({} as WebContents, LEASE, REQUEST_ID)).resolves.toBeUndefined()
  })

  it('captures the element rectangle and falls back to the viewport when cropping fails', async () => {
    const guest = makeGuest(payload())
    const image = makeImage()
    const capturePage = vi.fn(async (_rect?: unknown) => _rect === undefined
      ? Promise.resolve(image) : Promise.reject(new Error('crop failed')))
    Object.assign(guest, { capturePage })
    const annotations = new DesktopBrowserAnnotations(makeGuests(guest as WebContents) as never)
    const capture = await annotations.capture({} as WebContents, LEASE, REQUEST_ID)
    expect(capturePage).toHaveBeenCalledTimes(2)
    expect(capturePage.mock.calls[0]?.[0]).toEqual({ x: 10, y: 20, width: 120, height: 40 })
    expect(capture?.screenshot?.cropped).toBe(true)
    expect(capture?.screenshot?.bytes.byteLength).toBe(16)
  })

  it('scales screenshots over the long-edge budget and drops oversized PNG output', async () => {
    const oversizedPng = Buffer.alloc(21 * 1024 * 1024 + 1)
    const guest = makeGuest(payload())
    const oversized = Object.assign(makeImage(), { getSize: () => ({ width: 3200, height: 400 }), toPNG: () => oversizedPng })
    oversized.resize = vi.fn(() => Object.assign(makeImage(), { toPNG: () => oversizedPng }))
    Object.assign(guest, { capturePage: vi.fn(async () => oversized) })
    const dropped = new DesktopBrowserAnnotations(makeGuests(guest as WebContents) as never)
    const droppedCapture = await dropped.capture({} as WebContents, LEASE, REQUEST_ID)
    expect(oversized.resize).toHaveBeenCalled()
    expect(droppedCapture).toBeDefined()
    expect(droppedCapture?.screenshot).toBeUndefined()

    const resizingGuest = makeGuest(payload())
    const big = Object.assign(makeImage(1000), { getSize: () => ({ width: 3200, height: 400 }) })
    const scaled = makeImage()
    big.resize = vi.fn(() => scaled)
    Object.assign(resizingGuest, { capturePage: vi.fn(async () => big) })
    const resized = new DesktopBrowserAnnotations(makeGuests(resizingGuest as WebContents) as never)
    const resizedCapture = await resized.capture({} as WebContents, LEASE, REQUEST_ID)
    expect(big.resize).toHaveBeenCalledWith({ width: 1600 })
    expect(resizedCapture?.screenshot).toMatchObject({ width: 200, height: 100 })
  })

  it('resolves undefined when the guest is destroyed or navigates its main frame', async () => {
    const destroyedGuest = makeGuest(new Promise(() => {}))
    const destroyed = new DesktopBrowserAnnotations(makeGuests(destroyedGuest as WebContents) as never)
    const destroyedCapture = destroyed.capture({} as WebContents, LEASE, REQUEST_ID)
    destroyedGuest.emit('destroyed')
    await expect(destroyedCapture).resolves.toBeUndefined()

    const navigatingGuest = makeGuest(new Promise(() => {}))
    const navigating = new DesktopBrowserAnnotations(makeGuests(navigatingGuest as WebContents) as never)
    const navigatingCapture = navigating.capture({} as WebContents, LEASE, REQUEST_ID)
    navigatingGuest.emit('did-start-navigation', {}, 'https://example.com/next', false, true)
    await expect(navigatingCapture).resolves.toBeUndefined()
    // In-frame navigation does not interrupt the session.
    const frameGuest = makeGuest(new Promise(() => {}))
    const framed = new DesktopBrowserAnnotations(makeGuests(frameGuest as WebContents) as never)
    const framedCapture = framed.capture({} as WebContents, LEASE, REQUEST_ID)
    frameGuest.emit('did-start-navigation', {}, 'https://example.com/frame', false, false)
    frameGuest.emit('destroyed')
    await expect(framedCapture).resolves.toBeUndefined()
  })

  it('resolves undefined on escape input from the guest', async () => {
    const guest = makeGuest(new Promise(() => {}))
    const annotations = new DesktopBrowserAnnotations(makeGuests(guest as WebContents) as never)
    const pending = annotations.capture({} as WebContents, LEASE, REQUEST_ID)
    guest.emit('before-input-event', { preventDefault: () => {} }, { type: 'keyDown', key: 'Escape' })
    await expect(pending).resolves.toBeUndefined()
  })

  it('resolves undefined after the 120 second timeout', async () => {
    vi.useFakeTimers()
    try {
      const guest = makeGuest(new Promise(() => {}))
      const annotations = new DesktopBrowserAnnotations(makeGuests(guest as WebContents) as never)
      const pending = annotations.capture({} as WebContents, LEASE, REQUEST_ID)
      const raced = await Promise.race([pending.then(() => 'settled'), Promise.resolve('pending')])
      expect(raced).toBe('pending')
      await vi.advanceTimersByTimeAsync(120_000)
      await expect(pending).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles the previous session when the same guest captures again', async () => {
    const guest = makeGuest(new Promise(() => {}))
    const annotations = new DesktopBrowserAnnotations(makeGuests(guest as WebContents) as never)
    const first = annotations.capture({} as WebContents, LEASE, 'request-a')
    Object.assign(guest, {
      executeJavaScriptInIsolatedWorld: vi.fn(async (_worldId: number, scripts: ReadonlyArray<{ code: string }>) =>
        scripts[0]?.code.includes('cancel()') === true ? null : payload()),
    })
    const second = annotations.capture({} as WebContents, LEASE, 'request-b')
    await expect(first).resolves.toBeUndefined()
    const resolved = await second
    expect(resolved?.targets[0]?.locator.id).toBe('submit')
    expect(guest.focus).toHaveBeenCalled()
  })

  it('runs the arm script in the annotation isolated world and always tears down afterwards', async () => {
    const guest = makeGuest(payload())
    const annotations = new DesktopBrowserAnnotations(makeGuests(guest as WebContents) as never)
    await annotations.capture({} as WebContents, LEASE, REQUEST_ID)
    const calls = vi.mocked(guest.executeJavaScriptInIsolatedWorld).mock.calls
    expect(calls[0]?.[0]).toBe(1001)
    expect((calls[0]?.[1] as ReadonlyArray<{ code: string }>)[0]?.code).toBe(ANNOTATION_ARM_SCRIPT)
    expect((calls.at(-1)?.[1] as ReadonlyArray<{ code: string }>)[0]?.code).toBe(ANNOTATION_CANCEL_SCRIPT)
  })
})
