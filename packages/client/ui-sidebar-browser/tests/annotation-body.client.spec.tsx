// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createBrowserControllers, type BrowserInjected } from '../src/client/browser/BrowserController.ts'
import type { BrowserAnnotationCapture, BrowserAnnotationControl } from '../src/client/browser/BrowserAnnotation.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'
import type { BrowserBodyProps } from '../src/client/view/BrowserBody.tsx'
import { BrowserBody } from '../src/client/view/BrowserBody.tsx'
import { zh } from '../src/client/locales.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { emptyBrowserFrame, type BrowserFrameState } from '../src/client/browser/BrowserFrame.ts'
import type { BrowserPageFactory } from '../src/client/browser/BrowserPage.ts'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'

const SESSION = 'session' as SessionId
const TAB = 'tab' as TabId
const messages: Readonly<Record<string, string>> = zh
const lifetimes = new Set<AbortController>()
const controllers: BrowserInjected[] = []
let mountSequence = 0

function localize(key: string, params?: Record<string, unknown>): string {
  const template = messages[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name]))
}

function hookOf<T>(store: { subscribe(listener: () => void): () => void; getSnapshot(): T }) {
  return function useSelector<S>(select: (state: T) => S): S {
    return select(useSyncExternalStore(
      listener => store.subscribe(listener),
      () => store.getSnapshot(),
    ))
  }
}

function asId(value: string): DraftAttachmentId {
  return value as DraftAttachmentId
}

function captureOf(): BrowserAnnotationCapture {
  return {
    url: 'https://example.com/page', title: 'Example', route: 'known',
    targets: [{
      locator: { cssPath: 'body > a', candidates: ['a.example'], tagName: 'a', ancestors: ['body'], fingerprint: 'fp-1' },
      snapshot: {
        text: 'Example link', role: 'link', name: 'Example', tagName: 'a', attributes: {},
        htmlSummary: '<a href="/">Example link</a>',
        rect: { x: 8, y: 8, width: 80, height: 20 },
        viewport: { width: 800, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
      },
    }],
    screenshot: { mediaType: 'image/png', bytes: new Uint8Array([137, 80]), width: 80, height: 20, cropped: true },
    capturedAt: '2026-11-04T05:00:00.000Z',
  }
}

interface AnnotationHarnessOptions {
  /** Mount a capture-capable frame wired to the harness's deferred capture queue. */
  readonly annotatable?: boolean
}

function mountBrowser(options: AnnotationHarnessOptions = {}) {
  const frames = createSnapshotStore<BrowserFrameState>({ ...emptyBrowserFrame(),
    target: { kind: 'https', url: 'https://example.com/page', title: 'Example' }, address: 'observed' })
  const pendingCaptures: ((capture: BrowserAnnotationCapture | undefined) => void)[] = []
  const captureAborts: AbortSignal[] = []
  const captureControl: BrowserAnnotationControl = {
    capture: signal => new Promise<BrowserAnnotationCapture | undefined>((resolve) => {
      pendingCaptures.push(resolve)
      captureAborts.push(signal)
      signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
    }),
  }
  const store = createBrowserStore().create(`annotation-body-test-${String(++mountSequence)}`)
  const lifetime = new AbortController()
  lifetimes.add(lifetime)
  const createPage: BrowserPageFactory = () => ({
    presentation: { mount: () => () => {} },
    frame: {
      getSnapshot: () => frames.getSnapshot(),
      subscribe: listener => frames.subscribe(listener),
      loadUrl: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), dispose: async () => {},
      annotations: options.annotatable === true ? captureControl : undefined,
    },
  })
  const injected = createBrowserControllers(store.actions, createPage, () => true)
  controllers.push(injected)
  const { keyedHooks, ...commands } = injected
  const tabActions = { bindCommands: vi.fn<ReturnType<BrowserBodyProps['useTabInfo']>['tab']['actions']['bindCommands']>(() => vi.fn()), openResource: vi.fn(), openTab: vi.fn(), close: vi.fn() }
  const inputStore = createSnapshotStore<InputState>({ draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] as InputState['queue'] })
  const inputActions = {
    insertQuote: vi.fn((text: string) => {
      inputStore.set({ ...inputStore.getSnapshot(), draft: `${inputStore.getSnapshot().draft}\n${text}` })
      return true
    }),
    captureInsertion: vi.fn(() => { throw new Error('annotation spec does not capture insertion') }),
    insertText: vi.fn(() => true),
    setDraft: vi.fn(),
    persistDraft: vi.fn(),
    addAttachments: vi.fn(() => true),
    removeAttachment: vi.fn(),
    pruneAttachments: vi.fn(),
    submit: vi.fn(),
  }
  const release = vi.fn()
  const createdIds: DraftAttachmentId[] = []
  let nextDraftId = 0
  const annotationDrafts = {
    create: vi.fn((files: readonly File[]) => {
      const ids = files.map(() => asId(`att-${String(++nextDraftId)}`))
      createdIds.push(...ids)
      return { ids, release }
    }),
  }
  const props: Pick<BrowserBodyProps, 'sessionId' | 'useTabInfo' | 'useStore' | 'actions' | 't' | 'useBrowserState' | 'useInput' | 'inputActions'>
    & Omit<BrowserInjected, 'keyedHooks'> = {
      sessionId: SESSION,
      useTabInfo: () => ({
        sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane' as PaneId, isFloating: false },
        tab: {
          id: TAB, kind: 'browser', title: 'Browser', contentId: 'sidebar://browser/1', visible: true,
          navigation: { address: 'sidebar://browser/1', params: undefined, revision: 0 },
          signal: lifetime.signal,
          actions: tabActions, refreshShortcut: undefined,
        },
      }),
      useStore: hookOf(store),
      actions: store.actions,
      useInput: hookOf(inputStore),
      inputActions,
      t: localize,
      ...commands,
      annotationDrafts,
      useBrowserState: (key: string) => {
        const state = keyedHooks.browserState(key)
        return useSyncExternalStore(state?.subscribe ?? (() => () => {}), state?.getSnapshot ?? (() => undefined))
      },
    }
  const view = render(<BrowserBody {...props as BrowserBodyProps} />)
  return { view, frames, store, lifetime, injected, tabActions, inputStore, inputActions, annotationDrafts, release,
    createdIds, pendingCaptures, captureAborts }
}

