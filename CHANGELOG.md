# Changelog

本仓库在交付后继续以「轮次」推进；下面每一条都对应 `main` 上的一个提交，
设计理由一律引用 `docs/adr/*`，不复述。

## [Unreleased]

### 新增

- **`ctx.async` 第二个事件**：`onDidChangeActiveTextEditor`（两种模式同一签名；没有活动编辑器时回调
  `undefined`）。与保存事件共用文档句柄设计（`getText()` 按句柄跨进程取、64 个上限、按插件归属校验）。
  见 ADR-0018。
- **整栈副作用回收预算**：`EffectStack.disposeBudgetMs` + 宿主设置 `vscordis.disposeBudgetMs`
  （默认 30000，`0` 关闭）。超出预算后剩余 teardown 不再执行、逐项记日志，并暴露
  `skippedByBudget` 计数；同进程与隔离两种模式共用同一份配置。见 ADR-0015。
- **远程服务代际锚定**：`provide` 时分配代际 token，过期代理调用**响亮失败**并指向
  `ctx.async.useService`，不再静默路由到 last-wins 后的新提供者。见 ADR-0019 决策 13。
- **命令方向的 structured clone 前置校验**：`invoke` 参数、`result` 返回值、
  `commands.executeCommand` 参数都在调用点给出「哪个命令 / 第几个参数 / 路径 / 为什么」。见 ADR-0019 决策 12。
- **CLI 的 engines 提前检查**：`tree` / `list` 把 `engines.vscordis` 与仓库内宿主版本比对，
  不匹配给 warning（强制点仍在加载期）。见 ADR-0017。
- **`--expose-gc` 严格浸泡**（默认 skip）与内存取证方法：1000 轮后堆增长回到噪声范围。见 ADR-0015。
- **可诊断性**：`PluginHost.queueDepth`（串行队列"排队中 + 执行中"的任务数）暴露到
  `vscordis: 显示运行时状态` —— 长时间 >0 就说明某个生命周期任务卡住，比"宿主没反应"精确得多。
- **快速验收单** `docs/acceptance-quick.md`：≈10 分钟走完五条主线，含 `permissionModel` 逃生开关。
- **`--json` 全面进 CLI**：`tree --json`（依赖图；与 `--mermaid` 互斥）、`list --json`
  （插件清单 + findings + problems，退出码与文本模式一致）、`doctor --json`
  （`{ checks: [{name,level,text}], warnings, errors }`，`name` 是稳定契约）——CI 与编辑器工具可消费。
- **`vscordis doctor`**：静态环境自检（Node 版本 vs 仓库下界、宿主包版本、插件根与清单问题数、
  隔离后端产物是否已构建、验签公钥是否就位）；error 级问题退出码 1，warn 不失败。
  它**不**代替手动验收 —— 输出里直接写明这一点。另含扩展产物（`dist/extension.cjs`）检查。
- 状态面板显示**生效的**回收配置（单项超时 / 整栈预算）与"累计起过多少隔离子进程"；
  文档里会随轮次漂移的硬编码测试数改为"以 `pnpm run verify` 输出为准"。
- `scripts/push-with-retry.ps1` 改为只推**当前分支**（此前硬编码 `main` + 一个已合并的
  feature 分支，后者会让重试白等）。
- **文档链接检查成为门禁**：`scripts/check-doc-links.mjs` 校验 Markdown 链接与行内代码里的仓库路径
  （含 ADR 编号短引用，如 `docs/adr/0002`），接入 `pnpm run verify` 与 CI；
  检查器自身的"坏链接会失败"有反向验证测试。
- 内核新增导出：`normalizeVersion`（宿主与 CLI 共用归一化规则）、`RemoteServiceError`。

### 修复

- **隔离子进程默认不再继承宿主的完整 env**：原先 `{ ...process.env }` 会把 token、代理凭据、
  `SSH_AUTH_SOCK` 等暴露给 `untrusted` 插件；现在默认只传系统启动白名单，新增
  `vscordis.isolation.inheritEnv`（默认 `false`）作为逃生开关，开启时每个插件加载都会写降级日志。
  见 ADR-0021。
- **隔离边界可被插件根内的 junction/symlink 绕过**：Node `--permission --allow-fs-read=<pluginRoot>`
  只限制路径字符串、不解析链接；实测 root 内 junction 可读到 root 外文件。现在 fork 前递归扫描
  插件目录，任何链接的 `realpath` 落在 root 外都 fail-closed（`PluginReparsePointError` →
  `PluginIntegrityCheckError`），一个子进程都不会起。见 ADR-0020。
