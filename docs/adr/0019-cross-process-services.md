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

## 后续轮次补齐（把"未覆盖"变成有测试的决策）

### 决策 7：版本范围在**取用点**也强制（`ServiceRegistry.assertSatisfies`）

1. `tryResolve(name, range?)` 开始接受范围：**版本不符抛 `ServiceVersionMismatchError`，不是返回 undefined**，
   `ctx.tryUse` 会把 `plugin.json#dependencies` 里的范围传下去。理由与决策 3 同源：
   把"存在但版本不符"当成"软依赖不存在"，是比抛错更糟的静默失败。
2. 隔离消费者的 `services.use` 在宿主侧复查范围。范围取自**宿主**持有的 `plugin.json#dependencies`
   （子进程里的 manifest 是 stub：`version: '0.0.0'`、没有 dependencies —— 不可信也不完整），
   并登记到依赖边上（`depend(..., range)`），于是注册表快照 / `vscordis tree` 能看到声明的范围。
3. **诚实说明**：加载前的依赖预检（`canResolve(name, range)`）其实已经拦住了"范围不满足还去启动"
   的常见情况（测试：声明 `^2.0.0` 的隔离消费者停在 `paused`，连子进程都不起）。
   所以这一条的真实价值是**取用点的防御性复查 + 补齐软依赖（`tryResolve`）这条洞**，
   而不是修一个必现 bug —— 但"能不能解析到"与"拿到手的提供者满足契约"本就该各查一次。
4. 版本不符的错误信息给出两条出路（换提供者版本 / 放宽声明范围），由测试断言存在。

### 决策 8：冲突策略必须跨进程传过去（否则 `last-wins` 被静默降级）

隔离模式下 `ctx.provide(name, obj, { conflict: 'last-wins' })` 原本**丢掉了 conflict 字段** ——
子进程只发 `[name, version, methods]`，宿主按默认 `exclusive` 注册。这正是 ADR-0017 命名的
"声明了却不生效"。现在：

- `services.provide` 带第 4 个参数（`'exclusive' | 'last-wins'`）；
- 未知值 **fail-closed**：宿主消息处理与 `ServiceRegistry.provide` 都抛错，而不是静默当 exclusive；
- 测试：两个隔离提供者，后者显式 last-wins 接管，消费者被级联重启后拿到新提供者；
  第三个提供者（缺省策略）仍然响亮失败（`ServiceConflictError`）。
- 已知语义（与同进程一致，刻意不特殊化）：**接管者卸载后服务消失，被替换者不会自动复位**。
  自动复位需要"被替换者继续保活并有恢复顺序"，那会把 last-wins 变成难以推理的栈 —— 不做。

### 决策 9：`remote` 标记不可由插件设置（同进程与隔离两处都响亮拒绝）

`ProvideOptions.remote` 是**运行时标注**（隔离 loader 在宿主侧注册时写入）。
若允许插件自设，一个同进程服务会变成"同步消费者被拒绝"的假远程服务 —— 又一个类型谎言。
`kernel/context.ts` 与 `child-bootstrap.ts` 的 `ctx.provide` 都拒绝，并各有测试断言：
失败后插件是 `failed`、注册表里不留服务槽位。

### 决策 10：子进程**异常退出**时，在途调用必须被拒绝

`#failAll` 原来只在 `kill()` 与 `'error'` 里调用。子进程被 `process.exit()` 或外部信号带走时走
`'exit'` 处理器，不经过 `kill()` —— 于是宿主 `#serviceInvokes` 里的 deferred 永远不 settle，
消费者会一直等一个已经死掉的进程。这是**活锁**，比报错更糟。

修法：`'exit'` 处理器先 `#failAll(...)` 再 `#cleanupHostSide()`。
回归测试刻意**绕过插件依赖边**（直接拿 `resolveForAsync` 返回的宿主侧代理再调用）：
否则提供者退出会级联暂停消费者、由"消费者会话已终止"来 reject，用例即使漏修也会通过（假绿）。
反向验证：临时移除这行 `#failAll`，用例以"在途调用必须被拒绝，而不是永远挂起"失败
（用 `Promise.race` 把"挂起"变成可判定的断言，而不是让整轮测试超时）。

### 决策 11：参数与返回值在**调用点**做 structured clone 前置校验

IPC 用 `serialization: 'advanced'`（structured clone），所以：

- 函数/`Symbol`/`Promise`/`WeakMap` 这类值会在传输层抛 `DataCloneError` —— 错误里**没有**"哪个方法、第几个参数、哪条路径"；
- 类实例更糟：它**不报错**，但跨进程后原型与方法被静默丢掉（正是本项目拒绝的"看起来能过、实际丢东西"）。

`kernel/cloneable.ts` 提供 `inspectCloneable()`（深度优先、可读路径、循环引用安全、深度上限 64、
内建类型用品牌校验防 `Symbol.toStringTag` 伪装）与统一文案 `formatCloneProblem()`。四个调用点：

1. 消费者子进程代理（`child-bootstrap.ts`）调 `assertCloneableArgs` → 参数方向；
2. 宿主侧远程代理（`isolated-loader.ts`，同进程消费者走这条）同样前置校验；
3. 提供者子进程在回传方法结果前校验 → 返回值方向；
4. `callHost` / `Session.#send` 保留 try/catch 兜底（Proxy 在纯 JS 里认不出来），
   并把"发不出去"变成一次**失败应答** —— 否则宿主 `#serviceInvokes` 会永远挂起（活锁，同决策 10）。

