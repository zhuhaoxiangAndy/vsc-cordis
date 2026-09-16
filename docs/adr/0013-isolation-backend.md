# ADR-0013：子进程隔离后端（M4b）

状态：已接受（2026-02-14，M4b 实施轮）｜决策者：无人值守自主决策

## 背景

ADR-0003 定下三级模型：`trusted` 走同进程（只防误用），`untrusted` 走子进程（真边界），
**没有隔离后端时 fail-closed 拒绝加载**。M4a 之前 `supportsIsolation` 一直是 `false`，
所以所有 `untrusted` 插件都被拒绝。本 ADR 落实那个后端。

## 决策 1：隔离层不 import `vscode`，宿主能力靠注入

`isolated-loader.ts` 与 `child-bootstrap.ts` 都不 import `vscode`；宿主能力通过
`IsolatedHostApi` 接口注入（生产环境由 `VscodeHostApi` 用真实 API 实现）。

这不是洁癖，而是**可验证性**的前提：正因如此，整条链路（真实子进程 + 真实 IPC +
真实 `--permission` 标志）可以用 `node --test` 端到端验证，不必启动 VSCode。
桥接层之所以只能靠手动验收，就是因为它绕不开真实 `vscode` 模块。

## 决策 2：权限 → 隔离参数，并如实区分「强制」与「约定」

| 权限 | 手段 | 强度 |
| --- | --- | --- |
| `fs:read` / `fs:write` | `--permission` + `--allow-fs-read/write=<插件目录>` | **强制**（实测：越界读得到 `ERR_ACCESS_DENIED`） |
| `process:spawn` | 不加 `--allow-child-process` | **强制** |
| `worker` / `addons` / `wasm` / `inspector` | `--permission` 的默认值 | **强制**（我们不主动放开） |
| `net` | 子进程内拦截 `require('net'\|'http'\|…)` | **约定**（Node 没有网络开关，ADR-0005） |

`fs:write` 只放开**插件自己的目录**，不放开工作区。需要写工作区的场景等 M4c 引入更细的路径授权。

带 `net` 或 `process:spawn` 的插件会在加载时打印降级警告：隔离强度确实变弱了，不能静默。

## 决策 3：`ctx.vscode` 在子进程里是 RPC 代理，命令 handler 走**反向调用**

函数传不过 IPC，所以插件的命令 handler 留在子进程里，宿主执行命令时反向请求它求值
（`invoke` → `result`）。这是整套协议里最实质的部分，也是"注册/卸载"能照常工作的原因。

`execArgv` 用 `serialization: 'advanced'`（structured clone）而不是默认 JSON：
至少能保住 `undefined` / `Date` / `Map` / `Set`。

## 决策 4：子进程的寿命 = 宿主侧的一项副作用

`ctx.effect(() => session, (s) => s.kill())`。

于是"卸载后无残留"对隔离插件有了**更强**的等价物：不是"尽力清干净"，而是"进程不存在了"。
同时 `IsolatedSession` 在子进程退出时撤销**所有**宿主侧注册（命令、输出通道），
否则卸载后会留下幽灵命令 —— 那正是 M1 验收标准在隔离模式下的翻版。有专门测试覆盖。

停用顺序：`deactivate()` 先让子进程优雅收尾（它自己用**同一套 kernel EffectStack** 做 LIFO 回收），
随后宿主 EffectStack 回收时 `kill` 作为兜底。

## 决策 5：M4b 的能力边界（**刻意收窄**）

隔离子进程可用：`commands.registerCommand` / `commands.executeCommand` /
`window.show*Message` / `window.createOutputChannel` / `workspace.workspaceFolders`，
外加本地 shim 的 `Uri` / `Disposable` / `EventEmitter`。

**明确不支持（抛错并说明原因，不给假接口）**：

> ⚠️ 下表是 **M4b 时点的历史边界**，不是当前能力清单。后续 ADR-0016（配置快照/状态栏）、
> ADR-0018（显式异步事件面）、ADR-0019（跨进程服务）已补齐其中的多项；请以那些 ADR 与
> `docs/plugin-authoring.md` 第 5 节为准。

