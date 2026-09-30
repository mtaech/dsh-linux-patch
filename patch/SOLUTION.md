# Linux AppImage: startup failure and image crash

Solution record for the five commits in this repository. The durable decision rationale lives in
[`.agents/notes/implemented/architecture/2026-09-29-electron-linux-raster-worker.md`](../.agents/notes/implemented/architecture/2026-09-29-electron-linux-raster-worker.md);
this document is the diagnosis trail, kept because the evidence is what makes the fixes legible.

## Symptoms

The starting point was "double-clicking the AppImage fails", reported by KDE as a systemd unit
error. Unwinding it produced four independent defects, three of which blocked packaging before the
application could even be launched.

| # | Symptom | Layer |
|---|---|---|
| 1 | Packaging fails in `runtime:smoke`: image decode ends in SIGSEGV | sharp / libvips / Electron |
| 2 | Packaged smoke fails with `Cannot find module .../app.asar/.../raster-worker.js` | plain Node child vs ASAR |
| 3 | Office conversion fails: `Installed LibreOfficeKit package is incomplete: @deepseek-ai/libreoffice-kit-linux-x64-glibc` | kit existence probe inside an archive |
| 4 | The application exits immediately after launch; the desktop shell reports the failed launch | Linux package carrying a macOS/Windows-only policy |
| 5 | A running window shows a placeholder icon in the taskbar under Wayland | Electron's application id comes from the packaged package name, which no shipped desktop entry matches, and no window carried an icon of its own |

## Root cause 1: Electron's leaked GLib symbols displace the statically linked one in libvips

```sh
$ ldd .../sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.7
  linux-vdso.so.1 / libresolv / libdl / libstdc++ / libpthread / libm / libgcc_s / libc
  # no libglib — GLib is linked into the shared object

$ ldd .../electron/electron | grep glib
  libglib-2.0.so.0 => /usr/lib/x86_64-linux-gnu/libglib-2.0.so.0     # system glib 2.90
```

Electron's Linux binary links the system GLib and leaks its symbols into the process space, so
libvips' internal GLib calls resolve to a different implementation than the one it was built
against. Minimal reproduction:

```sh
T=apps/desktop/.desktop-build/targets/linux-x64
ELECTRON_RUN_AS_NODE=1 $T/electron/electron -e \
  "require('$T/dsh/node_modules/sharp')('/tmp/x.png').metadata().then(m => console.log('OK')).catch(e => console.log('ERR', e.message))"
# → segmentation fault (139); the same code under plain node prints OK
```

