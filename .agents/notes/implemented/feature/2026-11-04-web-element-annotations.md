# Agent Note: Web element annotations in Sidebar Browser

Status: implemented

English | [中文](2026-11-04-web-element-annotations.zh.md)

## Problem

Users on Desktop could look at a web page in a right-Sidebar Browser tab but had no way to hand a specific element on that page to the agent. Copy-paste loses geometry, screenshots lose the locator, and an ad-hoc "describe this element" path would have to invent its own transport into the composer. The desktop capture engine (main-process script in an isolated world) already existed; what was missing was the carrier-neutral renderer flow from a click on the page to a logged composer message.

## Decision

- The renderer flow is carrier-neutral and composer-native. A capture (`BrowserAnnotationControl.capture`) ends in a comment editor rendered by DSH React inside `.content`, never inside the visited page or the `<webview>` DOM. Saving a record only stages it in the tab body; "Add to conversation" is the single path into the composer: `conversation.createDrafts` for screenshots, `inputActions.addAttachments`, then one `inputActions.insertQuote` per annotation using `formatBrowserAnnotation`, numbered by `nextAnnotationNumber` over the live draft. Everything inserted is an ordinary, logged composer quote — no new session event, no parallel model-visible channel.
- The conversation service is reached through a new optional `annotationDrafts` bridge on `BrowserInjected`, built in the inject factory in `ui-sidebar-browser/src/client/index.ts` with the scope and sessionId closed over and `scope.get('conversation')` resolved lazily. Components stay ctx-free, and a missing conversation service degrades the flow to text-only quotes (screenshot field omitted) instead of failing.
- Partial failure rolls back forward, not backward: when a quote is refused mid-batch, insertion stops, the refused and remaining records stay in the strip, and only their screenshots are detached (`removeAttachment` plus the bridge release). Already-inserted quotes keep their attachments, because removing them would orphan quotes that did enter the composer.
- The capability bit lives in `BrowserControllerState.canAnnotate`, derived from `frame.annotations !== undefined`. Web iframes do not implement capture, so the annotate entry, hint, editor, and strip do not render at all — Web behavior is byte-for-byte unchanged.
- The type-level dependency on `@deepseek-ai/dsh-client-ui-conversation` is declared in `dsh.client.inject` and `devDependencies` only; runtime values cross exclusively through the injected Cordis service.

## Alternatives considered

**A dedicated annotation slot with its own props.** It would have threaded `useInput`/`inputActions` equivalents through a new slot registration for one consumer; reusing the session standard props on the existing body kept one registration surface and no new slot grammar.

**Releasing the whole draft batch on partial failure.** Releasing everything matches the existing drop-file rollback, but quotes already inserted reference their screenshots; releasing them would publish a message with dead object URLs, so only un-inserted attachments are detached.

**Persisting annotations per tab in the browser store.** The strip is view state tied to a mounted page whose locators go stale; until stale relocation exists, persistence would only surface dead annotations after a restart.

## Consequences

Desktop Browser tabs gain an annotate toolbar action, an in-progress hint, a DSH-rendered comment editor, and a records strip with per-record delete and composer hand-off. Composer numbering continues from any existing `## Web Element Annotation N` in the draft, so interleaved manual quotes keep unique numbers. Web builds keep their previous behavior and bundle surface.

## Testing

`tests/annotation-body.client.spec.tsx` covers the no-entry case on Web, the capture → editor → save → insert sequence with ordered quote numbers and screenshot file names, Esc cancellation, attachment-refusal rollback, partial-insert rollback, composer-busy disabling, and the text-only degradation. `tests/browser-body.client.spec.tsx` fixtures gained `useInput`/`inputActions` stubs, and the package suite plus `tsc -b` cover the controller state extension.

## Follow-up: t3code comparison (same day)

After reviewing pingdotgg/t3code's preview annotation, three of its choices were adopted; none adds a Session event or a new slot:

- **Multi-element picks.** t3code lets an additive pick collect several `PreviewAnnotationElementTarget`s under one comment and crops the screenshot to the union of their rects. The capture now carries `targets: DesktopBrowserElementTarget[]`: Cmd/Ctrl/Shift-click keeps collecting (capped at 8 by both `MAX_TARGETS` in the main process and `MAX_PICKED` in the script), Backspace drops the last, Enter submits, and a plain click commits one element. Each element becomes its own block in the quote, sharing one `## Web Element Annotation N` heading and one screenshot.
- **Owning component name.** t3code reads component and source-stack context through `react-grab`. This package adds no dependency and instead walks the `__reactFiber$`/`__reactInternalInstance$` chain read-only inside the fixed script, taking `displayName`/`name` (≤80 characters, re-truncated in the main process) and omitting the line when none is found. It hands the model a source hint beyond the selector without widening what the page can inject.
- **Union screenshot crop.** Already the behavior (`clampRects` unions every selected element rect before `capturePage`); this round added the multi-element test and documentation for it.

Deliberately not adopted: t3code renders the annotation editor inside the visited page (`PickPreload` builds its composer and style panel there). That requires injecting DSH UI and styles into the page and gives up the guarantee that the page cannot read the comment; the editor stays in trusted DSH DOM. Its live in-page style editing (`styleChanges`) was also declined, since served styling that differs from source introduces a second source of truth.
