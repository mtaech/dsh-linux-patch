# Agent Note: Sidebar Browser 的网页元素批注

状态：implemented

[English](2026-11-04-web-element-annotations.md) | 中文

## 问题

Desktop 用户在右侧 Sidebar 的 Browser tab 里看网页时，没有办法把页面上的某个具体元素交给 agent。复制粘贴丢失几何信息，截图丢失 locator，临时设计一条「描述这个元素」的路径又得为 composer 自造传输通道。桌面捕获引擎（主进程在 isolated world 中运行的脚本）已经就绪；缺的是从页面点击到已记录 composer 消息之间与载体无关的渲染端流程。

## 决策

- 渲染端流程与载体无关，并完全走 composer 原生路径。捕获（`BrowserAnnotationControl.capture`）结束后由 DSH React 在 `.content` 内渲染评论编辑器，绝不进入被访问页面或 `<webview>` DOM。保存记录只是在 tab body 里暂存；「添加到对话」是进入 composer 的唯一路径：先用 `conversation.createDrafts` 注册截图，再 `inputActions.addAttachments`，然后按 `nextAnnotationNumber` 以当前草稿为准编号，对每条批注执行一次 `inputActions.insertQuote`，内容由 `formatBrowserAnnotation` 生成。插入的一切都是普通的、已记录的 composer 引用——没有新的 session event，也没有平行的 model-visible 通道。
- conversation 服务通过 `BrowserInjected` 上新增的可选 `annotationDrafts` 桥接访问，由 `ui-sidebar-browser/src/client/index.ts` 的 inject 工厂构建，闭包捕获 scope 与 sessionId，并惰性调用 `scope.get('conversation')`。组件保持不接触 ctx；conversation 服务缺失时流程降级为纯文本引用（省略 Screenshot 字段）而不是失败。
- 部分失败向前回滚，而不是向后：某条引用被拒绝时停止插入，被拒与剩余的记录保留在批注条中，只对它们的截图执行 `removeAttachment` 与桥接 release。已插入的引用保留自己的附件，否则会出现引用指向已失效 object URL 的消息。
- 能力位放在 `BrowserControllerState.canAnnotate`，由 `frame.annotations !== undefined` 推导。Web 的 iframe 不实现捕获，因此批注按钮、提示条、编辑器与批注条完全不渲染——Web 行为逐字节保持不变。
- 对 `@deepseek-ai/dsh-client-ui-conversation` 的类型级依赖只声明在 `dsh.client.inject` 与 `devDependencies` 中；运行时取值一律经由注入的 Cordis 服务。

## 考虑过的替代方案

**为批注单开一个 slot 与独立 props。** 它需要为一个消费者新建 slot 注册并重新穿线 `useInput`/`inputActions` 的等价物；复用现有 body 的会话标准 props 只保留一个注册面，也不引入新的 slot 语法。

**部分失败时释放整批草稿附件。** 整批释放与现有的拖文件回滚一致，但已插入的引用指向自己的截图；释放它们会让发出的消息带着失效的 object URL，因此只分离未插入的附件。

**把批注按 tab 持久化到 browser store。** 批注条是与挂载页面绑定的视图状态，而 locator 会过期；在过期重定位实现之前，持久化只会在重启后展示死批注。

## 后果

Desktop Browser tab 获得批注工具栏操作、进行中提示条、DSH 渲染的评论编辑器，以及支持单条删除与 composer 交接的批注条。编号从草稿中已有的 `## Web Element Annotation N` 续接，手工穿插的引用不会重号。Web 构建的行为与打包面保持不变。

## 测试

`tests/annotation-body.client.spec.tsx` 覆盖 Web 无入口、捕获 → 编辑器 → 保存 → 插入的顺序（含引用编号与截图文件名）、Esc 取消、附件被拒回滚、部分插入回滚、composer 忙碌禁用以及纯文本降级。`tests/browser-body.client.spec.tsx` 的 fixture 补充了 `useInput`/`inputActions` stub，包测试套与 `tsc -b` 覆盖 controller 状态扩展。

## 后续：借鉴 t3code 的改进（同日）

对照 pingdotgg/t3code 的预览批注实现后，采纳三项与其一致的做法，均不需要新的会话事件或新的 slot：

- **多元素选取。** t3code 的元素选取支持 additive 选择（多个 `PreviewAnnotationElementTarget` 共用一条评论，截图按目标矩形并集裁剪）。本实现改为 `targets: DesktopBrowserElementTarget[]`：Cmd/Ctrl/Shift 点击持续收集（上限 8 个，由主进程 `MAX_TARGETS` 与脚本 `MAX_PICKED` 双重约束），Backspace 撤销最后一个，Enter 提交，普通点击立即提交单个元素。引用中每个元素独立成块，共用一个 `## Web Element Annotation N` 标题与一张截图。
- **所属组件名。** t3code 用 `react-grab` 读取组件名与源码栈。本实现不引入该依赖，改为在固定脚本里只读地遍历 `__reactFiber$`/`__reactInternalInstance$` 链取组件 `displayName`/`name`（≤80 字符，主进程再次截断），读不到就省略该行。它把选择器之外的线索交给模型，又不扩大页面可控的信息面。
- **截图按并集裁剪。** 已是既有行为（`clampRects` 求所有选中元素矩形的并集后 `capturePage`），本轮补上多元素场景下的测试与文档说明。

显式不采纳：t3code 把批注输入框渲染进访客页面（`PickPreload` 在页面内建编辑器与样式面板）。那需要给访客页面注入 DSH 的 UI 与样式，并破坏评论内容不可被页面读取的边界；本项目继续把编辑器留在 DSH 可信 DOM。同样不采纳其页面内实时改样式（`styleChanges`），那会引入“预览态样式与源码不一致”的双事实源。
