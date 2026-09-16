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
   * 登记一项逆操作。
   * - 已闭栈（I4）：立即执行，返回的 Disposable 是空操作。
   * - 返回值可用于**提前**撤销该项（插件自愿清理），重复调用安全。
   */
  add(teardown: Teardown, label?: string): Disposable {
    const entry: Entry = { id: ++this.#seq, label: label ?? this.#opts.label, teardown }
    if (this.#state !== 'open') {
      void this.#run(entry)
      return NOOP
    }
    this.#entries.push(entry)
    return {
      dispose: (): void => {
        // 提前撤销 = **立刻执行**这项逆操作，而不是把它从队列里摘掉就完事。
        // 幂等性由 remove() 保证：命中过一次之后就不再重复执行。
        if (this.remove(entry.id)) void this.#run(entry)
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

  /** LIFO 逆序回收，串行 await。幂等：重复调用即刻返回。 */
  async dispose(): Promise<void> {
    if (this.#state === 'closed') return
    this.#state = 'draining'
    while (this.#entries.length > 0) {
      const entry = this.#entries.pop()
      if (entry === undefined) break
      await this.#run(entry)
    }
    this.#state = 'closed'
  }

  async #run(entry: Entry): Promise<void> {
    try {
      const result = entry.teardown()
      if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
        await withTimeout(result as Promise<void>, this.#opts.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS)
      }
    } catch (error) {
      this.#opts.onError?.(error, entry.label)
    }
  }
}

const NOOP: Disposable = Object.freeze({ dispose(): void {} })
