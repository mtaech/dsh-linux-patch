/** Pure annotation helpers: payload mapping, draft numbering, and quote formatting. */
import { describe, expect, it } from 'vitest'
import type { DesktopBrowserElementCapture } from '../src/types.ts'
import { formatBrowserAnnotation, newAnnotationRequestId, nextAnnotationNumber, toBrowserAnnotationCapture } from '../src/client/browser/BrowserAnnotation.ts'

function captureFixture(): DesktopBrowserElementCapture {
  return {
    url: 'https://example.test/page', title: 'Example', route: 'https://example.test/',
    targets: [{
      locator: { cssPath: 'html > body > main > button', candidates: ['main > button', '[data-test=submit]'], testId: 'submit',
        id: 'submit', role: 'button', name: 'Submit', text: 'Submit form', tagName: 'BUTTON',
        ancestors: ['HTML', 'BODY', 'MAIN'], fingerprint: 'fp-1' },
      snapshot: { text: 'Submit form', role: 'button', name: 'Submit', tagName: 'BUTTON',
        attributes: { id: 'submit', class: 'primary' }, htmlSummary: '<button id="submit">Submit form</button>',
        rect: { x: 10, y: 20, width: 80, height: 24 },
        viewport: { width: 1280, height: 720, devicePixelRatio: 2, scrollX: 0, scrollY: 40 } },
    }],
    screenshot: { mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]), width: 80, height: 24, cropped: true },
    capturedAt: '2026-11-04T05:00:00.000Z',
  }
}

describe('toBrowserAnnotationCapture', () => {
  it('maps every payload field without copying screenshot bytes', () => {
    const payload = captureFixture()
    const capture = toBrowserAnnotationCapture(payload)
    expect(capture).toEqual(payload)
    expect(capture.screenshot?.bytes).toBe(payload.screenshot?.bytes)
    expect(capture.screenshot?.cropped).toBe(true)
  })

  it('maps captures without a screenshot', () => {
    const { screenshot: omitted, ...payload } = captureFixture()
    void omitted
    expect(toBrowserAnnotationCapture(payload).screenshot).toBeUndefined()
  })
})

describe('nextAnnotationNumber', () => {
  it('starts at 1 for a draft without quotes', () => {
    expect(nextAnnotationNumber('')).toBe(1)
    expect(nextAnnotationNumber('plain draft\nno quotes here')).toBe(1)
  })

  it('continues after the highest number, including quoted prefixes', () => {
    expect(nextAnnotationNumber('## Web Element Annotation 1')).toBe(2)
    expect(nextAnnotationNumber('> ## Web Element Annotation 1\n> body\n> ## Web Element Annotation 3\n> tail')).toBe(4)
  })

  it('ignores numbered headings outside annotation quotes', () => {
    expect(nextAnnotationNumber('## Web Element Annotation 2\n## Other Heading 9')).toBe(3)
  })
})

