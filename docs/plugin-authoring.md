# 插件作者指南

> 面向写 vscordis 插件的人。设计理由见 `docs/design/overview.md` 与 `docs/adr/`。

## 1. 五分钟上手

```bash
pnpm run cli -- create my-plugin           # 生成 plugins/my-plugin/{plugin.json,package.json,src/index.ts}
pnpm install                               # 让 workspace 认识新包
pnpm run watch                             # 终端 A：增量重建
# VSCode 里按 F5 启动扩展开发宿主
```

然后在开发宿主里 `Ctrl+Shift+P` → `VSCordis: 运行插件命令…` → `my-plugin.hello`。

> 你**看不到** `my-plugin.hello` 出现在命令面板里 —— 这不是 bug。见第 6 节第 1 条。

## 2. `plugin.json` 速查

| 字段 | 必填 | 作用与陷阱 |
| --- | --- | --- |
| `id` | ✅ | 小写字母/数字/连字符，可带点分段。**唯一**，重复的会被跳过并在状态面板报问题 |
| `name` / `version` | ✅ | `version` 必须是 `x.y.z` |
| `main` | ✅ | 打包后的**单文件** CJS，相对路径，禁止 `..`。多文件插件无法保证卸载干净 |
| `trust` | ⭕ | `trusted`（默认同进程）/ `untrusted`（子进程隔离）。**默认是 `untrusted`** —— 见第 5 节 |
| `permissions` | ⭕ | 白名单，未声明 = 未授予。越权调用**抛错**（不是静默忽略） |
| `dependencies` | ⭕ | `{ 服务名: 版本范围 }`，范围只支持 `*` / `1.2.3` / `^1.2.3` / `>=1.2.3`，其它写法**加载时拒绝** |
| `provides` | ⭕ | 声明本插件会提供哪些服务。**只服务静态工具**（`vscordis tree`），不参与加载决策；声明与实际不符会**告警** |
| `configuration` | ⭕ | `{ section, keys }`。**隔离模式读配置的前提**：宿主按 `keys` 预取快照，未声明的键只能拿默认值（ADR-0016） |
| `engines` | ⭕ | `{ vscordis?, vscode? }`，范围只支持 `*` / `1.2.3` / `^1.2.3` / `>=1.2.3`。**强制检查**：不满足直接拒绝加载，且连模块都不会被求值（ADR-0017） |
| `description` | ⭕ | 仅元信息 |

## 3. `PluginContext` 速查

```ts
export default {
  name: 'my-plugin',
  inject: ['clock'],            // 静态声明硬依赖（等价于 dependencies 里写 '*'）
  activate(ctx) { /* ... */ },
  async deactivate(ctx) { /* 此时服务与命令仍存活，适合做收尾 */ },
} satisfies CordisPlugin
```

| 成员 | 用途 | 关键约束 |
| --- | --- | --- |
| `ctx.effect(register, dispose)` | **所有**副作用的登记口 | `register` 必须**同步**；`dispose` 必须**幂等**（可能被调用两次） |
| `ctx.effectAsync(register, dispose)` | 异步建资源 | await 期间若已卸载，资源会被立即回收（不会泄漏） |
| `ctx.scope(label)` | 派生子上下文 | 子上下文可单独回收；父卸载时一并回收 |
| `ctx.use(name)` | 硬依赖：缺失即抛错 | 会登记依赖边：提供者消失 → 本插件 `paused` |
| `ctx.tryUse(name)` | 软依赖：缺失返回 `undefined` | **不级联**（可选增强用它，别用 `use` 兜底） |
| `ctx.provide(name, value, { version })` | 提供服务 | 返回 `Disposable`；默认 `exclusive`，同名第二个提供者抛错 |
| `ctx.signal` | 卸载信号 | **长任务必须监听它**：宿主只能发信号，无法强制中断你的 Promise |
| `ctx.vscode` | 受控 VSCode API | 见第 4 节；**不是**完整的 `vscode` |
| `ctx.log` | 带插件 id 前缀的日志 | 会进 `VSCordis` 输出通道 |

## 4. 权限速查

