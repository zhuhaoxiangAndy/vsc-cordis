# 手动验收：M3 热重载

自动化测试覆盖了 `planReload` 的全部边界与一次真实 `fs.watch` 往返，
但**真实 VSCode 里的端到端时延**必须手动测（用户决策不跑 e2e）。

## 准备

1. 终端 A：`npm run watch`（esbuild 监听插件源码 → 增量重建 `dist/index.cjs`）
2. 终端 B 或直接在本仓库的 VSCode 里按 **F5**（会先自动 `npm run build` 一次）
3. 输出面板选择 **VSCordis**

## 验收步骤

| 步骤 | 操作 | 期望观察 |
| --- | --- | --- |
| 1 | 开发宿主里 `Ctrl+Shift+P` → `VSCordis: 运行插件命令…` → `hello.greet` | 弹出 `Hello, VSCordis！来自插件 hello` |
| 2 | 编辑 `plugins/hello/src/index.ts`，把文案改成 `Hi from v2` 并保存 | 终端 A 出现一次增量重建 |
| 3 | 看开发宿主的 **VSCordis** 输出通道 | `[热重载] hello → active` 与 `[热重载] 本次耗时 Nms（重载 1 个，卸载 0 个）` |
| 4 | 再次运行 `hello.greet` | 弹出 **Hi from v2**（不再需要重载窗口） |
| 5 | `VSCordis: 显示运行时状态` | 出现一行 `热重载：开启（监听 N 个插件根） · 上次重载 Nms @ <时间>` |

### 时延预算（用来判断慢在哪一环）

| 环节 | 预算 |
| --- | --- |
| esbuild 增量重建 | 50–150 ms |
| 防抖窗口（`vscordis.hotReloadDebounceMs`，默认 150） | 150 ms |
| unload → require → activate | 10–50 ms |
| **合计** | **≈ 220–350 ms** |

如果实测超过 1 秒：先看输出通道里的 `[热重载] 本次耗时`。
- 该值很小但整体很慢 → 慢在 esbuild（终端 A）或防抖窗口；
- 该值很大 → 慢在宿主侧，检查插件 `deactivate` 是否阻塞（有 2s 超时保护）。

## 失败路径：热重载必须**可见**且**不回滚**

1. 在 `plugins/hello/src/index.ts` 的 `activate` 里插入 `throw new Error('boom')`，保存。
2. 期望：
   - 输出通道：`[热重载] hello 失败：Error: boom`
   - 右下角警告：**"插件已进入 failed 状态（不会自动回滚到旧版本）"**
   - `hello.greet` / `hello.echo` 从 `运行插件命令…` 列表消失
   - 状态面板里 `hello` 是 `failed` 并显示错误文本
3. 删掉那行 `throw`，保存 → 下一次改动会重新 reload，`hello` 回到 `active`。

**为什么故意不回滚**：自动回滚需要旧版本模块与旧状态同时保活（双份加载），
这会让"卸载后无残留"这条核心不变式无法断言。见 ADR-0011 决策 5。

## 依赖级联在热重载下的表现

编辑 `plugins/provider-clock/src/index.ts`（例如改一下日志文案）并保存：

- 期望：`provider-clock` 重载 → `clock` 服务撤销 → `consumer-greeting` 自动 `paused`
  → provider 重新激活 → `consumer-greeting` 自动恢复 `active`
- 这正是 M2 的级联在热重载路径上的复用：**没有一行代码专门处理"热重载时的级联"**。

## 插件目录消失

把 `plugins/provider-clock` **移动**到仓库外（不要直接删除），然后：
- 期望输出：`[热重载] 插件目录已删除，已卸载 provider-clock`
- `consumer-greeting` 进入 `paused`（等待 `clock`）

移回来后应该会重新被发现并加载。

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 宿主自身改动不会热重载 | `packages/host/**` 改动需要重载窗口 —— VSCode 官方不支持运行期卸载扩展（ADR-0003） |
| 新建插件目录需要一次重扫 | 写入 `plugin.json` 会触发重扫；只创建一个空目录不会 |
| 首次监听需要在 `initialize()` 之后 | 监听在宿主激活完成后才挂上 |
