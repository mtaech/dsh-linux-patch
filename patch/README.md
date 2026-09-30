# `dsh-linux-patch`

Patched Linux x64 build of the DeepSeek Harness desktop application, from the public
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) source. This is a
personal build repository — **not** an official DeepSeek release.

The tree is the upstream source plus five commits that make the Linux target actually run. The
[full analysis](SOLUTION.md) of every defect, and the [tracking issue](https://github.com/mtaech/dsh-linux-patch/issues/1)
carry the root causes and evidence.

## Download and run

```sh
curl -L -o dsh.AppImage \
  https://github.com/mtaech/dsh-linux-patch/releases/download/v0.2.0-rc.2-linux/deepseek-harness-0.2.0-rc.2-linux-x86_64.AppImage
chmod +x dsh.AppImage
./dsh.AppImage
```

Without FUSE, run `./dsh.AppImage --appimage-extract-and-run`. The packaged build targets the test
update feed, so a `nightly-linux.yml` 404 at startup is expected.

## Branches

| Branch | Contents |
|---|---|
| `main` | The patched build, plus this documentation. |
| `fix/linux-raster-child-process` | The five patch commits alone, for review or rebasing onto upstream. |

## The five commits

```
fix(attachment-local): run raster work in a plain-Node worker on Electron Linux
fix(desktop):          package the raster worker and hand the Host a plain Node
fix(desktop-host):     resolve the Office kit closure to its unpacked files
fix(desktop):          keep the mandatory-update policy out of Linux packages
docs:                  record the Linux raster worker, kit resolution, and policy scope
```

They sit directly on top of the upstream Linux packaging commit (`feat(desktop): package Linux x64
AppImage`), so `git diff <upstream-linux-packaging-commit>..fix/linux-raster-child-process` is the
whole patch set.

## Build it yourself

The Linux target requires Linux x64 and a Node runtime in the repository's supported range.

```sh
pnpm install
# apps/desktop/.env.linux supplies the release settings; copy .env.linux.example and fill it in.
# It must not set DSH_DESKTOP_MANDATORY_UPDATE_* — a Linux package rejects those settings.
pnpm run package:desktop:linux:x64
```

The artifact lands in
`apps/desktop/.desktop-build/targets/linux-x64/artifacts/deepseek-harness-<version>-linux-x86_64.AppImage`.
The run prepares the runtime, executes both smoke checks, and only then produces the AppImage; a
successful run ends with `success: true` in
`apps/desktop/.desktop-build/packaging-runs/<run>/result.json`.

Behind a proxy, the Electron download and the pnpm installs need `HTTPS_PROXY`/`HTTP_PROXY`, and
`NODE_USE_ENV_PROXY=1` so Node's own `fetch` honours them (the Electron downloader uses `fetch`,
which ignores proxy variables otherwise). Prefer the plain HTTP proxy over `socks5://` there —
`fetch` does not support SOCKS.

## What the patches change

| Area | Files |
|---|---|
| Raster worker boundary | `packages/attachment/attachment-local/src/raster*.ts`, `image.ts`, `normalization.ts`, `request-image.ts`, `index.ts` |
| Packaging and profile wiring | `apps/desktop/scripts/electron-builder-config.mjs`, `apps/desktop/src/main.ts`, `apps/desktop/tests/fixtures/runtime-payload-smoke.mjs`, `packages/bundle/web-app/cordis.patch.yml` |
| Office kit resolution | `apps/desktop-host/src/office-engine.ts` |
| Linux policy scope | `apps/desktop/scripts/desktop-policy-environment.{mjs,d.mts}`, `desktop-package-environment.mjs`, `apps/desktop/.env.linux.example` |
| Rationale | `.agents/notes/implemented/architecture/2026-09-29-electron-linux-raster-worker.md` |

## Verification

- `pnpm run package:desktop:linux:x64` → `success: true`, both smoke checks pass.
- Packaged manifest carries no `dshMandatoryUpdatePolicy`.
- The application starts and serves its Web Host.
- 215 unit tests over the touched packages; `attachment-local` keeps 100% per-file coverage;
  `tsc -b tsconfig.host.json` and oxlint are clean; 1161 bilingual documentation pairs agree.
