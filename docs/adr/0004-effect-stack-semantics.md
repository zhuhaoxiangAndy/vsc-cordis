# ADR-0004：EffectStack 语义（时间可组合性内核）

状态：已接受（2026-02-14）

## 背景（一手证据：cordis v4.0.0-rc.10）

- `fiber.ts#L50`：`Disposable<T> = () => T`（cordis 用"返回函数"表示可逆副作用）；
- `fiber.ts#L242-243`：运行时容忍 effect 不返回 disposer（类型上要求）；
- `fiber.ts#L283`：**单个 effect 内部**的多个 disposer 逆序串行执行；
- `fiber.ts#L439-455` + `utils.ts#L26-30`：**fiber 顶层**的多个 disposer 是"逆序启动 + `Promise.all` 并发"；
- `reflect.ts#L190`：同一 isolate 内同名重复 `provide` 直接抛错。

## 决策

本项目采用**比 cordis 更严格**的语义，四条不变式：

| 编号 | 不变式 | 理由 |
| --- | --- | --- |
| I1 | **注册即入栈**：`open` 状态下登记的资源最终必被回收 | 可逆副作用的完备性 |
| I2 | **严格 LIFO + 串行 `await`**：一个 teardown 完全结束后才开始下一个 | 与 cordis 的 `Promise.all` 分歧：并发回收会让"先释放 A 再释放依赖 A 的 B"退化为竞态，VSCode 侧表现为偶发"命令已销毁但监听器仍在" |
| I3 | **失败隔离**：单个 teardown 抛错或超时（默认 5s）不阻断其余回收，错误经 `onError` 汇总 | 一次失败不应导致后续资源全部泄漏 |
| I4 | **闭栈后登记立即回收**：`dispose()` 之后 `add()` 的 teardown 会被立即执行 | 卸载与注册的竞态；闭包里的 `setInterval` 是最常见逃逸源 |

补充约束：

- `effect(register, dispose)` 的 **`register` 必须是同步函数**。理由：若 `register` 异步，
  "拿到资源句柄"与"登记逆操作"之间存在 `await` 窗口，此时发起卸载 → 资源逃逸。
  需要异步建资源时用 `effectAsync`：它先 `await` 再 `add`，
  而 I4 保证"await 期间已卸载"这一竞态下资源被立即回收。
- teardown **必须幂等安全**：插件可以自己提前 `dispose()` 返回的 Disposable，
  栈稍后仍会再调用一次；宿主对 VSCode 返回的 Disposable 一律加幂等掩码。
- `scope()` 创建子栈并作为一项 effect 登记在父栈上 → 父子清理天然满足逆序。

## 后果

- 卸载是**确定性的、可断言的**：只要 `stack.size === 0` 且注册表边为 0，就可以宣称无残留。
- 代价：串行 `await` 比并发慢。实测影响在毫秒级，换取可证明性值得。
- 与 cordis 的语义分歧写入本文，避免后来者误以为是实现疏漏。
