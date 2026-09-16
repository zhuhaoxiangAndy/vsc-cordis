# ADR-0019：跨进程服务 —— 远程标记、方法表、以及"同步入口必须拒绝"

状态：已接受（2026-02-14）｜决策者：无人值守自主决策

## 背景

这是 M4c 的最后一项。ADR-0016 曾判定"服务不能跨进程"，理由是**类型契约会撒谎**：
`ctx.use('clock')` 的类型是同步的（`clock.now()` 返回 `Date`），
而跨进程代理只能让每个方法返回 `Promise`。
ADR-0018 给出了解法（`ctx.async` 显式异步面），本 ADR 把它用在服务上。

## 决策 1：能力矩阵 —— 四条规则，没有第五条

| 提供者 | 消费者 | 入口 | 说明 |
| --- | --- | --- | --- |
| 同进程 | 同进程 | `ctx.use(name)` | 现状不变：同步、活对象 |
| 同进程 | 隔离 | **明确拒绝** | 活对象过不了进程边界；错误信息给出两个出路（把提供者也改成隔离 / 消费者改 `trusted`） |
| 隔离 | 同进程 | `ctx.async.useService(name)` | 异步代理 |
| 隔离 | 隔离 | `ctx.async.useService(name)` | 异步代理，调用经宿主中转（消费者子进程 → 宿主 → 提供者子进程） |

关键是**不提供第五条**：不存在"用 `ctx.use` 拿到一个方法变成 Promise 的代理"这条路。
那正是 ADR-0016 拒绝过的形态。

## 决策 2：远程服务以 `remote: true` 注册进**宿主的**注册表

隔离插件调用 `ctx.provide('clock', obj)` 时，宿主在注册表里放的不是 `obj`，
而是一个**宿主侧的异步代理**（方法调用 → 到提供者子进程的 RPC），并标记 `remote: true`。

这一步让**依赖协调对远程服务一样有效**：级联暂停、`paused` 恢复、依赖图快照、
`vscordis tree` 的服务视图 —— 全部不需要为"远程"写第二套逻辑。
测试专门断言 `snapshot().services[].provider.remote === true`。

## 决策 3：同步解析**必须拒绝**，包括 `tryResolve`

- `resolve()` / `tryResolve()` 遇到 `remote: true` 抛 `RemoteServiceError`，
  错误信息里写明替代路径（`ctx.async.useService`）。
- `tryResolve` 也拒绝是刻意的：返回 `undefined` 会让插件把"存在但只能异步取用"
  误判成"软依赖缺失"，然后静默走另一条分支 —— 那是比抛错更糟的失败方式。
- 新增 `resolveForAsync()`（只给 `ctx.async.useService` 用）与 `providerInfo()`（只给路由用）。
  **不提供"顺手拿到实例"的通用入口**：让调用方必须明确选择同步还是异步。

## 决策 4：方法表就是那份"IDL-lite"

提供者在 `services.provide` 时上报方法名（`listMethods` 走原型链收集函数属性）。
消费者的代理**只暴露这些名字**，对未知属性立刻抛错：

```
远程服务 "clock" 没有方法 "nwo"。提供者声明的方法：now
```

没有方法表的话，代理只能对任何属性都返回一个函数 ——
于是 `clock.nwo()` 这种打字错误会变成一个"调用不存在的方法"的跨进程往返，
错误信息也会晚得多、模糊得多。这不是完整的 IDL（没有参数/返回类型），
但用极小的成本买到了"错误在源头暴露"。

## 决策 5：方法调用走反向请求（与命令 handler 同一思路）

函数传不过 IPC，所以"调用一个方法"必须变成"请对方在自己的进程里执行并回传结果"：

```
消费方子进程 --services.invoke--> 宿主 --invokeService--> 提供方子进程
消费方子进程 <-serviceResult---- 宿主 <--serviceResult--- 提供方子进程
```

提供者退出时，**在途调用必须被拒绝**（`#failAll` 一并清空 `#serviceInvokes`）——
否则消费者会永远等一个已经死掉的进程。

## 决策 6：依赖边登记在宿主的注册表与宿主的 EffectStack 上

隔离消费者的 `ctx.async.useService` 会在**宿主侧**登记一条硬依赖边，
并挂到宿主的 EffectStack 上（`IsolatedSession.attachHostEffects`）。
于是"提供者卸载 → 消费者 paused → 提供者回来 → 消费者恢复"这套级联对隔离插件同样成立。

`attachHostEffects` 必须在 `session.start()` **之前**调用：子进程在 `activate` 期间
就可能发起 `services.use`，那时宿主的上下文必须已经就位。

## 本轮踩到的三个坑（都留了回归测试）

### 1. 一个**假绿测试**：`#exited` 的初始化时机

`IsolatedSession.#exited` 原本初始化为 `Promise.resolve()`，在 `start()` 里才被替换成真正的退出信号。
而 loader 在 `start()` **之前**就调用 `waitForExit()` 来登记会话 —— 于是 `.then` 立刻执行，
会话被从活跃表里删掉。

后果：M4b 那条"20 轮起停子进程后 `activeSessions === 0`"的浸泡断言**一直是假绿** ——
它测的不是"没有泄漏"，而是"记账根本没生效"。修法是把 `#exited` 改成字段初始化时就存在的 deferred。

**教训**：一个"永远返回 0"的断言看起来最安全，实际最危险。

### 2. `#missingDependencies` 只看清单声明 → 未声明的动态依赖被误恢复

依赖边会随 EffectStack 一起被回收，所以"暂停之后"再问注册表是问不到的。
若恢复判定只看 `plugin.json#dependencies`，一个"用了服务但没声明"的插件会被判定成
"没有缺失依赖"，于是在提供者仍然缺席时被尝试激活 → `failed`（本该停在 `paused`）。

修法：**暂停时快照运行期依赖边**（`PluginRecord.usedDependencies`），恢复判定取两者之并。
这与 `provides` 的处理一致：清单是声明，运行期事实是权威。

### 3. `await proxy` 会探测 `.then`

代理对方法表外的属性抛错，而 `await` 恰好会读 `.then` 判断它是不是 thenable ——
于是 `await ctx.async.useService('clock')` 直接炸在 `get("then")` 上（"没有方法 then"）。
三处代理（子进程侧、宿主侧、同进程的 `wrapAsyncService`）都要特判 `then` 并放行成 `undefined`。

## 未覆盖

1. **参数与返回值必须能被 structured clone**。不可克隆的值（函数、类实例、`Symbol` 等）
   会在 IPC 层抛错，而不是在调用点给出友好提示 —— 没有做前置校验。
2. **没有版本协商**：`services.use` 不校验消费者在清单里声明的版本范围。
   版本检查仍停留在"宿主能不能解析到"这一层。
3. **远程路径上的多提供者语义未验证**：`last-wins` 在隔离提供者之间是否按预期工作没有测试。
4. **在途调用被拒绝后不自动重试**：消费者需要自己处理（这也是刻意的 ——
   静默重试会让"提供者换了人"变成难以观察的行为）。
5. 隔离插件之间**不能互相 `ctx.use`**（只能用 `ctx.async.useService`），
   所以"服务是活对象"这条契约在跨进程时彻底不适用 —— 这是设计，不是缺口。
