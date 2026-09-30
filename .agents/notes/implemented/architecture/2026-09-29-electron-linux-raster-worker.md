# Agent Note: Run raster work in a plain-Node worker on Electron Linux

Status: implemented

English | [中文](2026-09-29-electron-linux-raster-worker.zh.md)

## Problem

Sharp's prebuilt Linux libvips links GLib statically, while Electron's Linux binary links the system GLib and leaks its symbols into the process space. Inside an Electron process, libvips' GLib calls therefore resolve to the wrong implementation, and loading any image — a header probe, a full decode, an encode pipeline — segfaults the process ([electron#46323](https://github.com/electron/electron/issues/46323)). Desktop runs the shared Web Host with `ELECTRON_RUN_AS_NODE=1` ([decision](2026-09-11-desktop-electron-node-runtime.md)), so every image attachment submitted to the Linux application crashed its Host, and `runtime-payload-smoke` failed before a Linux package could be produced.

## Decision

Raster work leaves the Electron process wherever that combination is detected: `process.versions.electron` set and platform `linux`. `@deepseek-ai/dsh-attachment-local` then starts one worker from its `rasterNode` configuration — a plain Node executable — and serves `probeImage`, `detectImage`, `normalizeImage`, and `createRequestImage` to it over one length-prefixed frame per request. Every other runtime keeps in-process Sharp and ignores `rasterNode` and `rasterWorker`.

A host that detects the combination without `rasterNode` refuses raster work with an actionable error instead of failing to mount: non-image attachments keep working, and image operations report the missing executable rather than crashing the process.

The store never trusts the worker's own report. Normalized bytes are decoded again beside the store before they are persisted, the same way request-image bytes already were, so the worker boundary carries bytes and facts, never authority.

`src/raster-operations.ts` owns every Sharp call. `src/image.ts`, `src/normalization.ts`, and `src/request-image.ts` keep their published signatures as façades that dispatch through `src/raster.ts`, which selects the runner and resolves the worker entry. `src/raster-client.ts` owns the channel: spawn, request ids, ordered writes under backpressure, and teardown that waits for the process to exit. `src/raster-worker.ts` serves requests until its input ends, and `src/raster-protocol.ts` defines the framing with a bounded section size.

Two behaviors keep the worker from outliving its host's usefulness. An idle worker is unreferenced from the event loop, and an in-flight request references it again, so a one-shot CLI run or a startup check exits after its last reply while a pending operation still waits for it. A worker that closes its side of the channel, exits, or writes an unreadable frame rejects exactly the requests that worker owns, leaving a replacement worker's requests pending.

### Packaging

A plain Node child cannot read files inside `app.asar`, so the packaged layout changes with the decision. The Electron builder `unpack` list keeps `sharp`, `detect-libc`, `@img`, and `@deepseek-ai/dsh-attachment-local` physical beside the archive; the worker entry is a package build entry (`lib/raster-worker.js`) that inlines every `@deepseek-ai` workspace module and keeps Sharp external; and `src/raster.ts` resolves its worker entry beside its own module, mapping an `app.asar` path to the `app.asar.unpacked` sibling when the packaged copy is only readable by Electron.

Desktop passes `DSH_PRIMARY_RUNTIME` to the Host, and the Web profile resolves `rasterNode` from it through the bundled primary runtime's Node executable. `runtime-payload-smoke` exercises the store's decode, normalization, and read path on Electron Linux instead of loading Sharp in its own process; macOS and Windows keep the in-process check.

## Alternatives considered

**Keep Sharp in-process and tolerate the crash.** Rejected: the affected operations are image admission, normalization, and request projection, so a Linux application could not accept a screenshot or attachment at all.

**Load Sharp's WASM binding on Electron Linux.** Rejected: Sharp's loader prefers the native platform binding and only falls back on a load failure, which is not the failure here; the WASM path also drops native text rendering, and decoded images sit on the attachment hot path, where WASM costs throughput for every Linux host.

**Run the Host under the bundled plain Node on Linux.** Rejected: it contradicts the recorded [Electron-as-Node decision](2026-09-11-desktop-electron-node-runtime.md), which gives the Host and bundled pnpm one runtime, and the packaged-node assertions the payload smoke verifies.

**Preload or interpose the conflicting GLib.** Rejected: the leaked definitions belong to the system GLib that Electron already loaded, while libvips links its own statically, so no preload order or symbol scope repairs the mismatch from outside.

**Defer the smoke instead of fixing the path.** Rejected: `--defer-runtime-smoke` would have produced an AppImage whose Host still crashed on every image, which is the failure the check exists to catch.

## Consequences

- Electron Linux image work runs in a second process: each operation copies its bytes once over a pipe, and each host pays one worker spawn. An idle worker costs nothing on the event loop.
- Every Electron-Linux host must name a plain Node executable. The Desktop application supplies one from the primary runtime; another Electron host that cannot must accept the refusal error or configure `rasterNode` itself.
- The packaging unpack list and the archive-integrity verification now include Sharp's JavaScript, its `detect-libc` dependency, the `@img` native packages, and the attachment package.
- Worker failures surface as the failing worker's facts — its exit code and signal, or the protocol error — and a replaced worker's late failure cannot reject its successor's requests.
- In-process raster work still covers macOS, Windows, and every plain-Node runtime, so only the crashing combination changed behavior.

## Testing

`tests/raster-protocol.spec.ts` pins the codec, `tests/raster-worker.spec.ts` the worker's request loop and failure facts, `tests/raster-client.spec.ts` the channel including spawn failure, protocol failure, worker death, and disposal, and `tests/raster.spec.ts` the runner selection and packaged-entry resolution. `runtime-payload-smoke` decodes and normalizes a real PNG through the packaged store on Electron Linux.

## Deferred

A worker that stays alive but never answers holds its request open indefinitely; the channel reports death and protocol failure, but no deadline bounds a stuck operation. Add one when a real operation is observed to hang.

## Related

- [Desktop Electron Node runtime](2026-09-11-desktop-electron-node-runtime.md)
- [Desktop primary runtime](../feature/2026-09-14-desktop-primary-runtime.md)