describe('formatBrowserAnnotation', () => {
  it('formats every capture field, the untrusted-content notice, and the comment', () => {
    const formatted = formatBrowserAnnotation({ capture: toBrowserAnnotationCapture(captureFixture()), comment: 'Look at this' }, 2)
    expect(formatted).toContain('## Web Element Annotation 2')
    expect(formatted).toContain('Page: https://example.test/page')
    expect(formatted).toContain('Title: Example')
    expect(formatted).toContain('Route: https://example.test/')
    expect(formatted).toContain('Elements: 1')
    expect(formatted).toContain('Element 1: BUTTON — Submit form')
    expect(formatted).toContain('  Role: button')
    expect(formatted).toContain('  Name: Submit')
    expect(formatted).toContain('  Selector: html > body > main > button')
    expect(formatted).toContain('  Candidates: main > button | [data-test=submit]')
    expect(formatted).toContain('  Ancestors: HTML > BODY > MAIN')
    expect(formatted).toContain('  Viewport: 1280x720@2x scroll(0, 40)')
    expect(formatted).toContain('  Rect: x=10 y=20 w=80 h=24')
    expect(formatted).toContain('Captured: 2026-11-04T05:00:00.000Z')
    expect(formatted).toContain('<button id="submit">Submit form</button>')
    expect(formatted).toContain('Screenshot: screenshot-2.png')
    expect(formatted).toContain('untrusted web page content')
    expect(formatted.endsWith('Comment:\nLook at this')).toBe(true)
  })

  it('reports the absence of a screenshot', () => {
    const { screenshot: omitted, ...payload } = captureFixture()
    void omitted
    expect(formatBrowserAnnotation({ capture: toBrowserAnnotationCapture(payload), comment: '' }, 1))
      .toContain('Screenshot: none')
  })

  it('keeps only the first line of multi-line element text', () => {
    const payload = captureFixture()
    const [first] = payload.targets
    const target = { ...first!, snapshot: { ...first!.snapshot, text: 'first line\nsecond line' } }
    const capture = toBrowserAnnotationCapture({ ...payload, targets: [target] })
    expect(formatBrowserAnnotation({ capture, comment: '' }, 1)).toContain('Element 1: BUTTON — first line')
    expect(formatBrowserAnnotation({ capture, comment: '' }, 1)).not.toContain('second line')
  })

  it('truncates long element text with an ellipsis', () => {
    const payload = captureFixture()
    const [first] = payload.targets
    const target = { ...first!, snapshot: { ...first!.snapshot, text: 'a'.repeat(300) } }
    const capture = toBrowserAnnotationCapture({ ...payload, targets: [target] })
    const formatted = formatBrowserAnnotation({ capture, comment: '' }, 1)
    expect(formatted).toContain(`Element 1: BUTTON — ${'a'.repeat(200)}…`)
  })

  it('builds a longer fence around HTML summaries containing backticks', () => {
    const payload = captureFixture()
    const [first] = payload.targets
    const target = { ...first!, snapshot: { ...first!.snapshot, htmlSummary: '<code>```ts\n```</code>' } }
    const capture = toBrowserAnnotationCapture({ ...payload, targets: [target] })
    const formatted = formatBrowserAnnotation({ capture, comment: '' }, 1)
    expect(formatted).toContain('````html')
    expect(formatted).toContain('```ts\n```')
  })
})

describe('newAnnotationRequestId', () => {
  it('mints a unique request id per call', () => {
    expect(newAnnotationRequestId()).not.toBe(newAnnotationRequestId())
  })
})

describe('multi-element annotations', () => {
  it('quotes every selected element in pick order under one heading', () => {
    const payload = captureFixture()
    const [first] = payload.targets
    const second = {
      locator: { ...first!.locator, cssPath: 'html > body > main > a', fingerprint: 'fp-2' },
      snapshot: { ...first!.snapshot, tagName: 'A', text: 'Details' },
    }
    const formatted = formatBrowserAnnotation(
      { capture: toBrowserAnnotationCapture({ ...payload, targets: [first!, second] }), comment: 'Align these' }, 3,
    )
    expect(formatted).toContain('## Web Element Annotation 3')
    expect(formatted).toContain('Elements: 2')
    expect(formatted).toContain('Element 1: BUTTON — Submit form')
    expect(formatted).toContain('Element 2: A — Details')
    expect(formatted.indexOf('Element 1:')).toBeLessThan(formatted.indexOf('Element 2:'))
    expect(formatted.endsWith('Comment:\nAlign these')).toBe(true)
  })
})

describe('component hints', () => {
  it('quotes the owning component when the page exposes one', () => {
    const payload = captureFixture()
    const [first] = payload.targets
    const target = { ...first!, snapshot: { ...first!.snapshot, componentName: 'CheckoutButton' } }
    const formatted = formatBrowserAnnotation({ capture: toBrowserAnnotationCapture({ ...payload, targets: [target] }), comment: '' }, 1)
    expect(formatted).toContain('  Component: CheckoutButton')
  })

  it('omits the component line when the page exposes none', () => {
    const formatted = formatBrowserAnnotation({ capture: toBrowserAnnotationCapture(captureFixture()), comment: '' }, 1)
    expect(formatted).not.toContain('Component:')
  })
})
