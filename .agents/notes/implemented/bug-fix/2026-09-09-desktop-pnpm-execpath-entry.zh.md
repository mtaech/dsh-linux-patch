# Agent Note: Desktop 打包通过 pnpm 自身入口执行

Status: implemented

[English](2026-09-09-desktop-pnpm-execpath-entry.md) | 中文

## Problem

`apps/desktop/scripts/package-target.ts` 用 `spawn(process.execPath, [npm_execpath, ...args])` 运行每个打包子进程，假设 `npm_execpath` 是 Node 能解释的 JavaScript 入口。pnpm 的安装入口有两种：`pnpm.cjs` shim（需要 Node）或编译的 `@pnpm/exe` 二进制（ELF 可执行文件，mise 等管理器分发这种形式）。在编译二进制形式下，Node 把 ELF 当模块解析，报 `SyntaxError: Invalid or unexpected token`，让每次 Desktop 打包的第一步 `build:official` 直接失败。这是环境相关缺陷：CI 和最初的 macOS 构建机恰好用的是 JavaScript shim，所以 bug 一直潜伏。

## Decision

`pnpmInvocation` 按入口形式选择命令：扩展名为 `.js`、`.mjs` 或 `.cjs` 的入口通过本进程的解释器执行，其他入口直接 spawn。`runPnpm` 的两个调用点都使用它——受监督的 `run.run` 阶段与直接 spawn——因此签名与未签名打包执行 pnpm 的方式一致。pnpm 在 JavaScript CLI 下把 `npm_execpath` 设为 `process.argv[1]`，在打包二进制下设为 `process.execPath`，所以扩展名即可判定形式。通过包管理器命令调用的脚本在 `npm_execpath` 缺失时仍会响亮失败，行为不变。

## Alternatives considered

**一律直接 spawn 入口。** 拒绝作为唯一规则：它能修复编译二进制的机器，且对 Linux 与 macOS 上的 JavaScript 入口可行（内核遵循 shebang），但会破坏 Windows 上的 JavaScript 入口——该平台没有解释器无法执行它。

**通过入口内容检测形式。** 拒绝：读 shebang 或 ELF 魔数来决定如何 exec，重复了操作系统已经做的事，而 `npm_execpath` 本身就已说明答案。

## Consequences

Desktop 打包现在能在 pnpm 入口是编译 `@pnpm/exe` 二进制的机器上运行，也能在 JavaScript shim 的机器上运行，并在 Windows 上继续让 shim 走 Node。对原本就能工作的机器没有打包行为变化。

## Testing

没有单元测试覆盖 `runPnpm`；它是内部函数，无导出面。验证是打包冒烟本身：首次 Linux x64 打包在编译 pnpm 入口的机器上跑通了 `build:official`，随后整个流水线。该次运行早于按扩展名分发之前，因此在当前基线上跑一次完整的 `package:linux:x64` 才是端到端覆盖它的检查。

## Related

在加 [Linux 发布目标](../feature/2026-09-08-desktop-linux-release-target.zh.md) 时发现；同一次打包还要求 electron-builder 为 Linux 设置 `executableName`。