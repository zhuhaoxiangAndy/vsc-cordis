import type { Disposable, Teardown } from '@vscordis/sdk'
import { withTimeout } from './timing.ts'

/**
 * EffectStack —— 「时间可组合性」的最小内核（语义见 ADR-0004）。
 *
 * 四条不变式：
 *   I1 注册即入栈：open 状态下登记的资源最终必被回收。
 *   I2 严格 LIFO + 串行 await：一个 teardown 完全结束后才开始下一个
 *      （与 cordis fiber 顶层 `Promise.all` 并发的分歧是有意为之：并发回收会让
 *       "先释放 A、再释放依赖 A 的 B" 退化成竞态）。
 *   I3 失败隔离：单个 teardown 抛错或超时（默认 5s）不阻断其余回收，错误经 `onError` 汇总。
 *   I4 闭栈后登记立即回收：卸载与注册竞态时不允许遗留逃逸资源。
 */

export interface EffectStackOptions {
  readonly label?: string
  /** 单个 teardown 的超时毫秒数；超时计为失败但继续回收。 */
  readonly disposeTimeoutMs?: number
  /**
   * 整栈回收的总预算毫秒数。`undefined` 或 `<= 0` = **不启用**（行为与从前完全一致）。
   *
   * 启用后，`dispose()` 开始时算一次 deadline；每项 teardown 执行前检查剩余预算：
   * - 剩余 `<= 0`：**跳过该项**（teardown 一个回合都不给），逐项经 `onError` 上报，
   *   并计入 `skippedByBudget`。这是刻意的取舍 —— 用"有些 effect 不再执行"换取
   *   宿主串行生命周期队列的总回收时长有界；跳过项仍被视为已回收，栈最终
   *   `closed === true` 且 `size === 0`。
   * - 剩余 `> 0`：单项超时取 `min(disposeTimeoutMs ?? 默认值, 剩余预算)`，且不小于 1ms
   *   （剩余预算只能把单项超时压小，不能放大；1ms 下界保证 `withTimeout` 仍真正生效）。
   */
  readonly disposeBudgetMs?: number
  readonly onError?: (error: unknown, label: string | undefined) => void
}

interface Entry {
  readonly id: number
  readonly label: string | undefined
  readonly teardown: Teardown
}

const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000

export class EffectStack implements Disposable {
  readonly #entries: Entry[] = []
  readonly #opts: EffectStackOptions
  #seq = 0
  #state: 'open' | 'draining' | 'closed' = 'open'
  /** 正在进行的整栈回收；并发 dispose() 必须复用同一条，而不是再起一条并发回收链。 */
  #drainPromise: Promise<void> | undefined
  #skippedByBudget = 0

  constructor(options: EffectStackOptions = {}) {
    this.#opts = options
  }

  get label(): string | undefined {
    return this.#opts.label
  }

  /** 尚未回收的副作用数量；卸载后必须回到 0（这是"无残留"的核心断言）。 */
  get size(): number {
    return this.#entries.length
  }

  get closed(): boolean {
    return this.#state === 'closed'
  }

  /** 已开始或已完成回收。 */
  get settled(): boolean {
    return this.#state !== 'open'
  }

  /**
   * 累计因整栈回收预算耗尽而被跳过的 teardown 数量（只读诊断计数）。
   * 用途：测试断言 + 宿主状态面板；预算未启用时恒为 0。
   */
  get skippedByBudget(): number {
    return this.#skippedByBudget
  }