- **桥接层 `track()` 从不调用底层 `dispose`**：`release` 里的 `raw.dispose()` 已经被
  `defineProperty` 覆盖成 `release` 本身（递归守卫直接 return），真正的注销永远不执行 ——
  表现为"命令从 QuickPick 消失、但 VSCode 的命令注册表里还留着"。修法：先抓住原始 dispose 再覆盖。
  同时把命令表清理并入同一条释放路径（插件**提前** dispose 时 QuickPick 也会立刻清掉）。
- **`onDidChangeActiveTextEditor` 曾挂在 `workspace` 下**（SDK 类型约定是 `window`）：
  `as unknown as PluginVscodeApi` 的类型断言把它藏住了，真实宿主里同进程的
  `ctx.async.onDidChangeActiveTextEditor` 会拿到 `undefined`。
  上面两条都是新增的桥接层契约测试（`packages/host/test/bridge.spec.ts`）抓出来的。
- **生产路径的 `engines` 检查曾被静默跳过**：`Runtime` 没有把 `hostVersion` / `vscodeVersion`
  传给 `PluginHost`（新增接线测试守住）。见 ADR-0017。
- **子进程异常退出时在途调用会永久挂起**：`exit` 处理器补 `#failAll`（活锁 → 明确失败）。见 ADR-0019 决策 10。
- 隔离提供者的 `conflict: 'last-wins'` 曾被静默降级为 `exclusive`；未知策略现在两处 fail-closed。见 ADR-0019 决策 8。
- `ctx.provide` 的 `remote` 标记不再可由插件自设（同进程与隔离两处拒绝）。见 ADR-0019 决策 9。
- 隔离路由表与注册表的顺序问题：`provide` 抛冲突时不再留下指向"从未生效的提供者"的路由。
- 版本协商补齐：`tryResolve` 支持范围（版本不符不再被当成"软依赖缺失"）；
  隔离取用点复查消费者声明的范围。见 ADR-0019 决策 7。
- pnpm 11.7 下 `allowBuilds` 未决占位导致 `pnpm install` 退出 1、`pnpm run verify` 不可运行。见 ADR-0009 决策 5。
- **隔离子进程畸形 IPC 可终止宿主进程**：`process.send(null)` 会让 `message.kind` 抛 `TypeError`
  进宿主事件循环（Extension Host DoS）。现在消息入口做结构校验、`#handle` 包 try/catch，
  畸形消息只失败该会话；启动/激活阶段也会快速 reject，不再干等 readyTimeout。
  激活后的协议违规同样走 `onUnexpectedExit` 把 `PluginHost` 记录转 `failed`，不会留下
  “进程已死但状态 active”。
- **畸形 IPC 对象的 `toString` 仍可打崩宿主**：`process.send({ kind: 1, toString: 'not-a-function' })`
  会让监听器里的 `describe(message)`/`String()` 抛 `TypeError`（在 try/catch 之外）。现在整个
  message 监听器包 try/catch，并用只读 `typeof/kind` 的“永不抛”摘要替代 `String(value)`；
  `#handleCall` 的错误回复也改用安全格式化。
- **隔离命令 `unregisterCommand` 可跨插件越权**：B 可注销 A 的命令再抢注同名 ID；由于
  `VscodeHostApi.dispose` 修复后 unregister 会真的调用底层 dispose，这条路径变成真实劫持。
  现在注册遇到其它 owner 抛 `PermissionDeniedError`；注销接口携带 pluginId 并做归属校验，
  两种模式同规则。见 ADR-0023。
- **ADR-0020 reparse 扫描误伤 pnpm workspace 依赖链接**：`pnpm install` 后每个插件根都有
  `node_modules/@vscordis/sdk -> packages/sdk`，一刀切拒绝会让所有 untrusted 插件加载失败。
  现在 `node_modules/<pkg>` 目标 `package.json#name` 同名时放行；`.bin` 链接要求目标位于某个包目录内；
  其余外部链接仍 fail-closed。见 ADR-0020 决策 8。
- **`isInside` / reparse 扫描把 `<root>/..evil/...` 误判为 root 外**：
  `relative.startsWith('..')` 对 `..evil` 为真；现在只拒绝 `..` 段本身（`relative === '..' ||
  relative.startsWith('..'+sep)）。
- **降级 warning 默认不可见**：`inheritEnv` 与“跨 trust last-wins 接管”日志此前经 `onLog`
  落到 debug；新增 `onWarning` 出口，Runtime 接到 warn 级日志（ADR-0022 决策 3）。
- **`onError` 观察者抛错会把 EffectStack 永久卡在 draining**：观察者异常现在被吞掉不阻断回收；
  `#drainPromise` 异常中断会清缓存，允许下次 `dispose()` 继续回收剩余项（审计 F2）。
- **隔离路径下 `vscode:workspace.read` 未生效**：无权限插件也能拿到 `workspaceFolders`。
  现在宿主侧无权限不预取、子进程侧同步拒绝。
