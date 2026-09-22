# Agent Note: Desktop Linux x64 发布目标

Status: implemented

[English](2026-09-08-desktop-linux-release-target.md) | 中文

## Problem

Desktop 应用（`apps/desktop`）只发布了 `mac-arm64`、`mac-x64`、`win-x64` 三个目标。所有固定目标表在构建前就把 `linux-x64` 当作不支持的目标拒绝，README 也写明 Linux 不是受支持的 Desktop 发布目标。Linux 用户没有可用的 Desktop 打包版本，只能用 Web 前端。

除目标表之外，发布流水线本身写死了两个平台。`prepare-runtime.ts` 只为 Electron 归档在 `darwin` 与 `win32` 之间选择，`prepare-dsh.ts` 以 `process.platform` 加 macOS 回退推断 Electron-as-Node 可执行文件，`smoke-packaged-runtime.ts` 只认得 `win-unpacked` 与 macOS bundle，`desktop-package-environment.mjs` 每个平台一个 dotenv 文件且没有 Linux 文件。

## Decision

`linux-x64` 与 `mac-arm64`、`mac-x64`、`win-x64` 一样是受支持的 Desktop 发布目标，通过同一条固定目标流水线打包 AppImage。

所有固定目标表都包含 `linux-x64`：`scripts/package-target.ts` 的 `TARGETS`（`platform: 'linux'`、`builderPlatform: '--linux'`）、`scripts/desktop-build-paths.mjs` 的 `SUPPORTED_TARGETS`、`scripts/desktop-auto-update-environment.mjs` 的 `UPDATE_TARGETS` 与元数据平台校验、`scripts/desktop-upload-plan.ts` 的上传 `TARGETS`、以及 `scripts/upload-target.ts` 的 `SUPPORTED_TARGETS`。

host 校验沿用既有按平台规则：`resolveDesktopPackageTarget` 要求 `linux-x64` 使用 Linux x64 构建机，与 Windows、macOS 的要求对称。Linux 主机不带显式目标时，通过现有 `hostTargetName` 回退默认 `linux-x64`。

运行时准备补上了平台校验本就要求的 Linux 分支。`prepare-runtime.ts` 下载 Linux Electron 归档，`scripts/desktop-build-paths.mjs` 的 `desktopElectronExecutable` 按平台给出解包后 Electron 发行版的二进制路径，取代 `prepare-runtime.ts` 与 `prepare-dsh.ts` 各自持有的 macOS/Windows 三元表达式。Linux 运行时不携带 `dsh` 启动脚本：安装命令只存在于 macOS 与 Windows，因此 `prepare-runtime.ts` 只为这两个平台准备该脚本。`smoke-packaged-runtime.ts` 读取 electron-builder 的 `linux-unpacked` 暂存目录，资源位于 `resources`，可执行文件为 `deepseek-harness`；该文件名只有在 electron-builder 的 `linux` 段设置 `executableName: 'deepseek-harness'` 时才会产生，否则 electron-builder 用带 scope 的包 `name` 推导出非法路径 `@deepseek-aidsh-desktop`。

发布配置仍按平台由文件持有。`desktop-package-environment.mjs` 对 Linux 目标选择 `.env.linux`，该文件不接受任何平台专属字段，并在不涉及签名与公证的情况下校验 Linux 目标。`.env.linux.example` 是模板，`.gitignore` 覆盖本地文件。

AppImage 更新文件的 blockmap 内嵌在产物中。因此 `scripts/desktop-upload-plan.ts` 要求频道元数据中有 `blockMapSize`，只发布一个 `application/octet-stream` 二进制产物，并期望 electron-builder 按 Linux 架构字符串生成的产物名：`deepseek-harness-<version>-linux-x86_64.AppImage`。频道元数据遵循 electron-builder 的 Linux 约定：`nightly-linux.yml`，稳定版还有 `latest-linux.yml` 别名。

npm scripts 在两层都暴露了该目标：`apps/desktop/package.json` 的 `package:linux:x64` / `package:linux:x64:dir` / `upload:linux:x64`，以及根 `package.json` 的 `package:desktop:linux:x64` / `package:desktop:linux:x64:dir` / `upload:linux:x64`。`apps/desktop/README.md` 的发布目标列表、host 要求和 dotenv 说明都已包含 Linux。

## Alternatives considered

**同时支持 `linux-arm64`。** 暂缓：目前没有任何固定目标脚本需要它，也没有构建机提出要求，固定目标表保持封闭。以后加只是一个表项加一个 host 校验。

**deb/rpm 打包。** 本次不做：AppImage 是 electron-builder 既有的唯一 Linux 目标，且让 generic-provider 自动更新路径与 macOS、Windows 完全一致。安装包格式可以之后叠加，无需改动目标流水线。

**从其他 host 交叉打包 Linux。** 拒绝：现有 host 校验的含义是「构建机能执行打包产物」，交叉编译会破坏其它目标对称校验的这一不变式。Linux x64 只在 Linux x64 上构建。

## Consequences

Linux x64 构建与其他三个目标走同一条固定目标流水线：运行时准备、package-set 打包、运行时物化、electron-builder 产物、发布记录、COS 上传都接受新目标。上传落在所选发布目录下的 `dsh-desk/feeds/linux-x64/` 与 `dsh-desk/bin/linux-x64/`。Linux 打包不签名：证书、公证和签名缓存配置都不适用。

平台目标表在五个模块中重复；加 Linux 需要逐个改动。这是既有重复，固定目标设计让表保持封闭，因此每个未来目标的成本是每张表一行。

## Testing

- `tests/package-target.spec.ts` 把 `linux-x64` 解析为 Linux 选择器，并拒绝非 Linux host 上的 Linux 目标。
- `tests/desktop-build-paths.spec.ts` 把 `linux-x64` 构建目录与其他目标一起隔离，并把 Linux host 解析为 `linux-x64`。
- `tests/desktop-auto-update-environment.spec.ts` 解析 Linux 更新目标与频道元数据（`nightly-linux.yml`），并拒绝 `freebsd`。
- `tests/desktop-upload-plan.spec.ts` 验证带内嵌 blockmap 与 `nightly-linux.yml`、`latest-linux.yml` 元数据的 Linux AppImage 上传计划，拒绝缺少 `blockMapSize` 的元数据，并拒绝只有 macOS 与 Windows 提供的固定安装包请求。
- `tests/desktop-package-environment.spec.ts` 读取 `.env.linux`，拒绝该文件中的其他平台字段，并在无签名配置下校验 Linux 目标。
- 在 Linux x64 主机上执行 `pnpm --dir apps/desktop run check:package` 会解析出 `linux-x64`，校验其配置与工具链，并在签名前停止。

针对当前基线，完整的 `package:linux:x64` 运行仍是待完成的端到端检查；此前跑到产出 `deepseek-harness-0.1.5-alpha.1-linux-x86_64.AppImage` 及其频道元数据的完整运行是在 rebase 之前的流水线上完成的。

## Related

首次 Linux 打包暴露出两个环境相关缺陷，在同一个分支修复：`runPnpm` 的 [pnpm 入口执行问题](../bug-fix/2026-09-09-desktop-pnpm-execpath-entry.zh.md) 和上面的 electron-builder `executableName` 要求。