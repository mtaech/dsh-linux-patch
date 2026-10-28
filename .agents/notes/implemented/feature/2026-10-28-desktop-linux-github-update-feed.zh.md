# Agent Note: Desktop Linux 包向 GitHub 托管的更新源发起检查

Status: implemented

[English](2026-10-28-desktop-linux-github-update-feed.md) | 中文

## Problem

`linux-x64` 包的更新源来自共享部署配置，因此它轮询官方测试 CDN 上的 `<origin>/<release ID>/feeds/linux-x64/nightly-linux.yml`。该清单永远不会发布：Linux 不是官方发布目标，所以每个非官方 Linux 构建都会在每次更新检查时报 `nightly-linux.yml` 404，升级只能手动。现有配置无法把源指向别处，因为 `DOWNLOAD_TEST_ORIGIN` 只接受纯 origin，而 GitHub release URL 带路径。

## Decision

`DSH_DESKTOP_LINUX_UPDATE_FEED` 是可选的 `.env.linux` 设置，仅对 Linux 替换打包进应用的 generic provider 更新源基地址。`resolveLinuxUpdateFeedUrl` 校验其为带路径、无凭据、无查询、无片段的 HTTPS URL，并补齐频道文件名解析所需的结尾斜杠；`electron-builder-config.mjs` 在 `linux` 上把它用作 `publish.url`。频道文件发布到一个标签固定的常驻 GitHub release，打包进应用的 URL 因此永远不变；其 `nightly-linux.yml` 用绝对 URL 指向各版本 release 的 AppImage 资产，generic provider 按原值解析。每次 Linux 补丁发布都把改写后的频道文件上传到该 feed release。本文取代此前「Linux 包不含平台专属发布配置」的说法。

## Alternatives considered

**放宽测试部署的 `httpsOrigin`。** 拒绝：`DOWNLOAD_TEST_ORIGIN` 同时供 macOS、Windows 和上传规划使用，GitHub URL 也不是 origin；单个平台的托管方式不应改变共享部署模式。

**把源指向 git 分支或 `releases/latest`。** 对频道文件本身拒绝采用：GitHub 的 `latest` 重定向跳过预发布，分支托管的清单引入第二个移动部件；固定的 release 标签用一个稳定 URL 承载按版本变化的内容。

## Consequences

非官方 Linux 构建的检查更新直接面向自己的发布托管；一旦新版本的频道文件发布，即可免手动下载完成升级。打包校验仍要求部署 origin 和 release ID，COS 上传规划不变；只有打包进应用的更新源 URL 不同。每次 Linux 补丁发布都必须刷新频道文件，否则 updater 会一直提示旧版本。

## Testing

- `tests/desktop-auto-update-environment.spec.ts` 解析可选覆盖项、规范结尾斜杠、未设置或空白时保留部署 origin，并拒绝 HTTP、凭据、查询、片段、纯 origin 和非 URL 值。
- `tests/desktop-package-environment.spec.ts` 接受 `.env.linux` 中的该设置，并在 `.env.windows` 中拒绝它。