Encoding from raw pixels works; loading any image crashes. This is the incompatibility sharp
documents under `install#electron-and-linux`, tracked upstream as
[electron#46323](https://github.com/electron/electron/issues/46323).

## Root cause 2: a plain Node child cannot read ASAR, and Electron reports unpacked-only paths as present

The packaged runtime lives in `resources/app.asar/dsh/...`, which a plain Node process cannot open.
Worse, inside Electron an existence probe on a path that was never unpacked answers "present"
(Electron's ASAR filesystem layer), so "use the file if it exists, otherwise map it" picks the
archived path and the child fails to start.

## Root cause 3: the Office kit uses that same probe to decide whether a native engine is installed

```js
// @deepseek-ai/libreoffice-kit/lib/index.js:1232
require.resolve.paths(name).some(dir => lstatSync(join(dir, name), { throwIfNoEntry: false }) !== undefined)
```

Measured inside the packaged Electron host with a probe script:

```
present   /app.asar/dsh/node_modules/@deepseek-ai/libreoffice-kit-linux-x64-glibc
present   /app.asar/node_modules/@deepseek-ai/libreoffice-kit-linux-x64-glibc
some() decides installed = true          ← the package was never installed
```

The kit therefore concluded that an installed native engine was incomplete and refused its own
WASM fallback, which is the path a Linux host is supposed to take when the kit declares no matching
native target.

## Root cause 4: the Linux package embedded a policy the runtime only implements for macOS and Windows

```ts
// apps/desktop/src/main.ts
if (!['win32', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch))
  throw new Error('desktop policy: unsupported platform')
```

`electron-builder-config.mjs` wrote `dshMandatoryUpdatePolicy` into the packaged manifest for every
target, so the Linux application threw during startup and exited — which the desktop shell surfaced
as a failed launch.

## Root cause 5: the window's application identity and icon

Measured with `WAYLAND_DEBUG=1` against the packaged application:

```
set_app_id("deepseek-ai-dsh-desktop")        ← the packaged package name, sanitized
caption:     DeepSeek Harness                ← KWin's view of the same window
desktopFile: deepseek-ai-dsh-desktop         ← the entry KWin looks for
```

The packaged entry is `deepseek-harness.desktop`, so the taskbar matched no application: it grouped
and pinned the window separately and showed a placeholder. Electron reads the desktop-file name
before a main script runs — setting `CHROME_DESKTOP` there does not help (verified) — but
`app.setDesktopName()` does, and it does not change `app.getName()` or the user-data directory.

Separately, no window passed an `icon` option. Wayland carries a window icon through
`xdg-toplevel-icon-v1` and X11 through `_NET_WM_ICON`, so a window that sets none shows a placeholder
even when a matching entry is installed.

## Fixes

**Raster work leaves the Electron process on Linux.** Five modules implement the boundary:
`raster-operations.ts` owns every Sharp call; `raster-protocol.ts` frames one request or response per
message; `raster-client.ts` owns spawn, request ids, backpressure, failure mapping, and teardown that
waits for the process to exit; `raster-worker.ts` serves requests until its input ends; `raster.ts`
selects the runner and resolves the packaged entry. `image.ts`, `normalization.ts`, and
`request-image.ts` keep their published signatures and dispatch through it, so the store is
unchanged. New configuration: `rasterNode` (a plain Node executable) and `rasterWorker` (entry
override); the Web profile resolves `rasterNode` from `DSH_PRIMARY_RUNTIME`. A host that detects the
combination without `rasterNode` refuses raster work with an actionable error and keeps serving
non-image attachments. Normalized bytes are decoded again beside the store before persistence, so a
worker's reported facts are never trusted. An idle worker is unreferenced from the event loop and an
in-flight request references it again, so one-shot CLI runs still exit.

**Packaging keeps everything a plain Node child opens physically present.** `sharp`, `detect-libc`,
`@img`, and the attachment package join the Electron builder unpack list; the worker entry is a
second package build entry that inlines every workspace module and keeps Sharp external; the worker
script resolves to its `app.asar.unpacked` sibling whenever the module itself sits inside an archive.

**The whole Office kit closure resolves to the physical tree.** The resolve hook in
`apps/desktop-host/src/office-engine.ts` now maps the kit, its engines, and the WASM fallback to
their unpacked copies, where an absent path is absent for the kit's probe and for the native child
processes that read those files.

**Windows carry their application identity and icon.** `main.ts` sets Electron's desktop-file name
to `deepseek-harness.desktop`, the entry the packaging names from `executableName` and whose
`StartupWMClass` records the same value, and `window-icon.ts` supplies the packaged icon to every
Desktop window.

**Policy resolution is platform-aware.** `resolveDesktopPolicyEnvironment(environment, platform)`
returns no policy for any target other than macOS and Windows, the packaged metadata is written only
when a policy exists, and a Linux dotenv file rejects the mandatory-update settings instead of
recording enforcement that cannot happen.

## Verification

| Check | Result |
|---|---|
| `pnpm run package:desktop:linux:x64` | `success: true`; `linux-package` stage passes |
| `runtime:smoke` (staged, Electron-as-Node on Linux) | passes, including the new raster decode check |
| `smoke-packaged-runtime` (ASAR) | passes: `"raster":true`, `DOCX, XLSX, PPTX to PDF and skill CLI discovery passed` |
| Packaged manifest | `dshMandatoryUpdatePolicy present: false` |
| Application launch | reaches `dsh web: http://127.0.0.1:19387/?token=…` |
| Wayland window identity | `set_app_id("deepseek-harness")` matching the packaged `deepseek-harness.desktop` |
| Wayland window icon | `xdg_toplevel_icon_manager_v1.create_icon → add_buffer → set_icon` |
| Unit tests (attachment-local, desktop-host, desktop policy/environment) | 215 passing; `attachment-local` at 100% per-file coverage |
| `tsc -b tsconfig.host.json`, oxlint | clean |
| `verify-cordis-config`, config catalog, bilingual pairing | 213 config files pass, catalog regenerated, 1161 pairs consistent |

## Commits

```
819317c60b fix(desktop): give Linux windows their application identity and icon
d020540c38 docs: record the Linux raster worker, kit resolution, and policy scope
8e49e39825 fix(desktop): keep the mandatory-update policy out of Linux packages
4cf09b8432 fix(desktop-host): resolve the Office kit closure to its unpacked files
1946dd60be fix(desktop): package the raster worker and hand the Host a plain Node
7eeb2e9133 fix(attachment-local): run raster work in a plain-Node worker on Electron Linux
```

## Known limitations

- An existing desktop entry installed from an earlier build still records
  `StartupWMClass=DeepSeek Harness`. The window id now matches the entry *file name*, so the icon
  resolves; reinstalling the entry refreshes the class.
- Launched from a KDE file manager, Dolphin's systemd service path can reject a long AppImage path
  with `Invalid unit name or type`; running the AppImage from a terminal or extracting it avoids that
  KDE-side behaviour.
- A worker that stays alive without answering holds its request open: the channel reports death and
  protocol failure, but no deadline bounds a stuck operation.
- The packaged build points at the test update feed, so a `nightly-linux.yml` 404 at startup is
  expected for this build.

## 中文摘要

这份记录是排查过程与修复方案：四个互不相关的缺陷叠在一起 —— ①Sharp 的 Linux 预编译 libvips 静态链接
GLib，而 Electron 链接系统 GLib 并把符号泄漏进进程空间，导致在 Electron 进程内解码任何图片都段错误
（electron#46323），修法是把栅格工作移到普通 Node worker；②普通 Node 子进程读不了 `app.asar`，而
Electron 会把从未解包的路径报告为存在，修法是把 worker 与 Sharp 的 JavaScript 保留为物理文件并把
asar 路径映射到 `app.asar.unpacked`；③Office kit 用同一种探测判断原生引擎是否安装，在归档内必然误判，
于是拒绝回退 WASM，修法是把整个 kit 闭包解析到物理解包目录；④Linux 包内嵌了运行时只支持 macOS/Windows
的强更策略，应用启动即抛错退出，修法是策略解析按平台返回、Linux 的 dotenv 拒绝这些设置；⑤任务栏没有图标，
因为窗口的 application id 取自打包的包名、没有任何 desktop 条目与之匹配，且窗口自身未设置图标，修法是把
desktop 文件名设为随包条目名并让每个窗口携带应用图标。