- **last-wins 的被替换者卸载会删掉接管者的远程路由**：路由清理现在校验代际 token，
  只删除仍属于本次 `provide` 的条目；新增真实 IPC 回归。
- **ServiceRegistry 旧 handle 撤销新提供者、hard 依赖边被 soft 覆盖、last-wins 后旧 owner
  `provides` 残留**：handle 绑定 generation、hard 不降级、换人时清理旧 owner 集合。
  `depend` 进一步改为**按 kind 引用计数**：提前 dispose 一个 edge 不再误删另一条
  （soft 撤销后 hard 仍在；hard 撤销后 soft 仍在，只是不再参与级联）。
- **隔离子进程同名重复 `provide` 的旧 handle dispose 会 revoke 新提供者**：
  子进程侧按代际计数，过期 handle 的 revoke 是 no-op；否则宿主注册表只看到服务名，
  无法区分是哪一代，旧 handle 会把新提供者一起撤销。
- **`settle()` 不是队列屏障**：单次 no-op 会排在二级级联之前，返回时仍可能 `queueDepth > 0`。
  现在等待队列尾部，出现新任务就继续等，直到真正排空。
- **`EffectStack` 并发 `dispose()` / draining 期间 `add()` 破坏严格串行 LIFO**：
  并发 dispose 复用同一条回收链；draining 期间新增/提前 dispose 的项回到队列按 LIFO 执行。
- **热重载改 `plugin.json#id` 留下旧 incarnation 与幽灵命令**：同目录 id 变化时先卸载旧 id，
  再加载新 id，并重建 `dir → id` 映射（避免目录改名后误卸载活插件）。
- **`plugin.json` 被删除（目录仍在）后旧 incarnation 仍 active**：现在确认文件不存在时卸载旧 id；
  文件存在但解析失败保持旧版本，避免编辑器两次写入之间的瞬时空窗误卸载（ADR-0011 决策 7）。
- **隔离子进程激活后异常退出，`PluginHost` 仍显示 active**：loader 通过 `onUnexpectedExit`
  上报，`PluginHost.reportExternalFailure()` 走串行队列转 `failed` 并回收宿主侧副作用。
- **热重载计划未串行化**：debounce 窗口外的多个 plan 现在排队处理，`Runtime.dispose()`
  会先等已排队的计划跑完再拆宿主。
- **服务没有信任级隔离**：保留 ADR-0019 的跨 trust `last-wins` 能力，但发生
  “untrusted 接管同进程服务”时写显式 warning，并新增 ADR-0022 声明消费者应使用
  `exclusive` 或自行校验 owner/version。
- 文档更正：ADR-0005 如实记录 `net` 拦截可被 `process.getBuiltinModule()` / 动态 `import()` /
  全局 `fetch` 绕过，并说明 `fs:read` 在隔离下不扩大边界；清理 M1/M2“留待后续”过时表、
  signing/README 的隔离与版本表述、README 体积/配置表漂移；`plugin-authoring` 隔离能力表
  改为当前事实（`ctx.provide` 可用、同步 `ctx.use` 永久拒绝、事件/服务走 `ctx.async`）。
- **`VscodeHostApi.dispose()` 此前没有调用点，且只清 Map 不真正注销命令/不回收文档句柄**：
  现在命令记账保存底层 disposable、`dispose()` 真正注销并清空文档句柄；`Runtime.dispose()`
  兜底调用，新增 `vscode-host-api.spec.ts` 契约测试。

### 测试

- `tsconfig.check.json` 明确排除 `packages/*/test/scratch/**`：一次性审计探针不该让主门禁变红。
- 新增 H1/H2/F1/M1/M2/F2 回归：`toString` 畸形 IPC 不打崩宿主、命令 ID 跨插件归属、
  pnpm workspace 依赖链接放行/无同名 package 拒绝、`..evil` 不误判、跨 trust 接管写 `onWarning`、
  坏 `onError` 不卡回收。
- CI 在 Node 24 上显式运行 `pnpm run test:soak:strict`（`--expose-gc` 1000 轮严格浸泡），
  避免严格证据在默认 `pnpm test` 里永远 skip；本地实测堆增长 -0.21 MB。
- 修复 `disposeBudgetMs` 用例在 CI 上的墙钟 flake：不再断言“恰好 2 项被跳过”（慢项超时后若还剩
  1ms，边界项会被合法执行），改为强不变式“剩余项要么执行、要么逐条上报，绝不静默丢失”。
- 新增 ADR-0021 回归：env 白名单单元测试 + 真实子进程验证（默认看不到宿主变量，
  `inheritEnv=true` 时能看到）。