| 权限 | 允许什么 |
| --- | --- |
| `vscode:commands.register` | 注册命令 |
| `vscode:commands.execute` | 执行命令，但**仅限**已注册的 vscordis 插件命令 |
| `vscode:commands.execute.any` | 执行任意命令（含 VSCode 内建）。高危，谨慎申请 |
| `vscode:window.messages` | 弹信息/警告/错误提示 |
| `vscode:window.statusbar` | 创建状态栏项 |
| `vscode:window.output` | 创建输出通道 |
| `vscode:workspace.read` | 读工作区结构、订阅保存事件 |
| `vscode:workspace.config.read` / `.write` | 读写配置（只给 `read` 时返回的是**只读视图**，`update()` 抛错） |
| `net` / `fs:read` / `fs:write` / `process:spawn` | 非 VSCode 能力。**只有隔离模式才有强制力**，见第 5 节 |

越权调用抛 `PermissionDeniedError`，会让你的 `activate()` 失败、插件进入 `failed`。
这是刻意的：静默忽略会变成"插件看起来激活成功但功能是死的"。

## 5. 两种模式的差异（**先读这段再决定 `trust`**）

| | `trusted` | `untrusted` |
| --- | --- | --- |
| 运行位置 | 扩展宿主进程内 | 独立子进程 |
| 安全边界 | **无**（只防误用：你仍能绕过受控 API，见 ADR-0003） | 真边界：无 `vscode`、fs 受 Node 权限模型限制 |
| 性能 | 直接调用 | 每次 API 调用都是一次 IPC 往返 |
| 服务（`ctx.use` / `provide`） | ✅ | ❌ 抛错（服务是**带方法的进程内对象**，代理会让 `now()` 从 `Date` 变成 `Promise<Date>`） |
| `getConfiguration` | ✅ | ✅ **按声明预取**：在 `plugin.json` 里写 `configuration`，宿主预取并在配置变化时推送 |
| `createStatusBarItem` | ✅ | ✅ 本地镜像 + 串行 RPC（读属性是同步的；未支持的属性会**响亮抛错**） |
| `onDidSaveTextDocument` | ✅ | ❌ 抛错（回调参数 `TextDocument` 带同步方法，跨进程只能给纯数据 —— 类型契约会撒谎） |
| 命令 handler | 同步/异步都可以 | 宿主会**反向调用**你的 handler 并把结果回传 |
| 适合 | 自研、团队内部、需要服务协作的插件 | 第三方、需要真隔离的插件 |

**同一份插件代码在两种模式下写法一致**，差异只在运行时的能力边界上。
两个 ❌ 是**设计边界而非待办**：要支持它们，就得给隔离模式一套独立的、显式异步的 API 面，
那会让"同一份代码两边一样"这个前提失效。理由见 ADR-0016。

### 隔离模式读配置：必须声明

```jsonc
// plugin.json
"configuration": { "section": "my-plugin", "keys": ["greeting", "verbose"] }
```

```ts
// 插件里：同步读，和同进程模式写法完全一样
const greeting = ctx.vscode.workspace.getConfiguration('my-plugin').get('greeting', '你好')
```

- 宿主在**激活时**按 `keys` 预取，并在配置变化时**推送**更新 → 所以 `get()` 既能保持同步，也不陈旧。
- **未声明的键只能拿到默认值**，并会在宿主的输出通道里告警一次。
- ⚠️ 配置的 `section` 由你决定，但**宿主扩展的 `contributes.configuration` 才是设置 UI 的来源** ——
  插件无法贡献设置项，所以你的配置键目前只能手写进 `settings.json`
  （VSCode 会提示"未知配置设置"，但值能正常读到）。要让它出现在设置 UI 里需要宿主代插件声明，暂未实现。

### 隔离模式写状态栏项

```ts
const item = ctx.vscode.window.createStatusBarItem(1, 100)   // 需要 vscode:window.statusbar
item.text = '$(shield) ready'
item.command = 'my-plugin.run'
item.show()
ctx.effect(() => item, (i) => i.dispose(), 'status:my-plugin')
```

