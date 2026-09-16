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

1. **隔离插件不能用服务**（`ctx.use` / `ctx.provide` 会抛错）：服务是带方法的进程内对象，
   跨进程代理会让 `now()` 从 `Date` 变成 `Promise<Date>`。
2. **`onDidSaveTextDocument` 在隔离模式下不可用**：回调参数 `TextDocument` 带同步方法，
   跨进程只能给纯数据子集。这两个是**设计边界而非待办**，见 `docs/adr/0016-isolation-capability-tradeoffs.md`。
3. **`net` 是约定不是强制**：Node 权限模型没有网络开关（ADR-0005），
   子进程里只是拦了 `require('net'|'http'|…)`。
4. **隔离插件不会出现在 `ServiceRegistry` 的依赖图里**，因此热重载依赖级联与它无关。

---

## M4c 追加验收：配置与状态栏项

`plugins/isolated-hello` 已经用上了这两个能力，所以上面的 F5 步骤可以直接延伸：

| # | 操作 | 期望观察 |
| --- | --- | --- |
| 1 | 打开 **设置**（JSON 模式），加入 `"isolated-hello.greeting": "你好呀"` | VSCode 会提示"未知的配置设置"——这是正常的，插件的配置键由宿主扩展贡献，而宿主无法代插件声明。值仍然能被读到 |
| 2 | 运行 `isolated-hello.greet` | 弹出 **「来自隔离子进程：你好呀」**（读的是你们刚设的值） |
| 3 | 把设置改成 `"你好呀 v2"`，**不要**重载插件 | 等约 1 秒后再运行 `isolated-hello.greet` | 
| 4 | 期望 | 弹出 **v2 的值** —— 说明配置变化是宿主**推送**到子进程的，而不是激活时的死快照 |
| 5 | 看状态栏右下角 | 有一个 `$(shield) isolated` 项，鼠标悬停显示 tooltip，点击会执行 `isolated-hello.greet` |
| 6 | `VSCordis: 卸载插件…` → `isolated-hello` | 状态栏项**立刻消失**（卸载时宿主侧 UI 被回收，不留僵尸） |
| 7 | 输出通道 `Isolated Hello` | 激活时打印了工作区数量与当时的 `greeting` 值 |

想验证"未支持的属性会响亮失败"，可以把 `plugins/isolated-hello/src/index.ts` 里加一行
`status.backgroundColor = 'red'`：热重载后插件会进入 `failed`，
错误信息会列出**真正支持的属性集合** —— 而不是静默无效。

---

## M4c 追加验收：`ctx.async` 事件订阅

`plugins/isolated-hello` 已经用上了（它每次收到保存事件都会往 `Isolated Hello` 输出通道写一行）。

| # | 操作 | 期望观察 |
| --- | --- | --- |
| 1 | 确认 `isolated-hello` 是 `active` | 状态面板里应有它 |
| 2 | 随便改一个文件并**保存**（Ctrl+S） | `Isolated Hello` 输出通道里出现 `保存：<路径>（N 行，M 字符）` |
| 3 | 在一个大文件里保存 | **通道里只有一条摘要，没有整篇正文** —— 正文是插件按需用句柄取的，不随事件传输 |
| 4 | 连续保存 70+ 次，然后让插件读第 1 次的正文 | 会得到明确的"**句柄已过期**"错误（宿主只为每个插件保留最近 64 个句柄，避免把文档一直钉在内存里） |
| 5 | `VSCordis: 卸载插件…` → `isolated-hello`，然后再保存文件 | 输出通道**不再**出现新的保存行 —— 说明宿主侧订阅随卸载被释放了 |
| 6 | 切换活动编辑器（点另一个文件） | 输出通道出现 `当前文件：<路径>（<语言>）` —— 这是 `ctx.async.onDidChangeActiveTextEditor`（ADR-0018 扩展） |
| 7 | 关闭所有编辑器 | 输出通道出现 `活动编辑器：<无>` —— "没有活动编辑器"是事件的信息本身，必须原样传达，而不是静默跳过 |
| 8 | 卸载 `isolated-hello`，再切换编辑器 | 不再出现新的 `当前文件` 行（活动编辑器订阅与保存订阅共用同一套双向清理） |

想确认"同步入口确实不可用"，可以在插件的 `activate` 里加一行
`ctx.vscode.workspace.onDidSaveTextDocument(() => {})`：插件会进入 `failed`，
而错误信息会**直接告诉你改用 `ctx.async.onDidSaveTextDocument`**。这是刻意的：
只告诉用户"不行"而不告诉"那该怎么办"是半个答案。
活动编辑器的同步入口（`ctx.vscode.window.onDidChangeActiveTextEditor`）同理，
错误信息会指向 `ctx.async.onDidChangeActiveTextEditor`。