- 新增 ADR-0020 回归：外部 junction 必须在 fork 前拒绝（`sessionsStarted === 0` 哨兵），
  root 内 junction 不误伤。
- **稳定性（flake hunt）**：完整套件连续 3 次全绿 —— 258 项（257 通过 + 1 个 `--expose-gc` 严格用例
  按设计 skip），每次约 4.6s；未发现时序脆弱用例。**发布门槛**：`pnpm run verify:release` 通过
  （生产构建 + vsce 打包 + 对真实 VSIX 的 9 项断言，解压后 139.6 KB，无源码/测试/node_modules/sourcemap）。
- 170 → **215 项**（214 通过 + 1 个 `--expose-gc` 严格用例按设计 skip），8 个构建目标、4 个插件产物冒烟。
- 两条关键回归做了**反向验证**（临时去掉修复必须失败）：子进程崩溃的在途调用、last-wins 后的旧代理。
- 新增规模/内存证据：`soak.spec.ts` 的严格模式明确排除了**夹具自身记账**（状态转换日志数组）对堆测量的污染；
  另加 300 插件依赖链的加载/卸载规模测试（实测约 30ms，结构归零 + 10s 灾难性回归上界）。
- 新增**扇出**规模测试（1 提供者 + 300 消费者，实测约 16ms）与两条**分层不变量**元测试
  （kernel 不得 import `vscode`/`node:*`；sdk 对 `vscode` 的引用必须全为 `import type`），
  后者做过反向验证（临时注入 `node:os` 会立刻变红）。
- 新增**桥接层契约测试**（`packages/host/test/bridge.spec.ts`，用 `module.registerHooks` 把
  `vscode` 解析到 stub）：命令注册/注销与 QuickPick 数据源、executeCommand 权限矩阵、
  窗口消息/状态栏/输出通道的权限与幂等 dispose、只读配置视图、事件订阅与 EffectStack 回收。
  **边界写进文件头**：它覆盖桥接层逻辑，不替代真实 Electron 行为的手动验收。
- 新增 `buildGraph` 规模测试：500 插件的长链与扇出，宽松上界抓 O(n²) 退化（实测约 14ms 合计）。
- 新增**运行时装配层契约测试**（`packages/host/test/runtime.spec.ts`，同一套 vscode stub）：
  `initialize()`（空根与带插件两种）、`statusLines()` 的关键诊断行、6 个宿主入口命令的注册与
  真实行为（空命令提示 / 状态通道 / `unloadAll`），以及"从磁盘发现 → 自动加载 → 状态 → 卸载"
  的全链路装配。真实 Electron、权限模型与真实文件监听仍由手动验收负责。
- 新增**同进程 `ctx.async` 事件全链路**测试（bridge 订阅 → stub 发射 → kernel 适配器 → 插件，
  含 `undefined` 语义与卸载清理），并做过反向验证（把 bridge 的成员置空 → 插件立刻 `failed`）。
- 新增三条**跨模式服务契约**测试：同进程提供者 → 隔离消费者明确拒绝（给出两条出路、终态 failed
  而非 paused）；同进程 last-wins 接管远程服务后隔离消费者恢复失败；反向接管如实标记 `remote`
  且异步面可用。结论写进 ADR-0019 决策 14（静态可达性 ≠ 动态可替换性）。
- 隔离浸泡 20 → **40 轮**：每轮都断言"起了新进程"（新增 `sessionsStarted` 单调计数）与
  "退干净了"，并把状态面板补成"活跃会话 N · 累计起过 M"。
- 新增**多会话隔离浸泡**（8 轮 × 3 个子进程 = 提供者/消费者/独立插件）：每轮覆盖会话记账
  0→3→0、一次跨两个子进程的服务调用、以及"卸载提供者 → 消费者 paused、独立插件不受影响"。
- `unload(不存在的 id)` 保持幂等，但不再完全静默：留一条含 plugin id 的 debug 日志
  （本轮多会话浸泡因为把目录名当 id 而"卸载无效"，静默 no-op 让问题多花了一轮定位）。

### 文档

- ADR-0009 / 0015 / 0017 / 0018 / 0019 更新「未覆盖」为现状；`docs/plugin-authoring.md`、
  `docs/acceptance-m4b.md` 同步新能力与手动验收步骤。
- `docs/design/overview.md` 修正「两种执行模式」表中一行过时描述（"服务跨进程 ❌"），补贡献者地图。
- 新增 `docs/acceptance-quick.md`（≈10 分钟验收主线）并从 README「快速开始」链入。
- 新增 `docs/adr/README.md`：19 份 ADR 的索引（编号/标题/状态 + 按主题与首次阅读路径），
  从 README 目录链入；索引里的 19 条链接由文档链接门禁守着。
