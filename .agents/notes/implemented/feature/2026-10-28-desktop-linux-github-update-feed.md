# Agent Note: Desktop Linux packages poll a GitHub-hosted update feed

Status: implemented

English | [中文](2026-10-28-desktop-linux-github-update-feed.zh.md)

## Problem

The `linux-x64` package embeds its updater feed from the shared deployment settings, so it polls `<origin>/<release ID>/feeds/linux-x64/nightly-linux.yml` on the official test CDN. That feed is never published: Linux is not an official release target, so every unofficial Linux build reports a `nightly-linux.yml` 404 on each update check, and updates are manual. The feed cannot point elsewhere through the existing settings because `DOWNLOAD_TEST_ORIGIN` accepts a bare origin only, and GitHub release URLs carry a path.

## Decision

`DSH_DESKTOP_LINUX_UPDATE_FEED` is an optional `.env.linux` setting that replaces the packaged generic-provider feed base URL for Linux alone. `resolveLinuxUpdateFeedUrl` validates it as an HTTPS URL with a path and no credentials, query, or fragment, and normalizes the trailing slash the channel-filename resolution needs; `electron-builder-config.mjs` uses it as the `publish.url` on `linux`. The channel file is published to a permanent GitHub release whose tag stays fixed across versions, so the packaged URL never changes; its `nightly-linux.yml` names each release's AppImage asset with an absolute URL, which the generic provider resolves as given. Each Linux patch release uploads the rewritten channel file to that feed release. This supersedes the earlier claim that Linux packages carry no platform-specific release setting.

## Alternatives considered

**Relaxing `httpsOrigin` for the test deployment.** Rejected: `DOWNLOAD_TEST_ORIGIN` feeds macOS, Windows, and upload planning too, and a GitHub URL is not an origin; one platform's host must not reshape the shared deployment schema.

**Pointing the feed at a git branch or a `releases/latest` URL.** Rejected for the feed file itself: GitHub's `latest` redirect skips prereleases, and a branch-held channel file adds a second moving part; a pinned release tag keeps one stable URL with per-release contents.

## Consequences

Unofficial Linux builds answer Check for Updates against their own release host and update without a manual download once a newer version's channel file is published. Packaging validation still requires the deployment origin and release ID, so COS upload planning is unchanged; only the packaged feed URL differs. The channel file must be refreshed on every Linux patch release, or the updater keeps offering the stale version.

## Testing

- `tests/desktop-auto-update-environment.spec.ts` resolves the optional override, normalizes its trailing slash, keeps the deployment origin when it is unset or blank, and rejects HTTP, credentials, query, fragment, bare-origin, and non-URL values.
- `tests/desktop-package-environment.spec.ts` accepts the setting in `.env.linux` and rejects it in `.env.windows`.
