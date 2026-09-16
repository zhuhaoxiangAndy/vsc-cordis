# 手动验收：M4b 子进程隔离

自动化测试已经用**真实子进程 + 真实 IPC + 真实 `--permission` 标志**验证了隔离的正确性
（`packages/host/test/isolation.spec.ts`，10 项）。
下面这部分是**自动化测不到**的：真实 VSCode（Electron）里 `--permission` 是否被支持。

## 准备

```bash
pnpm run verify        # 会构建出 packages/host/dist/isolated-worker.cjs
```

按 **F5** 启动扩展开发宿主，输出面板选 **VSCordis**。

## 步骤

| # | 操作 | 期望观察 |
| --- | --- | --- |
| 1 | 看启动日志 | `隔离子进程：可用（dist\isolated-worker.cjs）`（在 `显示运行时状态` 里） |
| 2 | `VSCordis: 显示运行时状态` | 插件表里 `isolated-hello` 为 `active`，`provides=-`（隔离插件不参与服务依赖） |
| 3 | `VSCordis: 运行插件命令…` → `isolated-hello.greet` | 弹出「来自隔离子进程的问候：world」 |
| 4 | 打开任务管理器，找 `node.exe` 子进程 | 应当**多出一个由扩展宿主拉起的 node 进程**（就是隔离插件；in-process 插件不会多进程） |
| 5 | `VSCordis: 卸载插件…` → `isolated-hello` | 日志出现子进程退出；第 4 步里那个进程**消失** |
| 6 | 再次 `运行插件命令…` | `isolated-hello.greet` 已从列表消失（宿主侧命令随子进程退出被撤销） |

## 如果第 1 步显示「隔离子进程：不可用」

说明 `dist/isolated-worker.cjs` 没构建出来 —— 先跑 `npm run build`。
此时 `untrusted` 插件会被**明确拒绝加载**（fail-closed），这是设计行为，不是降级。

## 如果插件加载报「Access to this API has been restricted」以外的权限错误

说明当前 VSCode/Electron 组合不支持 `--permission`（本机没能验证这一条）。
临时逃生开关：

```jsonc
// settings.json
"vscordis.isolation.permissionModel": false
```

**关掉它必须明白后果**：文件系统与子进程不再被强制拦截，隔离强度降级为
「无 vscode 模块 + 受控 RPC」——`net` 本来就没有强制手段，`fs` 则从"强制"变成"约定"。
请在 `docs/adr/0013-isolation-backend.md` 的缺口清单里补一条实测结论。

## 必须理解的四条边界

1. **隔离插件不能用服务**（`ctx.use` / `ctx.provide` 会抛错并指向 M4c）：
   服务是进程内对象，跨进程共享需要完整 IDL。
2. **`createStatusBarItem` / `getConfiguration` / `onDidSaveTextDocument` 在隔离模式下不可用**，
   抛错并说明原因 —— 刻意不给"类型同步、实际异步"的假接口。
3. **`net` 是约定不是强制**：Node 权限模型没有网络开关（ADR-0005），
   子进程里只是拦了 `require('net'|'http'|…)`。
4. **隔离插件不会出现在 `ServiceRegistry` 的依赖图里**，因此热重载依赖级联与它无关。