支持 `text / tooltip / command / color / name / accessibilityInformation` 与 `show / hide / dispose`；
`alignment` / `priority` 只在创建时生效。**设置其它属性会抛错**（而不是静默无效）。
若你的插件用到了上表里标 ❌ 的能力，选 `trusted`（并接受"只防误用"这个事实），
或者等对应的隔离能力补齐（见 ADR-0013 的 M4c 清单）。

> 默认值是 `untrusted`。**如果扩展宿主没有隔离后端，`untrusted` 插件会被直接拒绝加载**
> （fail-closed），状态面板会明确告诉你原因。开发期请在 `plugin.json` 里写 `"trust": "trusted"`。

## 6. 会静默失败的写法（最值得记住的一节）

1. **以为命令会出现在命令面板**。命令面板的条目来自静态 `contributes.commands`，
   而 `contributes` 是**宿主扩展**的清单 —— 插件运行期注册的命令从来不进面板。
   走 `VSCordis: 运行插件命令…`，或让用户给宿主提需求。
2. **`dispose` 不幂等**。你的 `effect` teardown 可能被调用两次（你自己提前 `dispose` + 宿主卸载）。
   写 `if (done) return; done = true`。
3. **在 `activate` 里起长任务却不监听 `ctx.signal`**。宿主无法强制中断你的 Promise；
   超时只是"不再等你"，你的任务会继续跑到自生自灭 —— 那通常表现为"卸载后还有残留行为"。
4. **依赖了一个没人提供的服务**。你的插件会被静默 `paused`（不是 failed），
   命令随之从列表里消失。状态面板会显示 `等待依赖：xxx`。这是设计行为，不是故障。
5. **`provides` 声明与实际不符**。`vscordis tree` 画的是声明值，宿主会在激活后比对并告警。
   声明了却不提供会让依赖图骗人。
6. **模块级副作用**。插件被打成单文件 CJS，每次（重新）加载都会重新求值模块顶层代码。
   初始化逻辑写进 `activate()`，不要写在顶层。
7. **在隔离模式里用 `import * as vscode from 'vscode'`**。构建期会直接报错 ——
   请用 `ctx.vscode`。这是有意为之：受控 API 是唯一通路。

## 7. 调试手册

| 现象 | 先看什么 |
| --- | --- |
| 插件没被加载 | `VSCordis: 显示运行时状态` 的"发现的问题"列表（清单非法、id 重复、路径越界都会在这里） |
| 加载后立刻 `failed` | 输出通道里的 `插件 X 加载失败：...`；常见是权限不足、`activate` 抛错、`activate` 超时 |
| 插件是 `paused` | 状态面板会显示"等待依赖：xxx"；用 `pnpm run tree` 看谁该提供它 |
| 命令不在列表里 | 插件不是 `active`（`paused`/`failed` 时它的命令会被撤销） |
| 改了代码没生效 | 终端 A 的 `pnpm run watch` 在跑吗？输出通道里有没有 `[热重载] ...` 与耗时 |
| 热重载失败 | 输出通道会明确写失败原因，并提示**不会回滚到旧版本**（这是刻意设计，见 ADR-0011） |
| 想确认依赖关系 | `pnpm run cli -- tree`（文本）或 `--mermaid`（贴进 Markdown） |

## 8. 签名与发布

```bash
pnpm run cli -- sign plugins/my-plugin --verify
```

- 开发期（插件放在工作区目录）**不要求**签名；装入 `globalStorage` 的插件**必须**签名 + 哈希。
- 签名覆盖**整个 `plugin.json` 的规范化 JSON**：改任何字段（包括描述）都要重新签名。
- 该命令会重写 `plugin.json`（统一缩进），这是为了"清单字节级可复现"。
- 详细流程与错误对照表见 `docs/signing.md`。

## 9. 提交前自检

```bash
pnpm run cli -- list --root plugins     # 退出码 1 = 有问题（坏清单 / 缺提供者 / 依赖环）
pnpm run cli -- tree --root plugins     # 依赖图是否如你所愿
pnpm test                               # 全套 135 项
```