边界（刻意保守）：装箱原始值（`new Number(7)`）被拒绝（Node 能保留、浏览器规范可能降级为原始值），
文案引导改传原始值；symbol 键、非枚举属性、Date/RegExp/Map/Set/Error 的自定义字段属于
"静默丢弃但不报错"，不在校验面内。命令方向的同一套校验见**决策 12**。

### 决策 12：命令方向复用同一套 structured clone 前置校验

命令与服务走**同一条 IPC**，只是方向相反：参数 host→child（`invoke`）、返回值 child→host（`result`）。
本轮把 `inspectCloneable` 的口径套到命令上：

- 宿主侧 `IsolatedSession.invokeCommand` 发送前校验参数（`assertCloneableCommandArgs`）；
- 子进程侧命令 handler 的返回值在回传前校验（`describeCloneProblem`），并保留发送兜底
  （Proxy 等认不出的值也必须给出失败应答，不能让宿主永远等 `requestId`）；
- 子进程侧 `ctx.vscode.commands.executeCommand` 的参数（child→host 方向）同样校验。

文案统一为「命令 "x.y" 的第 N 个参数 / 返回值 不可 structured clone：路径 原因」。
测试覆盖两个方向：参数里带函数、返回值里带函数。

### 决策 13：远程服务代际锚定 —— 旧代理不得静默调用新提供者

**发现**：`#remoteServices` 只按**服务名**路由，且代理的调用在**调用时刻**才查表。
于是 last-wins 换人后，一个在上一代取用的代理会悄悄把调用发给新提供者 ——
调用成功、结果却来自另一个插件。对插件消费者来说，级联暂停通常会把旧代理收走；
但**非依赖系统持有的代理**（宿主内部代码、直接 `registry.resolveForAsync` 的调用方）
以及"替换事件排队期间的在途调用"不受这条保护。

**修法（两道）**：

1. 宿主侧代理在创建时锚定**代际 token**（每次 `provide` 自增），调用时比对；
   过期即抛「提供者已被替换（last-wins）…请重新 `ctx.async.useService(name)`」。
2. 隔离消费者的 RPC 也带 token：`services.use` 的应答返回 token，`services.invoke`
   的第 4 个参数把它带回来 —— 否则跨进程这条路径仍然按名字路由。
3. 顺带修一个顺序问题：`#provideRemote` 原本**先写路由表、再注册**；
   若 `registry.provide` 抛 `ServiceConflictError`（exclusive 冲突），路由表会指向一个
   从未生效的提供者。现在只有注册成功后才更新路由表。

**测试**：A 提供 → 取用旧代理 → B 显式 last-wins 接管 → 新取用拿到 B，
而**旧代理的调用必须失败**（没有修复时它会返回 B 的结果 —— 这正是要消除的静默误路由）。

### 决策 14：跨模式 last-wins 的后果（能力矩阵只说了"谁提供"，没说"换人之后"）

能力矩阵描述的是**静态可达性**；一旦允许 `last-wins` 换人，它就成了动态问题：
任何"提供者可以被替换"的组合，都必须回答"替换后消费者怎么办"。三种跨模式情形本轮都补了测试：

1. **同进程提供者 + 隔离消费者**：取用点明确拒绝（活对象过不了进程边界），错误信息给出两条出路
   （提供者改 `untrusted` / 消费者改 `trusted`）；消费者终态是 **`failed` 而不是 `paused`** ——
   `paused` 意味着"等提供者回来"，而同进程提供者永远不会变成可跨进程取用的形态，
   假装 `paused` 只会把问题藏起来。
2. **同进程提供者以 last-wins 接管远程服务**：隔离消费者被级联暂停后尝试恢复，再次撞上同一条拒绝
   → `failed`。这是 last-wins 的必然结果：**被替换的提供者不会自动复位**（与同进程 last-wins
   语义一致，见决策 8），所以消费者没有"等回去"的路径。
3. **反向接管（隔离提供者 last-wins 接管同进程提供者）**：注册表如实标记 `remote: true`，
   隔离消费者用 `ctx.async.useService` 正常取用 —— 这条是通的，因为提供者真的在子进程里。

一句话：`remote` 是**当前提供者**的属性，不是服务的属性；换人之后必须重新判断，
而判断发生在取用点 —— 这正是决策 7 那次复查值得存在的原因。

## 未覆盖

1. ~~参数与返回值必须能被 structured clone~~ → **决策 11**：调用点前置校验（服务与命令两个方向）；
   剩余边界（装箱原始值保守拒绝、symbol 键/自定义字段属"静默丢弃但不报错"不在校验面内）
   写在决策 11 里。
2. ~~没有版本协商~~ → **决策 7**：`tryResolve` 与隔离取用点都强制声明的范围（并如实记录
   加载前预检已经覆盖了常见情况）。
3. ~~远程路径上的多提供者语义未验证~~ → **决策 8**：`conflict` 跨进程传递并测试 last-wins；
   接管者卸载后不回退到被替换者（与同进程一致，有意为之）。
4. **在途调用被拒绝后不自动重试**：消费者需要自己处理（这也是刻意的 ——
   静默重试会让"提供者换了人"变成难以观察的行为）。
5. 隔离插件之间**不能互相 `ctx.use`**（只能用 `ctx.async.useService`），
   所以"服务是活对象"这条契约在跨进程时彻底不适用 —— 这是设计，不是缺口。
