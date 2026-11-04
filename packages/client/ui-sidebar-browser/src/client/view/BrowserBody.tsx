/** Common browser chrome; a presentation adapter attaches the page inside its content container. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Button,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseOutlineRegular,
  IconEditOutlineRegular,
  IconLinkOutlineRegular,
  IconRefreshOutlineRegular, Tooltip,
  IconRightUpOutlineRegular,
  SHIELD_OUTLINE_PATH,
  ICON_REGULAR_STROKE,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { formatBrowserAnnotation, nextAnnotationNumber } from '../browser/BrowserAnnotation.ts'
import type { BrowserAnnotationCapture } from '../browser/BrowserAnnotation.ts'
import type { BrowserInjected } from '../browser/BrowserController.ts'
import { emptyBrowserFrame } from '../browser/BrowserFrame.ts'
import { currentBrowserTarget } from '../browser/BrowserPersistence.ts'
import type { BrowserStore } from '../browser/store.ts'
import css from './Browser.module.css'

const EMPTY_FRAME = emptyBrowserFrame()

/** Composer attachment handle returned by the annotation draft bridge. */
type AnnotationDraftHandle = Exclude<ReturnType<NonNullable<BrowserInjected['annotationDrafts']>['create']>, undefined>

/** One saved element annotation awaiting insertion into the composer. */
interface AnnotationRecord {
  readonly id: string
  readonly capture: BrowserAnnotationCapture
  readonly comment: string
}

function SandboxPolicyIcon({ sandboxed }: { readonly sandboxed: boolean }): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE_PATH} stroke="currentColor" strokeWidth={ICON_REGULAR_STROKE} strokeLinejoin="round" />
      {sandboxed
        ? <path d="M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z" fill="currentColor" />
        : <path d="M10.6074 4.40278L8.00975 6.99973L10.6074 9.59739L9.59736 10.6074L6.9997 8.00978L4.40274 10.6074L3.3927 9.59739L5.98966 6.99973L3.3927 4.40278L4.40274 3.39273L6.9997 5.98969L9.59736 3.39273L10.6074 4.40278Z" fill="currentColor" transform="translate(1.2 0.8)" />}
    </svg>
  )
}

/** Browser body props assembled by the tab seat. */
export type BrowserBodyProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<BrowserStore>
  & PropsLocale<'sidebarBrowser'>
  & InjectFace<BrowserInjected>

function useBrowserDraft(url: string | undefined, revision: number): readonly [string, (value: string) => void] {
  const [edit, setEdit] = useState<{ readonly revision: number; readonly value: string }>()
  return [edit?.revision === revision ? edit.value : url ?? '',
    (value) => { setEdit({ revision, value }) }]
}

