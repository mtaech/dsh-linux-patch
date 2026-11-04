/** Element-annotation capture against the Electron carrier: mapping, cancellation, and lease gating. */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { DesktopBrowserAnnotationBridge, DesktopBrowserElementCapture, DesktopBrowserLeaseId } from '../src/types.ts'
import { electronFixture } from './electron-harness.client.ts'

function capturePayload(): DesktopBrowserElementCapture {
  return {
    url: 'https://example.test/page', title: 'Example', route: 'https://example.test/',
    targets: [{
      locator: { cssPath: 'html > body > main > button', candidates: ['main > button'], tagName: 'BUTTON',
        ancestors: ['HTML', 'BODY', 'MAIN'], fingerprint: 'fp-1' },
      snapshot: { text: 'Submit', role: 'button', name: 'Submit', tagName: 'BUTTON', attributes: {},
        htmlSummary: '<button>Submit</button>', rect: { x: 1, y: 2, width: 3, height: 4 },
        viewport: { width: 1280, height: 720, devicePixelRatio: 1, scrollX: 0, scrollY: 0 } },
    }],
    screenshot: { mediaType: 'image/png', bytes: new Uint8Array([9]), width: 3, height: 4, cropped: false },
    capturedAt: '2026-11-04T05:00:00.000Z',
  }
}

/** Mount the fixture guest and reach an observed page ready for captures. */
async function mountedGuest(annotations: DesktopBrowserAnnotationBridge) {
  const fixture = electronFixture(undefined, annotations)
  fixture.mount()
  fixture.frame.loadUrl({ kind: 'https', url: 'https://example.test/', title: 'Example' })
  const guest = await fixture.guest()
  guest.emit('dom-ready')
  guest.state.url = 'https://example.test/'
  guest.emit('did-navigate')
  return { fixture, guest }
}

describe('ElectronWebViewImpl annotations', () => {
  it('hides the control when the bridge offers no annotation support', async () => {
    const fixture = electronFixture()
    expect(fixture.frame.annotations).toBeUndefined()
    await fixture.dispose()
  })

  it('resolves undefined before the lease exists without contacting the bridge', async () => {
    const capture = vi.fn(async () => capturePayload())
    const annotations = { capture, cancel: vi.fn(async () => {}) } satisfies DesktopBrowserAnnotationBridge
    const fixture = electronFixture(undefined, annotations)
    expect(fixture.frame.annotations).toBeDefined()
    await expect(fixture.frame.annotations!.capture(new AbortController().signal)).resolves.toBeUndefined()
    expect(capture).not.toHaveBeenCalled()
    expect(annotations.cancel).not.toHaveBeenCalled()
    await fixture.dispose()
  })

  it('returns the mapped capture from the bridge', async () => {
    const payload = capturePayload()
    const capture = vi.fn(async (_lease: DesktopBrowserLeaseId, _requestId: string) => payload)
    const annotations = { capture, cancel: vi.fn(async () => {}) } satisfies DesktopBrowserAnnotationBridge
    const { fixture } = await mountedGuest(annotations)
    const result = await fixture.frame.annotations!.capture(new AbortController().signal)
    expect(result).toEqual(payload)
    const [lease, requestId] = capture.mock.calls[0]!
    expect(lease).toBe(fixture.reservation.lease)
    expect(requestId).toBeTypeOf('string')
    await fixture.dispose()
  })

  it('cancels through the bridge when the caller aborts', async () => {
    const payload = capturePayload()
    let settle: (payload: DesktopBrowserElementCapture) => void = () => {}
    const capture = vi.fn(async () => new Promise<DesktopBrowserElementCapture>((resolve) => { settle = resolve }))
    const annotations = { capture, cancel: vi.fn(async () => {}) } satisfies DesktopBrowserAnnotationBridge
    const { fixture } = await mountedGuest(annotations)
    const abort = new AbortController()
    const pending = fixture.frame.annotations!.capture(abort.signal)
    abort.abort()
    settle(payload)
    await expect(pending).resolves.toBeUndefined()
    expect(annotations.cancel).toHaveBeenCalledWith(fixture.reservation.lease, expect.any(String))
    await fixture.dispose()
  })

  it('cancels an in-flight capture on loadUrl', async () => {
    let settle: (payload: DesktopBrowserElementCapture) => void = () => {}
    const capture = vi.fn(async () => new Promise<DesktopBrowserElementCapture>((resolve) => { settle = resolve }))
    const annotations = { capture, cancel: vi.fn(async () => {}) } satisfies DesktopBrowserAnnotationBridge
    const { fixture, guest } = await mountedGuest(annotations)
    const pending = fixture.frame.annotations!.capture(new AbortController().signal)
    fixture.frame.loadUrl({ kind: 'https', url: 'https://example.test/next', title: 'Next' })
    settle(capturePayload())
    await expect(pending).resolves.toBeUndefined()
    expect(annotations.cancel).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledTimes(1)
    await fixture.dispose()
    expect(guest.loadURL).toHaveBeenCalledWith('https://example.test/next')
  })

  it('cancels an in-flight capture on reload and goBack', async () => {
    let settle: (payload: DesktopBrowserElementCapture) => void = () => {}
    const capture = vi.fn(async () => new Promise<DesktopBrowserElementCapture>((resolve) => { settle = resolve }))
    const annotations = { capture, cancel: vi.fn(async () => {}) } satisfies DesktopBrowserAnnotationBridge
    const { fixture, guest } = await mountedGuest(annotations)
    guest.state.back = true
    guest.emit('did-navigate')
    const first = fixture.frame.annotations!.capture(new AbortController().signal)
    fixture.frame.reload()
    settle(capturePayload())
    await expect(first).resolves.toBeUndefined()
    expect(annotations.cancel).toHaveBeenCalledTimes(1)
    const second = fixture.frame.annotations!.capture(new AbortController().signal)
    fixture.frame.goBack()
    settle(capturePayload())
    await expect(second).resolves.toBeUndefined()
    expect(annotations.cancel).toHaveBeenCalledTimes(2)
    expect(guest.reload).toHaveBeenCalledTimes(1)
    expect(guest.goBack).toHaveBeenCalledTimes(1)
    await fixture.dispose()
  })

  it('cancels an in-flight capture on disposal', async () => {
    let settle: (payload: DesktopBrowserElementCapture) => void = () => {}
    const capture = vi.fn(async () => new Promise<DesktopBrowserElementCapture>((resolve) => { settle = resolve }))
    const annotations = { capture, cancel: vi.fn(async () => {}) } satisfies DesktopBrowserAnnotationBridge
    const { fixture } = await mountedGuest(annotations)
    const pending = fixture.frame.annotations!.capture(new AbortController().signal)
    const disposal = fixture.dispose()
    settle(capturePayload())
    await expect(pending).resolves.toBeUndefined()
    await expect(disposal).resolves.toBeUndefined()
    expect(annotations.cancel).toHaveBeenCalledTimes(1)
    expect(fixture.reservation.lease).toBeTypeOf('string')
  })
})
