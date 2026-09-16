# ADR-0001：基线架构分层与依赖倒置

状态：已接受（2026-02-14）｜决策者：无人值守自主决策（用户已授权）

## 背景

需要在 VSCode Extension Host 之上运行一个类 Cordis 的插件运行时。约束：

1. 不修改 VSCode 源码、不使用非公开 API；
2. 宿主本身必须是普通 VSCode 扩展（唯一发布单元）；
3. 卸载后无残留、依赖变化时依赖方自动协调；
4. 用户要求"全平台都要"（Desktop / Remote / Web）。

## 决策

四条分层：

| 层 | 包 | 硬约束 |
| --- | --- | --- |
| 契约层 | `@vscordis/sdk` | **零运行时依赖**；只允许 `import type * as vscode`（编译期擦除）。插件作者唯一依赖的包。 |
| 实现层 | `@vscordis/kernel` | **零 `vscode` 依赖、零 Node 依赖**（不用 `require`/`node:fs`/`node:path`）。可在纯 Node、Web Worker、子进程中运行。 |
| 适配层 | `vscordis`（host 扩展） | 唯一与 `vscode` 和 Node 交互的地方；实现 `HostPort` / `IsolationPort`。 |
| 产物层 | `plugins/*` | esbuild 打成**单文件 CJS**，只依赖 sdk 的类型。 |

依赖倒置：kernel 通过 `HostPort`（加载模块、创建受控 API、日志）与 `IsolationPort`（隔离后端）向外依赖，
host 提供实现。kernel 因此可以在单元测试里用 `FakeHostPort` 完整跑通生命周期，不需要启动 VSCode。

## 备选方案与否决理由

- **单体包（host 内含 kernel）**：否决。宿主的 esbuild bundle 会用 `vscode` 占位模块污染测试与子进程；
  且 kernel 无法在 Web Worker 中独立运行。
- **把 kernel 放进 `node_modules` 私有包但不做零 vscode 约束**：否决。违反"受控 API"原则（原则 5）。
- **直接用 InversifyJS 做 DI**：否决。它解决的是"容器解析"，不解决"提供者消失时自动回收副作用"；
  本项目需要的是**生命周期与依赖图**，不是容器。DI 只是副产品（`ctx.use`）。

## 后果

- kernel 的单元测试零 IO、零 VSCode，可全量覆盖状态机与级联回收。
- 代价：跨层通信需要显式类型（`HostPort`），多了一层间接。
- 代价：kernel 不能直接 `import 'node:path'`，Web 兼容性靠"禁用 Node 内建模块"这条纪律维持。