/** Render provider-neutral navigation state and optional controls. */
export function BrowserBody(props: BrowserBodyProps): ReactNode {
  const { mount, loadUrl, restore, goBack, goForward, reload, setSandbox, beginAnnotation, cancelAnnotation,
    annotationDrafts, useBrowserState, useStore, useTabInfo, useInput, inputActions, t } = props
  const { tab } = useTabInfo()
  useEffect(() => tab.actions.bindCommands({ refresh: () => { reload(tab.id) } }), [tab.actions, tab.id, reload])
  const saved = useStore(state => state.byTab[tab.id])
  const initial = useRef(saved)
  const initialUrl = useRef(tab.navigation.params?.url)
  const viewportId = useId()
  const [mountEpoch, setMountEpoch] = useState(0)
  const state = useBrowserState(tab.id)
  const frame = state?.frame ?? EMPTY_FRAME
  const restoreTarget = state === undefined ? currentBrowserTarget(initial.current) : state.restoreTarget
  const target = frame.target ?? restoreTarget
  const [draft, setDraft] = useBrowserDraft(target?.url ?? initialUrl.current, state?.addressRevision ?? 0)
  const draftText = useInput(state => state.draft)
  const inputPhase = useInput(state => state.phase)
  const [annotating, setAnnotating] = useState(false)
  const [editing, setEditing] = useState<{ readonly capture: BrowserAnnotationCapture; readonly comment: string }>()
  const [records, setRecords] = useState<readonly AnnotationRecord[]>([])
  const [notice, setNotice] = useState<string | undefined>()
  const recordSeq = useRef(0)
  const cancelSuppressed = useRef(false)

  useLayoutEffect(() => {
    const hide = mount({
      tabId: tab.id, signal: tab.signal, viewportId, applicationOrigin: window.location.origin,
      initial: initial.current, initialUrl: initialUrl.current,
      openTab: (url) => { tab.actions.openTab('browser', { params: { url }, revealIfOpened: false }) },
    })
    setMountEpoch(value => value + 1)
    return hide
  }, [mount, tab.id, tab.signal, tab.actions, viewportId, props.actions])

  const unknown = frame.address === 'unknown'
  const externalUrl = unknown ? undefined : target?.url
  const sandboxed = frame.sandboxEnabled
  const failure = state?.addressFailure
  const error = frame.error
  const canAnnotate = state?.canAnnotate === true && target !== undefined
  const submit = (event: FormEvent): void => { event.preventDefault(); loadUrl(tab.id, draft) }

  useEffect(() => {
    if (!annotating && editing === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (annotating) { cancelSuppressed.current = true; cancelAnnotation(tab.id); setAnnotating(false) }
      else setEditing(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [annotating, editing, cancelAnnotation, tab.id])

  const startCapture = (): void => {
    if (annotating) {
      cancelSuppressed.current = true
      cancelAnnotation(tab.id)
      setAnnotating(false)
      return
    }
    setNotice(undefined)
    setAnnotating(true)
    void beginAnnotation(tab.id).then((capture) => {
      setAnnotating(false)
      if (capture === undefined) {
        if (!cancelSuppressed.current) setNotice(t('annotation.error.notReady'))
        cancelSuppressed.current = false
        return
      }
      cancelSuppressed.current = false
      setEditing({ capture, comment: '' })
    })
  }

  const saveRecord = (): void => {
    if (editing === undefined || editing.comment.trim() === '') return
    recordSeq.current += 1
    const record: AnnotationRecord = { id: `annotation-${String(recordSeq.current)}`, capture: editing.capture, comment: editing.comment }
    setRecords(current => [...current, record])
    setEditing(undefined)
  }

  const addRecords = (): void => {
    if (records.length === 0) return
    if (inputPhase !== 'plain') { setNotice(t('annotation.error.composerBusy')); return }
    setNotice(undefined)
    const base = nextAnnotationNumber(draftText)
    const numbered = records.map((record, index) => ({ record, number: base + index }))
    const files = numbered.flatMap(({ record, number }) => record.capture.screenshot === undefined ? []
      : [new File([record.capture.screenshot.bytes as Uint8Array<ArrayBuffer>], `screenshot-${number}.png`, { type: 'image/png' })])
    const drafts = annotationDrafts?.create(files)
    if (drafts === undefined && files.length > 0) setNotice(t('annotation.error.draftsUnavailable'))
    const withDrafts = drafts !== undefined
    if (drafts !== undefined && !inputActions.addAttachments(drafts.ids)) {
      drafts.release()
      setNotice(t('annotation.error.composerBusy'))
      return
    }
    const ids = drafts?.ids ?? []
    const idByRecord = new Map<string, AnnotationDraftHandle['ids'][number]>()
    let shotIndex = 0
    let done = 0
    for (const { record, number } of numbered) {
      const { screenshot, ...textOnly } = record.capture
      const hasShot = withDrafts && screenshot !== undefined
      if (hasShot) {
        const id = ids[shotIndex]
        if (id !== undefined) idByRecord.set(record.id, id)
        shotIndex += 1
      }
      const capture = hasShot ? record.capture : textOnly
      if (!inputActions.insertQuote(formatBrowserAnnotation({ capture, comment: record.comment }, number))) break
      done += 1
    }
    if (done < numbered.length) {
      // Quotes that did not enter the composer leave their screenshots orphaned; detach and drop them.
      for (const { record } of numbered.slice(done)) {
        const id = idByRecord.get(record.id)
        if (id !== undefined) inputActions.removeAttachment(id)
      }
      setRecords(numbered.slice(done).map(({ record }) => record))
      setNotice(t('annotation.error.insertPartial', { done: String(done), total: String(numbered.length) }))
      return
    }
    setRecords([])
  }

  return (
    <div className={css.root}>
      <form className={css.toolbar} onSubmit={submit}>
        <button type="button" className={css.tool} aria-label={t('back')} title={t('back')} disabled={!frame.canGoBack} onClick={() => { goBack(tab.id) }}><IconChevronLeftOutlineRegular /></button>
        <button type="button" className={css.tool} aria-label={t('forward')} title={t('forward')} disabled={!frame.canGoForward} onClick={() => { goForward(tab.id) }}><IconChevronRightOutlineRegular /></button>
        <Tooltip label={t('reload')} shortcutKeys={tab.refreshShortcut?.keys} side="bottom" delayMs={500}>
          <button type="button" className={css.tool} aria-label={t('reload')} aria-keyshortcuts={tab.refreshShortcut?.aria} disabled={target === undefined || mountEpoch === 0} onClick={() => { reload(tab.id) }}><IconRefreshOutlineRegular /></button>
        </Tooltip>
        <div className={css.addressBox}>
          <input
            className={[css.address, unknown ? css.addressUnknown : ''].join(' ')}
            value={draft}
            aria-label={t('address.placeholder')}
            placeholder={t('address.placeholder')}
            spellCheck={false}
            onChange={(event) => { setDraft(event.currentTarget.value) }}
          />
          {unknown && <span className={css.addressChanged}>{t('address.changed')}</span>}
          <button type="submit" className={[css.tool, css.addressGo].join(' ')} aria-label={t('go')} title={t('go')}><IconLinkOutlineRegular /></button>
        </div>
        <button type="button" className={css.tool} aria-label={t('external')} title={t('external')} disabled={externalUrl === undefined}
          onClick={externalUrl === undefined ? undefined : () => { window.open(externalUrl, '_blank', 'noopener,noreferrer') }}
        ><IconRightUpOutlineRegular size={14} /></button>
        {sandboxed !== undefined && <button
          type="button"
          className={[css.tool, sandboxed ? '' : css.sandboxOff].join(' ')}
          aria-label={t(sandboxed ? 'sandbox.disable' : 'sandbox.enable')}
          title={t(sandboxed ? 'sandbox.disable' : 'sandbox.enable')}
          aria-pressed={!sandboxed}
          onClick={() => { setSandbox(tab.id, !sandboxed) }}
        ><SandboxPolicyIcon sandboxed={sandboxed} /></button>}
        {canAnnotate && <Tooltip label={t(annotating ? 'annotation.capture.cancel' : 'annotation.capture')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={[css.tool, annotating ? css.toolActive : ''].join(' ')}
            aria-label={t(annotating ? 'annotation.capture.cancel' : 'annotation.capture')}
            aria-pressed={annotating}
            onClick={startCapture}
          ><IconEditOutlineRegular /></button>
        </Tooltip>}
      </form>
      {annotating && <div className={css.annotationHint} role="status">{t('annotation.capture.hint')}</div>}
      {sandboxed === false && <div className={css.sandboxWarning} role="status">{t('sandbox.warning')}</div>}
      {error !== undefined && <div className={css.failure} role="status">{error.code !== undefined && error.description !== undefined
        ? t('load.failed.detail', { code: String(error.code), description: error.description })
        : t('load.failed')}</div>}
      {failure !== undefined && <div className={css.failure} role="alert">{t(`error.${failure}`)}</div>}
      <div className={css.content} aria-busy={frame.loading}>
        <div id={viewportId} className={css.viewport} aria-label={t('type.label')} />
        {restoreTarget !== undefined && <section className={css.restore} aria-label={t('restore.previous')}>
          <p className={css.restoreLabel}>{t('restore.previous')}</p>
          <p className={css.restoreTitle}>{restoreTarget.title}</p>
          <p className={css.restoreUrl}>{restoreTarget.url}</p>
          <Button variant="primary" size="sm" disabled={mountEpoch === 0} onClick={() => { restore(tab.id) }}>
            {t('restore.action')}
          </Button>
        </section>}
        {restoreTarget === undefined && (target === undefined || frame.loading) && error === undefined && <div className={css.placeholder}>
          <div className={css.start}>{t(target === undefined ? 'start' : 'loading')}</div>
        </div>}
        {editing !== undefined && <section className={css.annotationEditor} aria-label={t('annotation.editor.label')}>
          <textarea
            className={css.annotationInput}
            value={editing.comment}
            placeholder={t('annotation.editor.placeholder')}
            aria-label={t('annotation.editor.label')}
            onChange={(event) => { setEditing({ ...editing, comment: event.currentTarget.value }) }}
          />
          <div className={css.annotationActions}>
            <Button variant="ghost" size="sm" onClick={() => { setEditing(undefined) }}>{t('annotation.editor.cancel')}</Button>
            <Button variant="primary" size="sm" disabled={editing.comment.trim() === ''} onClick={saveRecord}>{t('annotation.editor.save')}</Button>
          </div>
        </section>}
      </div>
      {(records.length > 0 || notice !== undefined) && <div className={css.annotationBar}>
        {records.length > 0 && <span className={css.annotationCount}>{t('annotation.records.count', { count: String(records.length) })}</span>}
        {records.length > 0 && <div className={css.annotationChips}>
          {records.map((record) => {
            const first = record.capture.targets[0]
            const extra = record.capture.targets.length - 1
            return <span key={record.id} className={css.annotationChip}>
              <span className={css.annotationChipText}>
                {first === undefined ? '' : `${first.snapshot.tagName} ${first.snapshot.text}`}
                {extra > 0 ? ` +${String(extra)}` : ''}
              </span>
              <button type="button" className={css.annotationDelete} aria-label={t('annotation.records.delete')}
                onClick={() => { setRecords(current => current.filter(entry => entry.id !== record.id)) }}
              ><IconCloseOutlineRegular size={10} /></button>
            </span>
          })}
        </div>}
        {notice !== undefined && <span className={css.annotationNotice} role="status">{notice}</span>}
        {records.length > 0 && <Button variant="outline" size="sm" disabled={inputPhase !== 'plain'}
          title={inputPhase !== 'plain' ? t('annotation.error.composerBusy') : undefined}
          onClick={addRecords}
        >{t('annotation.records.add')}</Button>}
      </div>}
      {unknown && <p className={css.limit}>{t('address.unknown')}</p>}
    </div>
  )
}