  /**
   * 登记一项逆操作。
   * - 已闭栈（I4）：立即执行，返回的 Disposable 是空操作。
   * - 返回值可用于**提前**撤销该项（插件自愿清理），重复调用安全。
   */
  add(teardown: Teardown, label?: string): Disposable {
    const entry: Entry = { id: ++this.#seq, label: label ?? this.#opts.label, teardown }
    if (this.#state === 'closed') {
      void this.#run(entry)
      return NOOP
    }
    // open 与 draining 都入栈：draining 期间若直接 #run，会与当前 teardown 并发，
    // 破坏 I2 串行；入栈后由正在排空的循环按 LIFO 接着处理。
    this.#entries.push(entry)
    return {
      dispose: (): void => {
        // 提前撤销 = **立刻执行**这项逆操作，而不是把它从队列里摘掉就完事。
        // 幂等性由 remove() 保证：命中过一次之后就不再重复执行。
        if (!this.remove(entry.id)) return
        if (this.#state === 'draining') {
          // 正在排空：放回队列交给 drain 循环（当前 teardown 结束后按 LIFO 执行），
          // 避免与当前 teardown 并发 —— 这也属于 I2。
          this.#entries.push(entry)
          return
        }
        void this.#run(entry)
      },
    }
  }

  /**
   * 建资源 + 登记逆操作。
   *
   * `register` **必须是同步函数**：若允许异步，"拿到句柄"与"登记逆操作"之间就存在 await 窗口，
   * 该窗口内发起卸载会导致资源逃逸。需要异步建资源请用 `effectAsync`。
   */
  effect<T>(register: () => T, dispose: (resource: T) => void | Promise<void>, label?: string): T {
    const resource = register()
    this.add(() => dispose(resource), label)
    return resource
  }

  /**
   * 异步建资源。
   * await 期间若已发生卸载，`add()` 会走 I4 立即回收 —— 竞态下同样不泄漏。
   */
  async effectAsync<T>(
    register: () => Promise<T>,
    dispose: (resource: T) => void | Promise<void>,
    label?: string,
  ): Promise<T> {
    const resource = await register()
    this.add(() => dispose(resource), label)
    return resource
  }

  /** 派生子栈；子栈作为父栈的一项 effect 登记，父子回收天然满足逆序。 */
  scope(label?: string): EffectStack {
    const child = new EffectStack({
      ...this.#opts,
      label: label ?? this.#opts.label,
    })
    this.add(() => child.dispose(), label === undefined ? 'scope' : `scope:${label}`)
    return child
  }

  /** 从待回收列表中摘除一项，**不执行** teardown。返回是否命中。 */
  remove(id: number): boolean {
    const index = this.#entries.findIndex((entry) => entry.id === id)
    if (index < 0) return false
    this.#entries.splice(index, 1)
    return true
  }

  /**
   * LIFO 逆序回收，串行 await。幂等：重复调用（包括并发调用）返回同一次回收。
   *
   * 审计复现过并发 `dispose()` 会各起一条循环，teardown 交错成
   * `B:start, A:start, B:end, A:end`，破坏 ADR-0004 I2。这里用 `#drainPromise`
   * 保证只有一条回收链；`#drain` 开头先让出一个微任务，确保字段已赋值。
   */
  async dispose(): Promise<void> {
    if (this.#state === 'closed') return
    if (this.#drainPromise !== undefined) {
      try {
        await this.#drainPromise
        return
      } catch (error) {
        // 上一次回收链异常中断：清掉缓存，让下一次 dispose() 继续回收剩余项，
        // 而不是把一个 rejected promise 永久缓存成“整栈永远回不完”。
        this.#drainPromise = undefined
        throw error
      }
    }
    this.#state = 'draining'
    const drain = this.#drain()
    this.#drainPromise = drain
    try {
      await drain
    } catch (error) {
      this.#drainPromise = undefined
      throw error
    }
  }

  async #drain(): Promise<void> {
    // 让出一次微任务：赋值完成后才会真正执行 teardown，于是 teardown 里同步再调
    // dispose() 也会命中同一个 in-flight promise，而不是再起一条并发链。
    await Promise.resolve()

    const budgetMs = this.#opts.disposeBudgetMs
    const deadline = budgetMs !== undefined && budgetMs > 0 ? Date.now() + budgetMs : undefined
    while (this.#entries.length > 0) {
      const entry = this.#entries.pop()
      if (entry === undefined) break
      if (deadline === undefined) {
        await this.#run(entry)
        continue
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        // 预算耗尽：**不 break** —— 剩下每一项都要留下一条"被跳过"的上报记录，
        // 静默截断会让宿主日志无法区分"没有剩余 effect"与"剩余 effect 被丢掉"。
        this.#skippedByBudget += 1
        this.#report(
          new Error(`effect "${entry.label ?? '<anonymous>'}" 因整栈回收预算耗尽被跳过，teardown 未执行`),
          entry.label,
        )
        continue
      }
      await this.#run(entry, remaining)
    }
    this.#state = 'closed'
  }

  async #run(entry: Entry, remainingBudgetMs?: number): Promise<void> {
    try {
      const result = entry.teardown()
      if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
        const configured = this.#opts.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
        const timeoutMs =
          remainingBudgetMs === undefined ? configured : Math.max(1, Math.min(configured, remainingBudgetMs))
        await withTimeout(result as Promise<void>, timeoutMs)
      }
    } catch (error) {
      this.#report(error, entry.label)
    }
  }

  /**
   * 观察者（日志/诊断）抛错不能打断回收：否则一个坏监听器会把整栈永久卡在 draining，
   * 后续 dispose() 全部失败（审计 F2）。核心不变量优先于观察者。
   */
  #report(error: unknown, label: string | undefined): void {
    try {
      this.#opts.onError?.(error, label)
    } catch {
      // 观察者错误已被隔离；没有第二个出口可以上报，且不能让它影响回收。
    }
  }
}

const NOOP: Disposable = Object.freeze({ dispose(): void {} })
