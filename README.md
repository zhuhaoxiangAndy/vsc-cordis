# vsc-cordis

把 [Cordis](https://github.com/cordiverse/cordis) 的「时空可组合性」迁移到 VSCode 扩展开发：
在 Extension Host 之上运行一个微型插件运行时，使业务功能以**插件**形式动态加载、卸载、热重载，
通过声明式 `inject` 声明依赖，服务提供者变化时自动协调依赖方。

- **时间可组合性**：所有副作用经 `ctx.effect` 登记，由 `EffectStack` 以 LIFO 逆序回收。
- **空间可组合性**：服务经 `ServiceRegistry` 提供/注入，维护依赖图，提供者变化时自动暂停/恢复消费者。
- **不修改 VSCode 源码，不使用非公开 API。** 宿主本身是一个普通 VSCode 扩展。

## 目录

| 路径 | 包名 | 职责 |
| --- | --- | --- |
| `packages/sdk` | `@vscordis/sdk` | **契约层**：`PluginContext` / `CordisPlugin` / `plugin.json` / 权限 / 受控 API 类型。零 Node 依赖。 |
| `packages/kernel` | `@vscordis/kernel` | **实现层**：`EffectStack` / `ServiceRegistry` / `PluginHost` / 状态机。零 `vscode` 依赖，可在纯 Node 与 Web Worker 中运行。 |
| `packages/host` | `vscordis` | **唯一发布单元**：VSCode 扩展。把真实 API 桥接成受控面，负责加载/卸载/依赖协调。 |
| `plugins/*` | — | 示例与测试插件（esbuild 打成单文件 CJS）。 |
| `docs/adr` | — | 架构决策记录，每条决策含权衡与否决方案。 |

## 能力矩阵（诚实版）

| 能力 | Desktop / Remote 宿主 | Web 宿主 (vscode.dev) |
| --- | --- | --- |
| 同进程受控 API 插件 | ✅ | ✅ |
| 运行期加载磁盘上的插件 | ✅ | ❌ 浏览器无法运行期加载代码，仅支持**构建期内置**插件 |
| 子进程隔离（untrusted） | ✅ `child_process.fork` | ❌ 直接拒绝加载（fail-closed） |
| 热重载 | ✅ | 仅内置插件启停 |

## 已知硬限制

1. **运行时注册的命令不会出现在命令面板**：命令面板条目来自静态 `contributes.commands`（MenuRegistry），
   只有 `vscode.commands.getCommands(true)` 能反映运行期注册表。宿主为此提供 `vscordis: 运行插件命令…`
   作为动态入口。详见 `docs/adr/0002`。
2. **同进程插件可以绕过受控 API**：扩展宿主把 `vscode` 模块注入给任何扩展目录下的模块，
   `trust: trusted` 的插件在安全上**只防误用、不防恶意**；真正的边界是子进程。详见 `docs/adr/0003`。
3. **Node 权限模型没有网络开关**：`--permission` 可限制 `fs`/`child-process`/`worker`/`addons`，
   但**无法限制 `net`**，网络只能靠 require 拦截 + 审计。详见 `docs/adr/0005`。
4. **VSCode 官方不支持运行期卸载单个扩展**，因此本项目的卸载粒度是「扩展内部的插件」，不是扩展本身。

## 开发

```bash
npm install          # 仅需要 typescript / esbuild / @types/*
npm test             # Node 内置 test runner，直接跑 .ts（Node >= 22.13 原生类型剥离）
npm run typecheck
npm run build        # 构建宿主扩展与示例插件
```

在 VSCode 中按 `F5` 启动 Extension Development Host。
