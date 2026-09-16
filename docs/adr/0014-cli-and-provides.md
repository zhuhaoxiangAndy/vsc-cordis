# ADR-0014：CLI 与 `provides` 声明（M5）

状态：已接受（2026-02-14，M5 实施轮）｜决策者：无人值守自主决策

## 背景

M5 要交付 CLI，其中「依赖图可视化」是列表里的明确项。但这里有个先决问题：
**服务是运行期通过 `ctx.provide()` 注册的**，`plugin.json` 里只有 `dependencies`（我需要什么），
没有"我会提供什么"。静态图画不出来。

## 决策 1：给 `plugin.json` 增加 `provides` 声明，但**只服务于工具**

`provides: string[]` 是纯声明式的工具字段：

- 运行期仍然以 `ServiceRegistry` 为准，`provides` **不参与**任何加载决策；
- 声明与实际不一致**不会**导致加载失败，但宿主会在激活后比对二者并**告警**
  （`PluginHost.#checkProvidesDrift`）。

为什么是"只告警不阻断"：服务是运行期决定的，静态声明天生只能尽力而为；
把一个纯工具字段变成加载门槛，会让它从"帮助"变成"负担"。
反过来说，**不检查**又会重演 `CordisPlugin.inject` 那个坑 ——
声明了却不生效、且没有任何反馈（ADR-0010 决策 2）。所以取中间态：检查 + 告警。

## 决策 2：静态依赖图的**硬边界**（写进 CLI 输出，避免误用）

| 边界 | 说明 |
| --- | --- |
| 服务版本无法静态校验 | 服务的版本来自运行期 `ctx.provide(name, value, { version })`，清单里没有这个概念。图里只能校验"有没有提供者" |
| 声明可能失真 | `provides` 是作者声明的，可能与代码不符（宿主会告警，但图本身不知道） |
| 隔离插件不参与服务依赖 | `trust: untrusted` 的插件在子进程里，`provide`/`use` 会抛错（ADR-0013）。若它们声明了服务，CLI 会给出警告 |
| 加载顺序仅供展示 | 运行期正确性不依赖加载顺序（`paused` 会被自动唤醒，ADR-0007）；拓扑序只是体验优化 |

## 决策 3：CLI 复用而不是复制实现

- 插件发现 → 复用 `packages/host/src/discovery.ts`（同一份 `plugin.json` 校验与路径检查）
- 签名 → 复用 `packages/host/src/integrity.ts`（签名脚本与校验器共用同一实现）
- 依赖图 → 本包 `graph.ts`（**纯函数**，无 IO，可穷举测试）

复用方式是**相对导入**（`../../host/src/discovery.ts`），而不是新建一个共享包或声明依赖。
理由：CLI 是 `private: true` 的内部工具，不会再单独发布，相对导入能让"只有一份实现"这件事
不需要额外的包边界来维持。代价写清楚：**CLI 无法脱离本 monorepo 单独发布**。
如果将来要发布 CLI，正确的做法是把 discovery 抽成独立包，而不是把它们复制一份。

## 决策 4：CLI 产物是 **ESM**，`esbuild` 标为 external

入口用了顶层 await 做命令分发，因此 esbuild 输出 `format: 'esm'`（`dist/cli.mjs`）。
`esbuild` 只在 `vscordis dev` 里**动态导入**：不该拖累其它命令的启动，也不该被内联进产物。

## 决策 5：退出码约定

`0` 成功 / `1` 发现问题（坏清单、缺提供者、依赖环、回验失败）/ `2` 用法错误。
于是 `vscordis list` 可以直接进 CI：有问题就是非零退出。

## 命令与实现位置

| 命令 | 作用 | 关键点 |
| --- | --- | --- |
| `create <名字>` | 生成插件骨架 | 目标目录存在则**拒绝**（绝不覆盖）；`--trust untrusted` 会附上隔离限制说明 |
| `list` | 列出插件并做依赖图检查 | 坏清单只影响它自己，其它插件照常列出 |
| `tree [--mermaid]` | 服务依赖图 | 文本视图 + Mermaid flowchart（可直接贴进 Markdown） |
| `sign <目录> [--verify]` | 签名 | 复用 M4a 的实现；`--verify` 用仓库公钥回验 |
| `dev` | 增量重建 | 与 `scripts/watch.mjs` 同一策略：编译归开发期，不进宿主进程 |

## 未覆盖

- `dev` 命令没有**完整**端到端测试：它是长驻进程，测试需要 spawn + 信号，
  且 Windows 上 `SIGTERM` 会直接终止进程、`runDev` 里的优雅收尾回调根本不会执行，
  断言"退出码为 0"会变成一条平台相关的假测试。已测的是它的**前置检查**
  （目录里没有可构建插件时给出可操作错误 —— 见 `commands.spec.ts` 的两条 dev 用例）。
- Mermaid 输出只断言了语法结构，没有在真实渲染器里看过。
- ~~`create` 生成的插件骨架没有被"生成后立即构建并加载"的端到端测试覆盖。~~
  **已在后续轮次补上**：`packages/cli/test/e2e.spec.ts` 把
  `create → esbuild 构建 → 真实 NodeModuleLoader 加载 → 真实 PluginHost 激活 → 执行命令 → 卸载清缓存`
  串成一条链，并顺带用真实校验器验证生成的 `plugin.json` 合法。
