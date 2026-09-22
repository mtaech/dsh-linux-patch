# Agent Note: Desktop packaging executes pnpm through its own entry

Status: implemented

English | [中文](2026-09-09-desktop-pnpm-execpath-entry.zh.md)

## Problem

`apps/desktop/scripts/package-target.ts` ran every packaging subprocess through `spawn(process.execPath, [npm_execpath, ...args])`, assuming `npm_execpath` is a JavaScript entry that Node can interpret. pnpm installs that entry as either a `pnpm.cjs` shim (which needs Node) or a compiled `@pnpm/exe` binary (an ELF executable, as shipped through mise and some other managers). On the compiled-binary form, Node parses the ELF file as a module and dies with `SyntaxError: Invalid or unexpected token`, failing the very first `build:official` step of every Desktop package run. The failure is environmental: CI and the original macOS host happened to expose the JavaScript shim, so the bug stayed latent.

## Decision

`pnpmInvocation` selects the command from the entry form: an entry named with a `.js`, `.mjs`, or `.cjs` extension runs through this process's interpreter, and every other entry is spawned directly. Both `runPnpm` call sites use it — the supervised `run.run` stage and the direct spawn — so signed and unsigned packaging execute pnpm the same way. pnpm sets `npm_execpath` to `process.argv[1]` for its JavaScript CLI and to `process.execPath` for the packaged binary, so the extension names the form. Scripts invoked through a package-manager command still fail loudly when `npm_execpath` is absent, unchanged.

## Alternatives considered

**Always spawning the entry directly.** Rejected as the sole rule: it fixes the compiled-binary host and works for a JavaScript entry on Linux and macOS, whose kernels honor the shebang, but it breaks a Windows JavaScript entry, which the operating system cannot execute without an interpreter.

**Detecting the form from the entry's contents.** Rejected: reading a shebang or ELF magic to decide how to exec duplicates what the operating system already does and answers a question `npm_execpath` states by itself.

## Consequences

Desktop packaging runs on hosts whose pnpm entry is the compiled `@pnpm/exe` binary, on hosts with the JavaScript shim, and on Windows, where the shim keeps running through Node. No packaging behavior changes on hosts that already worked.

## Testing

No unit test covers `runPnpm`; it is an internal function with no exported surface. The verification is the packaging smoke itself: the first Linux x64 packaging run reached `build:official`, then the whole pipeline, on a host with the compiled pnpm entry. That run predates the extension routing, so a full `package:linux:x64` on the current base is the check that exercises it end to end.

## Related

Discovered while adding the [Linux release target](../feature/2026-09-08-desktop-linux-release-target.md); the same packaging run also required the electron-builder `executableName` for Linux.