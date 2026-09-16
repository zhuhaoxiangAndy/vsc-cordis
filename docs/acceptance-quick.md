# 快速验收（≈10 分钟）

这份文档是 `acceptance-m1-m2.md` / `acceptance-m3.md` / `acceptance-m4b.md` 的**主线串联版**：
按顺序走完就能覆盖「命令生命周期、依赖级联、隔离子进程、显式异步面、热重载」五件事。
需要细节、失败分支与边界说明时，看对应里程碑的详细文档。

> 为什么还有手动验收：桥接层的**逻辑**（权限门、命令表记账、副作用回收、只读配置视图、事件订阅）
> 已经有 stub 契约测试（`packages/host/test/bridge.spec.ts`）；但**真实 Electron 行为**
> —— 桥接在真实宿主里的表现、`--permission` 是否可用 —— 无法在 `node --test` 里覆盖，
> 项目按用户决策**不跑** `@vscode/test-electron` e2e。
> 自动化能覆盖的部分是 235+ 项测试（含 1 个 `--expose-gc` 严格用例按设计 skip）。

## 0. 准备（1 分钟）

```bash
pnpm install
pnpm run verify        # 期望：215 项（214 通过 + 1 skip）、8 个构建目标、4 个插件冒烟
```

在 VSCode 里打开本仓库，按 **F5**（`.vscode/settings.json` 已把 `vscordis.pluginRoots`
指向 `${workspaceFolder}/plugins`）。等几秒让插件自动加载。

**通过标准**：`Ctrl+Shift+P` → `VSCordis: 显示运行时状态`，应当看到：

- `隔离子进程：可用（…）· 活跃会话 1（isolated-hello）`
- `任务队列：深度 0（空闲）`
- 4 个插件 `active`：`hello`、`provider-clock`、`consumer-greeting`、`isolated-hello`
- 服务表：`clock ← provider-clock@1.0.0#1 ← 消费者: consumer-greeting(hard)`

---

## 1. 命令生命周期 + 卸载无残留（2 分钟）

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | `VSCordis: 运行插件命令…` → `hello.greet` | 弹出 `Hello, VSCordis！来自插件 hello` |
| 2 | `VSCordis: 卸载插件…` → `hello` | 提示已卸载；输出通道出现 LIFO 回收说明 |
| 3 | 再次 `VSCordis: 运行插件命令…` | **`hello.greet` / `hello.echo` 已消失**（命令面板里本来就没有，见 ADR-0002） |
| 4 | `VSCordis: 加载插件…` → `hello` | 两个命令回到 QuickPick；状态面板里是 `active` |

**通过标准**：卸载后运行期命令表立刻反映变化，且状态面板里没有残留记录。
细节：`docs/acceptance-m1-m2.md`。

## 2. 依赖级联：提供者走了，消费者自动 paused（2 分钟）

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | 运行 `greeting.time` | 弹出 `[clock#1] 时:分:秒` |
| 2 | 卸载 **`provider-clock`** | 提示包含「**1 个插件因依赖缺失而 paused：consumer-greeting**」 |
| 3 | 运行 `VSCordis: 运行插件命令…` | `clock.label` 与 `greeting.time` **都消失** |
| 4 | 状态面板 | `consumer-greeting` 是 `paused`，`等待依赖：clock` |
| 5 | 加载 `provider-clock` | 提示 paused 数归零 |
| 6 | 运行 `greeting.time` | 弹出 **`[clock#2]`** —— 消费者拿到的是新实例（`#N` 递增说明模块缓存被正确清空） |

**通过标准**：第 6 步必须是 `#2` 或更大；若仍是 `#1`，说明模块缓存没清干净。
细节：`docs/acceptance-m1-m2.md`。

## 3. 隔离子进程 + 显式异步面（3 分钟，含唯一未实测假设）

`isolated-hello` 跑在独立子进程里（`trust: untrusted`）。在 **`Isolated Hello`** 输出通道里观察：

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | 随便改一个文件并 **Ctrl+S** | 通道出现 `保存：<路径>（N 行，M 字符）` |
| 2 | 切换活动编辑器（点另一个文件） | 通道出现 `当前文件：<路径>（<语言>）` |
| 3 | 关闭所有编辑器 | 通道出现 `活动编辑器：<无>`（"没有活动编辑器"是事件本身的信息） |
| 4 | 运行 `isolated-hello.greet` | 弹出「来自隔离子进程：…」（值是 `settings.json` 里的 `isolated-hello.greeting` 或默认「你好」） |
| 5 | 卸载 `isolated-hello`，再切换编辑器/保存 | 通道**不再**出现新行；状态面板 `活跃会话 0` |

### ⚠️ 唯一没在真实 VSCode 实测过的假设：`vscordis.isolation.permissionModel`

整个隔离方案里只有这一条属于"设计上成立、但没在你的 Electron 上实测过"。它由
Node 的 `--permission` 标志支撑（限制子进程的文件系统/子进程/worker）。

- 若第 0 步状态面板显示「隔离子进程：**不可用**」，或 `isolated-hello` 加载报
  `Access to this API has been restricted` 之外、看起来与权限模型有关的错误：
  1. 在 `settings.json` 里设 `"vscordis.isolation.permissionModel": false`；
  2. `Ctrl+Shift+P` → `Developer: Reload Window`；
  3. 重复本步骤。
- **降级后果（必须知道）**：关掉之后子进程里不再有文件系统/子进程的**强制**拦截，
  隔离强度降为「无 `vscode` 模块 + 受控 RPC + 网络 require 拦截（约定）」。详见 ADR-0013。
- 请在反馈里写明：VSCode/Electron 版本、`node --version`、报错原文、
  以及关闭该开关后是否恢复正常。

细节与失败分支：`docs/acceptance-m4b.md`。

## 4. 热重载可见（1.5 分钟）

```bash
pnpm run watch   # 终端里跑着
```

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | 改 `plugins/hello/src/index.ts` 里的一句问候语并保存 | **1 秒内**插件自动 reload，命令返回值变成新文案 |
| 2 | 故意写一个语法错误并保存 | 插件进入 `failed` 并弹出警告；**不会回滚**到旧版本（ADR-0011） |
| 3 | 修好并保存 | 恢复 `active` |

细节：`docs/acceptance-m3.md`。

## 5. 收尾：全部卸载后必须"干净"（0.5 分钟）

1. `VSCordis: 卸载全部插件`。
2. 打开状态面板，通过标准：

- 插件表为空、活命令为空、服务表为空；
- `活跃会话 0`（隔离子进程真的退出了）；
- `任务队列：深度 0`（没有卡住的生命周期任务）。

---

## 附：任何一步失败时，请收集这些信息

1. 状态面板的完整文本（`VSCordis: 显示运行时状态` 的输出通道内容）；
2. 相关输出通道（`VSCordis` / `VSCordis Hello` / `Isolated Hello`）的最后几行；
3. `VSCode: 帮助 → 关于`（版本 + Electron 版本）、`node --version`；
4. 第 3 步额外注明：`vscordis.isolation.permissionModel` 是 `true` 还是 `false`，报错原文。

自动化能覆盖的 215 项测试**不包含**上面任何一条的真实 Electron 行为 ——
所以这份单子不是形式，它是唯一能证明"桥接层在你的机器上真的工作"的证据。
