# 手动验收脚本（M1 / M2）

自动化测试覆盖了 kernel 与加载器；桥接层的**逻辑**（权限门、命令表记账、副作用回收、
只读配置视图、事件订阅）已由 `packages/host/test/bridge.spec.ts` 用 `vscode` stub 做契约测试，
但**真实宿主里的行为**（尤其是 `--permission` 是否可用）仍需要真实的 `vscode` 模块 ——
只能靠下面的手动步骤覆盖。本项目按用户决策不跑 `@vscode/test-electron` e2e。

## 准备

```bash
npm install      # 或 pnpm install
npm test         # 58 项自动化测试
npm run build    # 构建 3 个插件 + Node 宿主 + Web 宿主
node scripts/smoke-built-plugins.mjs   # 产物契约冒烟
```

然后在 VSCode 中打开本仓库，按 **F5**（配置名：`运行 vscordis 扩展（M1/M2 手动验收）`）。
`.vscode/settings.json` 已经把 `vscordis.pluginRoots` 指向 `${workspaceFolder}/plugins`。

先按 `Ctrl+Shift+P` → `VSCordis: 显示运行时状态`，应该看到 3 个插件全部 `active`：
`hello`、`provider-clock`、`consumer-greeting`，且服务表里有 `clock ← provider-clock@1.0.0#1`。

---

## M1 验收：卸载后命令消失、无残留

| 步骤 | 操作 | 期望观察 |
| --- | --- | --- |
| 1 | `Ctrl+Shift+P` → `VSCordis: 运行插件命令…` | 列表含 `clock.label`、`greeting.time`、`hello.echo`、`hello.greet` |
| 2 | 选 `hello.greet` | 右下角弹出 `Hello, VSCordis！来自插件 hello` |
| 3 | `Ctrl+Shift+P` → `VSCordis: 卸载插件…` → 选 `hello` | 提示"已卸载 hello"；输出通道出现 `hello 正在卸载：3 项副作用即将被 LIFO 逆序回收` |
| 4 | 再次 `VSCordis: 运行插件命令…` | **`hello.greet` / `hello.echo` 已从列表消失** |
| 5 | `VSCordis: 显示运行时状态` | `hello` 不在插件表中；`VSCordis Hello` 输出通道已关闭 |

**关键点（ADR-0002）**：VSCode 的**命令面板**里查不到 `hello.greet` —— 它本来就从来不在那里
（命令面板条目来自静态 `contributes.commands`）。真正反映运行期注册表的是上面第 4 步的 QuickPick 代理，
以及 `vscode.commands.getCommands(true)`。

在开发宿主里可以验证后者：`Ctrl+Shift+P` → `Developer: Run Command…` 不存在，改用
`F1` → 输入 `developer: reload window` 前，可先在**扩展开发宿主**的 DevTools（`帮助 > 切换开发人员工具`）
里执行 `await vscode.commands.getCommands(true)`——卸载后不应再包含 `hello.*`。

---

## M2 验收：依赖变化时消费者自动协调

| 步骤 | 操作 | 期望观察 |
| --- | --- | --- |
| 1 | 状态面板确认 `provider-clock` 与 `consumer-greeting` 都 active | 服务表：`clock ← provider-clock@1.0.0`，消费者 `consumer-greeting(hard)` |
| 2 | 运行 `greeting.time` | 弹出 `[clock#1] 12:34:56` |
| 3 | `VSCordis: 卸载插件…` → 选 **`provider-clock`** | 提示里应包含"**1 个插件因依赖缺失而 paused: consumer-greeting**" |
| 4 | 运行 `VSCordis: 运行插件命令…` | **`clock.label` 与 `greeting.time` 都消失了** |
| 5 | 状态面板 | `consumer-greeting` 是 `paused`，`等待依赖：clock` |
| 6 | `VSCordis: 加载插件…` → 选 `provider-clock` | 提示 `paused` 数归零 |
| 7 | 运行 `greeting.time` | 弹出 **`[clock#2]`** —— 证明消费者拿到的是**新实例**，不是过期引用 |
| 8 | 状态面板 | 两者都回到 `active` |

第 7 步的 `#2` 是这条验算的核心：`provider-clock` 的模块级 `generation` 计数器
只有在 `require.cache` 被正确清空后才会递增。若显示 `#1`，说明模块缓存没清干净。

### 传递闭包

再加一个中间层即可验证 A→B→C 级联（无需改代码）：临时让 `consumer-greeting` 也提供某个服务，
再写第三个插件消费它。kernel 侧的传递闭包已由单测
`plugin-host.spec.ts › M2：传递闭包 A→B→C 级联暂停、级联恢复（无一行特判代码）` 覆盖。

---

## M1/M2 未覆盖、留待后续里程碑的部分

| 项 | 里程碑 | 说明 |
| --- | --- | --- |
| 文件监听自动热重载（<1s） | M3 | 当前 `reload` 是手动命令；`NodeModuleLoader` 已具备"重载拿到新模块"的能力（有单测） |
| 子进程隔离后端 | M4 | `trust: untrusted` 的插件**现在会被拒绝加载**（fail-closed，ADR-0003） |
| 签名与哈希校验 | M4 | `plugin.json` 的 `integrity` / `signature` 字段尚未读取；密钥脚本见 ADR-0008 |
| 首次安装的权限确认 UI | M4 | 当前权限来自清单，越权调用抛 `PermissionDeniedError` |
| Web 宿主运行期验证 | — | 只验证了"能构建成不依赖 Node 内建的 ESM"；浏览器端未实测（ADR-0006） |
| CLI（创建插件/依赖图可视化） | M5 | `vscordis showStatus` 已能打印依赖图文本，CLI 尚未开工 |
