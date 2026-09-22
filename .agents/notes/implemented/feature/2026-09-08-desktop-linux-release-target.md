# Agent Note: Desktop Linux x64 release target

Status: implemented

English | [中文](2026-09-08-desktop-linux-release-target.zh.md)

## Problem

The Desktop app (`apps/desktop`) shipped only `mac-arm64`, `mac-x64`, and `win-x64` release targets. Every fixed target table rejected `linux-x64` before building, and the README stated that Linux was not a supported Desktop release target. Linux users had no packaged Desktop build, only the Web frontend.

Beyond the target tables, the release pipeline encoded two platforms. `prepare-runtime.ts` picked `darwin` or `win32` for the Electron archive, `prepare-dsh.ts` derived the Electron-as-Node binary from `process.platform` with a macOS fallback, `smoke-packaged-runtime.ts` knew only `win-unpacked` and the macOS bundle, and `desktop-package-environment.mjs` owned one dotenv file per platform with no Linux file.

## Decision

`linux-x64` is a supported Desktop release target alongside `mac-arm64`, `mac-x64`, and `win-x64`, packaged as an AppImage through the same fixed-target pipeline.

Every fixed target table includes `linux-x64`: `TARGETS` in `scripts/package-target.ts` (with `platform: 'linux'` and `builderPlatform: '--linux'`), `SUPPORTED_TARGETS` in `scripts/desktop-build-paths.mjs`, `UPDATE_TARGETS` and the metadata-platform check in `scripts/desktop-auto-update-environment.mjs`, the upload `TARGETS` in `scripts/desktop-upload-plan.ts`, and `SUPPORTED_TARGETS` in `scripts/upload-target.ts`.

Host validation follows the existing per-platform rule: `resolveDesktopPackageTarget` requires a Linux x64 build host for `linux-x64`, mirroring the Windows and macOS requirements. A Linux host with no explicit target defaults to `linux-x64` through the existing `hostTargetName` fallback.

Runtime preparation gains the Linux branches the platform checks already imply. `prepare-runtime.ts` downloads the Linux Electron archive, and `desktopElectronExecutable` in `scripts/desktop-build-paths.mjs` names the Electron binary inside an extracted distribution for every platform, replacing the macOS-and-Windows ternaries that `prepare-runtime.ts` and `prepare-dsh.ts` each carried. A Linux runtime carries no `dsh` launcher: command installation exists on macOS and Windows only, so `prepare-runtime.ts` prepares that launcher for those two platforms alone. `smoke-packaged-runtime.ts` reads electron-builder's `linux-unpacked` staging directory with `resources` and the `deepseek-harness` executable, which the electron-builder `linux` section produces only when it sets `executableName: 'deepseek-harness'`; without that field electron-builder derives the name from the scoped package `name` and produces the invalid path `@deepseek-aidsh-desktop`.

Release settings stay file-owned per platform. `desktop-package-environment.mjs` selects `.env.linux` for a Linux target, accepts no platform-specific setting there, and validates a Linux target without signing or notarization. `.env.linux.example` is the template and `.gitignore` covers the local file.

The AppImage updater file carries its blockmap inside the artifact. `scripts/desktop-upload-plan.ts` therefore requires `blockMapSize` in the channel metadata, publishes a single `application/octet-stream` binary artifact, and expects the artifact name electron-builder derives from the Linux architecture string: `deepseek-harness-<version>-linux-x86_64.AppImage`. Channel metadata follows electron-builder's Linux convention, `nightly-linux.yml` with the stable `latest-linux.yml` alias.

New npm scripts expose the target at both levels: `package:linux:x64` / `package:linux:x64:dir` / `upload:linux:x64` in `apps/desktop/package.json` and `package:desktop:linux:x64` / `package:desktop:linux:x64:dir` / `upload:linux:x64` in the root `package.json`. The `apps/desktop/README.md` release-target list, host requirements, and dotenv description include Linux.

## Alternatives considered

**`linux-arm64` as well.** Deferred: no fixed-target script requires it yet, no build host requests it, and the fixed target table stays closed. Adding it later is one table entry plus the host check.

**deb/rpm packaging.** Rejected for this change: AppImage is the single existing electron-builder Linux target and keeps the generic-provider auto-update path identical to macOS and Windows. Installer formats can layer on later without changing the target pipeline.

**Cross-packaging Linux from other hosts.** Rejected: the existing host checks encode "the build host can execute the packaged runtime," and cross-compiling would break that invariant for the other targets' symmetric checks. Linux x64 is built on Linux x64.

## Consequences

Linux x64 builds pass the same fixed-target pipeline as the other three targets: runtime preparation, package-set packing, runtime materialization, electron-builder artifacts, release records, and COS upload all accept the new target. Uploads land under `dsh-desk/feeds/linux-x64/` and `dsh-desk/bin/linux-x64/` within the selected release directory. Linux packaging is unsigned: no certificate, notarization, or signature-cache setting applies.

The platform target tables are duplicated across five modules; adding Linux touched each one. This duplication is pre-existing and the fixed-target design keeps the tables closed, so the cost is one line per table per future target.

## Testing

- `tests/package-target.spec.ts` resolves `linux-x64` to the Linux selectors and rejects a Linux target on a non-Linux host.
- `tests/desktop-build-paths.spec.ts` isolates `linux-x64` build directories alongside the other targets and resolves a Linux host to `linux-x64`.
- `tests/desktop-auto-update-environment.spec.ts` resolves the Linux update target and channel metadata (`nightly-linux.yml`) and rejects `freebsd`.
- `tests/desktop-upload-plan.spec.ts` validates a Linux AppImage upload plan with its embedded blockmap, `nightly-linux.yml` and `latest-linux.yml` metadata, rejects metadata without `blockMapSize`, and rejects the fixed-installer request that only macOS and Windows serve.
- `tests/desktop-package-environment.spec.ts` loads `.env.linux`, rejects another platform's settings in it, and validates a Linux target without signing configuration.
- `pnpm --dir apps/desktop run check:package` on a Linux x64 host resolves `linux-x64`, validates its configuration and toolchain, and stops before signing.

A complete `package:linux:x64` run is the remaining end-to-end check for this base; the earlier full run that produced `deepseek-harness-0.1.5-alpha.1-linux-x86_64.AppImage` with its channel metadata was made against the pre-rebase pipeline.

## Related

The first Linux packaging run surfaced two environment-specific defects, fixed in the same branch: the [runPnpm pnpm-entry execution](../bug-fix/2026-09-09-desktop-pnpm-execpath-entry.md) bug and the electron-builder `executableName` requirement above.