/** Drive one capture round to a saved record through the real controller. */
async function captureAndSave(mounted: ReturnType<typeof mountBrowser>, value: BrowserAnnotationCapture): Promise<void> {
  const started = mounted.pendingCaptures.length
  fireEvent.click(mounted.view.getByRole('button', { name: zh['annotation.capture'] }))
  await waitFor(() => { expect(mounted.view.getByRole('status').textContent).toBe(zh['annotation.capture.hint']) })
  await waitFor(() => { expect(mounted.pendingCaptures.length).toBeGreaterThan(started) })
  await act(async () => { mounted.pendingCaptures[started]!(value) })
  const editor = mounted.view.getByRole('textbox', { name: zh['annotation.editor.label'] })
  fireEvent.change(editor, { target: { value: 'This link matters' } })
  fireEvent.click(mounted.view.getByRole('button', { name: zh['annotation.editor.save'] }))
  await waitFor(() => { expect(mounted.view.queryByRole('textbox', { name: zh['annotation.editor.label'] })).toBeNull() })
}

afterEach(async () => {
  cleanup()
  await Promise.all(controllers.splice(0).map(controller => controller.dispose()))
  for (const lifetime of lifetimes) lifetime.abort()
  lifetimes.clear()
  vi.restoreAllMocks()
})