| 能力 | 为什么不支持 |
| --- | --- |
| `window.createStatusBarItem` | 需要一个能读写属性的代理对象，M4c |
| `workspace.getConfiguration` | 同步语义要求宿主在激活时按"插件声明的配置键"预取快照，需要在 plugin.json 引入 `configuration` 声明，M4c |
| `workspace.onDidSaveTextDocument` | 需要宿主→子进程的事件转发通道，M4c |
| `provide` / `use` | 服务是**进程内对象**，跨进程共享需要完整 IDL + 序列化契约，M4c |

宁可响亮失败，也不给"类型是同步、实际返回 Promise"的假接口 ——
后者会让插件作者在运行时才发现语义完全不同。

## 决策 6：`registerCommand` 这类"同步返回 Disposable"的调用，必须有一条**激活屏障**

这是本轮实测中抓到的真实缺陷：`registerCommand` 必须同步返回 `Disposable`，
于是它对宿主的调用只能是 fire-and-forget。最初的实现把它 `.catch(log)` 了事，
结果是**插件显示"激活成功"，但命令其实是死的**（宿主侧因权限不足拒绝了注册，
子进程只在日志里记了一笔）—— 属于最难查的一类问题。

现在两道保险：

1. **本地快速失败**：子进程按握手时下发的权限先同步抛错，与 in-process 体验一致；
2. **激活屏障**：`activate()` 返回前等所有未完成的宿主调用结算，任何一个失败都让激活失败。

宿主的判定始终是**权威**的：子进程的本地检查只是"快速失败"，不是安全边界。

## 实测证据（全部由 `node --test` 自动化）

| 断言 | 结果 |
| --- | --- |
| 注册命令 → 宿主执行 → 反向调用子进程 handler → 结果回传 | ✅ |
| 卸载后子进程退出且宿主侧命令被撤销（无幽灵命令） | ✅ |
| 子进程里 `require('vscode')` 失败 | ✅（实测拿到的是 `Access to this API has been restricted` —— 连模块解析都被权限模型挡住，比预期更严） |
| 子进程读插件目录外的文件 | ✅ `ERR_ACCESS_DENIED`（**这是强制隔离的直接证据**） |
| 未授权注册命令 | ✅ 激活失败，宿主侧零残留 |
| 不支持的能力 | ✅ 抛错并指向 M4c |
| 未授权 `require('node:net')` | ✅ 被拦截（并如实标注"防误用"） |

## 未验证 / 已知缺口

1. **真实 VSCode Extension Host 中的 `--permission` 仍未 F5 验收**。已用本机
   VSCode 1.118.1 / Electron 39.8.8 / Node 22.22.1 的 Electron-as-Node 模式预验证：
   `--permission` 被接受，越界读/写/worker/child-process/`vscode` 导入均被拦，
   `isolation.spec.ts` 全绿（以 `pnpm run verify` 输出为准）。这**不等价于**真实
   Extension Host；逃生开关 `vscordis.isolation.permissionModel` 仍然保留。
   旧 VSCode 若自带 Node <22.13，必须显式关闭该开关（隔离降级为约定）。
2. **`--permission` + `silent: true` 的 stderr 会带上 SecurityWarning**，目前原样转到日志，未做过滤。
3. 隔离插件**不能参与服务依赖**这条已被 ADR-0019 部分取代：`ctx.async.useService` 可消费
   `remote` 服务；同步 `ctx.use` 仍被拒绝。决策 5 的"明确不支持"表是 M4b 历史边界，
   当前能力以 ADR-0016 / 0018 / 0019 为准。
4. 生命周期里没有"插件主动重启子进程"的路径：崩溃 = 插件 `failed`，需手动 reload；
   崩溃后宿主状态可见性由 ADR-0019 决策 10 与后续"外部失败上报"接线保证。
5. reparse point 越界由 ADR-0020 在 fork 前拒绝；宿主 env 暴露面由 ADR-0021 默认白名单收敛；
   服务没有信任级隔离由 ADR-0022 明确声明。
