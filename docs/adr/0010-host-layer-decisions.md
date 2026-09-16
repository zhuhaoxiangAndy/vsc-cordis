# ADR-0010：宿主层补充决策（Web 入口格式、inject 合并、桥接层自动登记语义）

状态：已接受（2026-02-14，M1/M2 实施轮）｜决策者：无人值守自主决策

本 ADR 记录实现阶段才浮现、且无法从先前 ADR 推出的三个决策，并修正 ADR-0006 的一处空白。

## 决策 1：Web 入口用 **ESM**（补充 ADR-0006）

`package.json` 的 `browser` 指向 `dist/web/extension.js`，由 esbuild 以
`platform: 'browser', format: 'esm'` 产出。

理由：官方文档明确 Web 扩展宿主里 `require` 不可用（ADR-0006 证据），
因此 CJS 产物在 Web Worker 中会直接崩。副作用是这道构建本身成了护栏：
`platform: 'browser'` 下一旦误引入 Node 内建模块，**构建立即失败**，
从而把"kernel 零 Node 依赖"从纪律变成可机器验证的不变式。

**诚实声明**：本轮只验证了"能构建出不含 Node 内建的 ESM 产物"，**没有**在浏览器里实测。
要拿到运行期结论，需要 Web 扩展宿主 e2e —— 不在本轮范围（用户选择不跑 e2e）。
在 `docs/acceptance-m1-m2.md` 里已列为未覆盖项。

## 决策 2：`CordisPlugin.inject` 必须真正参与依赖解析

原本 `plugin.json#dependencies` 是唯一权威声明，SDK 里的 `inject` 字段只是个装饰 ——
这是个**陷阱**：插件作者写下的声明不会生效，且不会有任何报错。

现在两者合并：

```
declared = { ...manifest.dependencies }
for name of plugin.inject: declared[name] ??= '*'   // 范围缺省为 *
```

代价与取舍：

- 读 `inject` 需要**先加载模块**（`inject` 是运行期导出的属性）。因此激活流程变为：
  1. 先用清单做一次**便宜的预检**（缺依赖就直接 parked，连模块都不加载）；
  2. 加载模块后合并 `inject` 再判定一次，若仍缺依赖则**释放模块**并 parked。
- 副作用：第 2 种情况下插件的**模块级代码已经被求值过**。这是 `inject` 语义的固有代价，
  因此 `plugin.json#dependencies` 仍然是**推荐**的权威声明方式（它能在模块求值前拦下）。

## 决策 3：桥接层"自动登记"的语义边界

`VscodeBridge.createApi` 对每个 `register*` / `create*` 的返回值都做两件事：
登记到调用者的 EffectStack，并把该对象的 `dispose` 替换为**同一条幂等路径**。

- 为什么必须替换 `dispose`：否则"插件自己提前 dispose"与"宿主卸载时再 dispose"会走到两条路，
  造成二次 dispose（VSCode 的 Disposable 在实践中幂等，但不是契约保证）。
- 因此产生了新要求：**插件即使完全不用 `ctx.effect` 也不会泄漏**（有专门的测试
  `桥接层安全网：插件漏写 ctx.effect 也不会泄漏`）。
- 边界：这只对**经桥接层**产生的副作用成立。插件若绕开 `ctx.vscode` 直接拿到 vscode
  （ADR-0003 已证明同进程下可行），安全网失效。这也是 `trust: trusted` 只能"防误用"的又一例证。

## 决策 4：权限校验放在**调用时刻**，而不是创建代理时

`allow()` 在每个包装函数被调用时执行，于是：

- `workspace.getConfiguration()` 在缺少 `config.write` 时返回**只读视图**（`update()` 抛错），
  否则 `config.read` 权限会等价于 `config.write`；
- `commands.executeCommand()` 在只有 `commands.execute` 时**只允许执行已注册的 vscordis 插件命令**，
  执行 VSCode 内建命令需要显式的 `vscode:commands.execute.any`；
- 每次拒绝都抛 `PermissionDeniedError`（fail loud，ADR-0005）。

这三条把"权限白名单"从文档承诺变成了可测试的运行时行为（`FakeVscodePort` 单测覆盖）。
