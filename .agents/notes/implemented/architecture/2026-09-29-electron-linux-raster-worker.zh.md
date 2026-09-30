# Agent Note: 在 Electron Linux 上用普通 Node worker 执行栅格工作

Status: implemented

[English](2026-09-29-electron-linux-raster-worker.md) | 中文

## 问题

Sharp 的 Linux 预编译 libvips 静态链接 GLib，而 Electron 的 Linux 二进制链接系统 GLib，并把其符号泄漏进进程空间。在 Electron 进程内，libvips 的 GLib 调用因此解析到错误的实现，加载任何图片——读取头部、完整解码、编码流水线——都会使进程段错误（[electron#46323](https://github.com/electron/electron/issues/46323)）。Desktop 以 `ELECTRON_RUN_AS_NODE=1` 运行共享 Web Host（[决策](2026-09-11-desktop-electron-node-runtime.zh.md)），因此提交给 Linux 应用的每张图片附件都会让 Host 崩溃，`runtime-payload-smoke` 也在产出 Linux 包之前就失败。

## 决策

检测到该组合时——`process.versions.electron` 存在且平台为 `linux`——栅格工作离开 Electron 进程。`@deepseek-ai/dsh-attachment-local` 依据 `rasterNode` 配置（一个普通 Node 可执行文件）启动单个 worker，并以每个请求一帧的带长度前缀帧，把 `probeImage`、`detectImage`、`normalizeImage`、`createRequestImage` 交给它执行。其他运行时继续在进程内使用 Sharp，并忽略 `rasterNode` 与 `rasterWorker`。

检测到该组合但没有 `rasterNode` 的宿主不会挂载失败，而是以可操作的错误拒绝栅格工作：非图片附件继续可用，图像操作报告缺失的可执行文件，而不是让进程崩溃。

存储从不信任 worker 的自报。规范化后的字节在落盘前会在存储侧重新解码，与请求图像字节此前的做法一致，因此 worker 边界只承载字节与事实，不承载权威。

`src/raster-operations.ts` 是唯一调用 Sharp 的模块。`src/image.ts`、`src/normalization.ts`、`src/request-image.ts` 保持已发布的签名，作为经 `src/raster.ts` 分派的门面；`src/raster.ts` 选择运行器并解析 worker 入口。`src/raster-client.ts` 负责通道：启动、请求 id、受背压约束的有序写入，以及等待进程退出后才完成的回收。`src/raster-worker.ts` 在输入结束前持续服务请求，`src/raster-protocol.ts` 定义带分段上限的帧格式。

两项行为避免 worker 拖住宿主的生命周期。空闲 worker 从事件循环中 unref，在途请求再将其 ref，因此一次性 CLI 运行或启动检查在最后一次应答后即可退出，而待完成的操作仍会等待。关闭自己一侧通道、退出或写出不可读帧的 worker，只拒绝该 worker 拥有的请求，被替换的 worker 的请求继续挂起。

### 打包

普通 Node 子进程无法读取 `app.asar` 内的文件，因此打包布局随该决策调整。Electron builder 的 `unpack` 列表把 `sharp`、`detect-libc`、`@img` 和 `@deepseek-ai/dsh-attachment-local` 保留为归档旁的物理文件；worker 入口是包的构建入口（`lib/raster-worker.js`），内联所有 `@deepseek-ai` 工作区模块并保持 Sharp 外部化；`src/raster.ts` 在自身模块旁解析 worker 入口，当打包副本只能由 Electron 读取时，把 `app.asar` 路径映射到 `app.asar.unpacked` 兄弟路径。

Desktop 向 Host 传递 `DSH_PRIMARY_RUNTIME`，Web profile 据此解析出随包主运行时的 Node 可执行文件作为 `rasterNode`。`runtime-payload-smoke` 在 Electron Linux 上改为演练存储的解码、规范化与读取路径，而不再在自身进程内加载 Sharp；macOS 与 Windows 保留进程内检查。

## 考虑过的替代方案

**继续在进程内使用 Sharp 并容忍崩溃。** 否决：受影响的正是图片准入、规范化与请求投影，Linux 应用将完全无法接收截图或附件。

**在 Electron Linux 上加载 Sharp 的 WASM 绑定。** 否决：Sharp 的加载器优先选择原生平台绑定，只在加载失败时回退，而此处并非加载失败；WASM 路径还缺少原生文本渲染，而解码图片位于附件热路径上，会让每台 Linux 宿主都付出吞吐代价。

**在 Linux 上改用随包普通 Node 运行 Host。** 否决：这与已记录的 [Electron 即 Node 决策](2026-09-11-desktop-electron-node-runtime.zh.md)冲突——该决策让 Host 与内置 pnpm 共用一个运行时——也否定了 payload smoke 所验证的打包 node 断言。

**预加载或改写冲突的 GLib。** 否决：泄漏的符号定义属于 Electron 已加载的系统 GLib，而 libvips 静态链接了自己的 GLib，任何预加载顺序或符号作用域都无法从外部修复该错配。

**改为跳过（defer）smoke 而不修复路径。** 否决：`--defer-runtime-smoke` 只会产出一个每次处理图片仍会崩溃 Host 的 AppImage，而这正是该检查存在的意义。

## 后果

- Electron Linux 的图片工作进入第二个进程：每次操作把字节经管道复制一次，每台宿主付出一次 worker 启动成本。空闲 worker 不占用事件循环。
- 每台 Electron Linux 宿主都必须给出普通 Node 可执行文件。Desktop 应用由主运行时提供；其他无法提供的 Electron 宿主必须接受拒绝错误，或自行配置 `rasterNode`。
- 打包解包列表与归档完整性校验现在包含 Sharp 的 JavaScript、其 `detect-libc` 依赖、`@img` 原生包以及 attachment 包。
- worker 故障以失败 worker 的事实呈现——退出码与信号，或协议错误——且被替换 worker 的迟到故障不会拒绝其后继者的请求。
- 进程内栅格工作仍覆盖 macOS、Windows 以及所有普通 Node 运行时，因此只有会崩溃的组合改变了行为。

## 测试

`tests/raster-protocol.spec.ts` 固定帧编解码，`tests/raster-worker.spec.ts` 固定 worker 的请求循环与失败事实，`tests/raster-client.spec.ts` 固定通道（含启动失败、协议失败、worker 死亡与回收），`tests/raster.spec.ts` 固定运行器选择与打包入口解析。`runtime-payload-smoke` 在 Electron Linux 上通过打包后的存储解码并规范化一张真实 PNG。

## 延期

存活但始终不应答的 worker 会让请求无限期挂起；通道会报告死亡与协议失败，但没有截止时间约束卡住的操作。等到观察到真实操作挂起时再加。

## 相关

- [Desktop Electron Node 运行时](2026-09-11-desktop-electron-node-runtime.zh.md)
- [Desktop 主运行时](../feature/2026-09-14-desktop-primary-runtime.zh.md)