describe('BrowserBody element annotation', () => {
  it('shows no annotation entry without a capture-capable frame', () => {
    const mounted = mountBrowser()
    expect(mounted.view.queryByRole('button', { name: zh['annotation.capture'] })).toBeNull()
    expect(mounted.view.queryByText(zh['annotation.capture.hint'])).toBeNull()
  })

  it('captures, edits in DSH DOM, saves, and inserts ordered quotes with screenshots', async () => {
    const mounted = mountBrowser({ annotatable: true })
    await captureAndSave(mounted, captureOf())
    expect(mounted.view.getByText(zh['annotation.records.count'].replace('{count}', '1'))).toBeDefined()
    fireEvent.click(mounted.view.getByRole('button', { name: zh['annotation.records.add'] }))

    expect(mounted.annotationDrafts.create).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ name: 'screenshot-1.png', type: 'image/png' }),
    ])
    expect(mounted.inputActions.addAttachments).toHaveBeenCalledExactlyOnceWith(mounted.createdIds)
    expect(mounted.inputActions.insertQuote).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('## Web Element Annotation 1'))
    const quote = mounted.inputActions.insertQuote.mock.calls[0]![0] as string
    expect(quote).toContain('Screenshot: screenshot-1.png')
    expect(mounted.inputActions.insertQuote.mock.invocationCallOrder[0]!)
      .toBeGreaterThan(mounted.inputActions.addAttachments.mock.invocationCallOrder[0]!)
    expect(mounted.release).not.toHaveBeenCalled()
    await waitFor(() => { expect(mounted.view.queryByText(zh['annotation.records.count'].replace('{count}', '1'))).toBeNull() })
  })

  it('cancels an in-flight capture with Escape and stays quiet', async () => {
    const mounted = mountBrowser({ annotatable: true })
    fireEvent.click(mounted.view.getByRole('button', { name: zh['annotation.capture'] }))
    await waitFor(() => { expect(mounted.captureAborts).toHaveLength(1) })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(mounted.captureAborts[0]!.aborted).toBe(true)
    await waitFor(() => { expect(mounted.view.queryByRole('status')).toBeNull() })
    expect(mounted.view.queryByRole('button', { name: zh['annotation.capture.cancel'] })).toBeNull()
    expect(mounted.view.queryByText(zh['annotation.error.notReady'])).toBeNull()
  })

  it('releases every draft and inserts no quote when attachment admission refuses', async () => {
    const mounted = mountBrowser({ annotatable: true })
    mounted.inputActions.addAttachments.mockImplementation(() => false)
    await captureAndSave(mounted, captureOf())
    fireEvent.click(mounted.view.getByRole('button', { name: zh['annotation.records.add'] }))
    expect(mounted.inputActions.insertQuote).not.toHaveBeenCalled()
    expect(mounted.createdIds).toEqual([asId('att-1')])
    expect(mounted.release).toHaveBeenCalledExactlyOnceWith()
  })

  it('keeps failed records and detaches orphaned screenshots on a partial insert', async () => {
    const mounted = mountBrowser({ annotatable: true })
    mounted.inputActions.insertQuote.mockImplementation((text: string) => !text.includes('Annotation 2'))
    await captureAndSave(mounted, captureOf())
    await captureAndSave(mounted, { ...captureOf(), capturedAt: '2026-11-04T05:01:00.000Z' })
    fireEvent.click(mounted.view.getByRole('button', { name: zh['annotation.records.add'] }))
    expect(mounted.inputActions.insertQuote).toHaveBeenCalledTimes(2)
    expect(mounted.inputActions.removeAttachment).toHaveBeenCalledExactlyOnceWith(asId('att-2'))
    expect(mounted.release).not.toHaveBeenCalled()
    expect(mounted.view.getByRole('status').textContent)
      .toBe(zh['annotation.error.insertPartial'].replace('{done}', '1').replace('{total}', '2'))
    expect(mounted.view.getByText(zh['annotation.records.count'].replace('{count}', '1'))).toBeDefined()
  })

  it('disables the composer hand-off while a message is being sent', async () => {
    const mounted = mountBrowser({ annotatable: true })
    await captureAndSave(mounted, captureOf())
    act(() => { mounted.inputStore.set({ ...mounted.inputStore.getSnapshot(), phase: 'sending' }) })
    expect(mounted.view.getByRole('button', { name: zh['annotation.records.add'] })).toHaveProperty('disabled', true)
  })

  it('inserts text-only quotes when the draft bridge is absent', async () => {
    const mounted = mountBrowser({ annotatable: true })
    mounted.annotationDrafts.create.mockImplementation(
      () => undefined as unknown as ReturnType<typeof mounted.annotationDrafts.create>)
    await captureAndSave(mounted, captureOf())
    fireEvent.click(mounted.view.getByRole('button', { name: zh['annotation.records.add'] }))
    expect(mounted.inputActions.addAttachments).not.toHaveBeenCalled()
    expect(mounted.inputActions.insertQuote).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Screenshot: none'))
    expect(mounted.view.getByRole('status').textContent).toBe(zh['annotation.error.draftsUnavailable'])
  })
})
