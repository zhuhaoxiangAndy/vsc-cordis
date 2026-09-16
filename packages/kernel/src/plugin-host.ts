import type {
  LogLevel,
  Logger,
  Permission,
  PluginContext,
  PluginId,
  ServiceName,
} from '@vscordis/sdk'
import { createPluginContext } from './context.ts'
import { EffectStack } from './effect-stack.ts'
import { IsolationUnavailableError, PluginAlreadyLoadedError } from './errors.ts'
import type { HostPort, LoadedPluginModule, PluginEntry, PluginSource } from './ports.ts'
import { ServiceRegistry, type ServiceChangeEvent } from './service-registry.ts'
import { withTimeout } from './timing.ts'

/**
 * 插件状态机（ADR-0007 决策 4）。
 *
 *   idle ──load──► loading ──► active ⇄ paused
 *                     │           ▲        │
 *                     │           └────────┘ 依赖恢复
 *                     └──► failed（回滚完成，不再自动重试）
 *
 * `paused` 有两种成因，语义相同、处理相同：
 *   1. 首次加载时依赖尚未满足（从未 activate 过）；
 *   2. 曾经 active，硬依赖被撤销 → 完整卸载但保留记录。
 */
export type PluginState = 'idle' | 'loading' | 'active' | 'paused' | 'failed' | 'unloading'

export interface PluginRecord {
  readonly entry: PluginEntry
  state: PluginState
  error: unknown
  effects: EffectStack | undefined
  abort: AbortController | undefined
  loaded: LoadedPluginModule | undefined
  ctx: PluginContext | undefined
  /** 当前缺失的硬依赖服务名（用于状态展示与恢复判定）。 */
  missing: readonly ServiceName[]
}

export interface PluginView {
  readonly id: PluginId
  readonly name: string
  readonly version: string
  readonly state: PluginState
  readonly source: PluginSource
  readonly provides: readonly ServiceName[]
  readonly dependencies: Readonly<Record<string, string>>
  readonly missing: readonly ServiceName[]
  readonly error: string | undefined
}

export interface TransitionEvent {
  readonly id: PluginId
  readonly from: PluginState
  readonly to: PluginState
  readonly reason: string
}

export interface PluginHostOptions {
  readonly port: HostPort
  readonly registry?: ServiceRegistry
  /** in-flight 调用的强制回收上限；默认 2000ms（ADR-0007 决策 6）。 */
  readonly disposeTimeoutMs?: number
  /**
   * 单个插件 `activate()` 的时限；默认 15000ms。
   *
   * 为什么必须有：所有生命周期操作共用一条**串行队列**，一个永不 resolve 的 `activate`
   * 会把队列永久卡住 —— 连"卸载这个插件"都排在它后面。那不只是这个插件坏了，
   * 而是整个宿主失去响应。超时不是为了让慢插件更快，而是为了让宿主**始终可恢复**。
   */
  readonly activationTimeoutMs?: number
  readonly onTransition?: (event: TransitionEvent) => void
}

export class PluginHost {
  readonly #port: HostPort
  readonly #registry: ServiceRegistry
  readonly #records = new Map<PluginId, PluginRecord>()
  readonly #disposeTimeoutMs: number
  readonly #activationTimeoutMs: number
  readonly #onTransition: ((event: TransitionEvent) => void) | undefined
  readonly #subscriptions: { dispose(): void }[] = []
  #queue: Promise<void> = Promise.resolve()
  #disposed = false

  constructor(options: PluginHostOptions) {
    this.#port = options.port
    this.#disposeTimeoutMs = options.disposeTimeoutMs ?? 2_000
    this.#activationTimeoutMs = options.activationTimeoutMs ?? 15_000
    this.#onTransition = options.onTransition
    this.#registry =
      options.registry ??
      new ServiceRegistry({
        onListenerError: (error) => {
          this.#port.log('error', '服务注册表监听器抛错', { error: describe(error) })
        },
      })

    this.#subscriptions.push(
      this.#registry.onDidChange((event) => {
        this.#handleServiceChange(event)
      }),
    )
  }

  get registry(): ServiceRegistry {
    return this.#registry
  }

  /**
   * 等待队列彻底排空，**包括级联产生的后续任务**。
   *
   * 为什么需要它：卸载一个提供者时，消费者的暂停/恢复是排队在当前任务**之后**的新任务。
   * 若调用方需要观察稳定的终态（"卸载后无残留"的断言、状态展示、CLI 输出），必须先 settle。
   */
  async settle(): Promise<void> {
    await this.#enqueue(async () => {})
  }

  get port(): HostPort {
    return this.#port
  }

  list(): readonly PluginView[] {
    return [...this.#records.values()].map((record) => this.#view(record))
  }

  view(id: PluginId): PluginView | undefined {
    const record = this.#records.get(id)
    return record === undefined ? undefined : this.#view(record)
  }

  // ————————————————————————————————— 生命周期操作（全部串行）

  async load(entry: PluginEntry): Promise<PluginView> {
    return await this.#enqueue(async () => {
      this.#assertUsable()
      const id = entry.manifest.id
      const existing = this.#records.get(id)
      if (existing !== undefined && existing.state !== 'idle' && existing.state !== 'failed') {
        throw new PluginAlreadyLoadedError(id, existing.state)
      }
      if (existing !== undefined) {
        await this.#deactivateTo(existing, 'idle', 'load：清理上一条失败记录')
        this.#records.delete(id)
      }

      const record: PluginRecord = {
        entry,
        state: 'idle',
        error: undefined,
        effects: undefined,
        abort: undefined,
        loaded: undefined,
        ctx: undefined,
        missing: [],
      }
      this.#records.set(id, record)

      // fail-closed：没有隔离后端时绝不以同进程方式执行不可信代码（ADR-0003）。
      if (entry.manifest.trust === 'untrusted' && !this.#port.supportsIsolation) {
        const error = new IsolationUnavailableError(id, this.#port.platform)
        record.error = error
        this.#setState(record, 'failed', '缺少隔离后端，拒绝加载不可信插件')
        throw error
      }

      await this.#activate(record, 'load')
      return this.#view(record)
    })
  }

  async unload(id: PluginId): Promise<void> {
    await this.#enqueue(async () => {
      const record = this.#records.get(id)
      if (record === undefined) return
      await this.#deactivateTo(record, 'idle', 'unload')
      this.#records.delete(id)
    })
  }

  async unloadAll(): Promise<void> {
    await this.#enqueue(async () => {
      for (const id of [...this.#records.keys()]) {
        const record = this.#records.get(id)
        if (record === undefined) continue
        await this.#deactivateTo(record, 'idle', 'unloadAll')
        this.#records.delete(id)
      }
    })
  }

  async reload(id: PluginId): Promise<PluginView> {
    return await this.#enqueue(async () => {
      this.#assertUsable()
      const record = this.#records.get(id)
      if (record === undefined) throw new Error(`插件 "${id}" 未加载，无法重载`)
      await this.#deactivateTo(record, 'idle', 'reload')
      await this.#activate(record, 'reload')
      return this.#view(record)
    })
  }

  async dispose(): Promise<void> {
    await this.#enqueue(async () => {
      this.#disposed = true
      for (const subscription of this.#subscriptions.splice(0)) subscription.dispose()
      for (const id of [...this.#records.keys()]) {
        const record = this.#records.get(id)
        if (record === undefined) continue
        await this.#deactivateTo(record, 'idle', '宿主关闭')
        this.#records.delete(id)
      }
      this.#registry.clear()
    })
  }

  // ————————————————————————————————— 内部：激活与回收

  async #activate(record: PluginRecord, reason: string): Promise<void> {
    const manifest = record.entry.manifest

    // 第一道判定：只看清单的**便宜预检** —— 缺依赖就连模块都不加载（不让模块级代码白跑一遍）。
    const preMissing = this.#missingDependencies(record)
    if (preMissing.length > 0 && record.loaded === undefined) {
      record.missing = preMissing
      this.#setState(record, 'paused', `${reason}：等待依赖 ${preMissing.join(', ')}`)
      return
    }
    this.#setState(record, 'loading', reason)

    const effects = new EffectStack({
      label: manifest.id,
      disposeTimeoutMs: this.#disposeTimeoutMs,
      onError: (error, label) => {
        this.#port.log('error', `副作用回收失败：${label ?? '<未命名>'}`, {
          plugin: manifest.id,
          error: describe(error),
        })
      },
    })
    const abort = new AbortController()
    record.effects = effects
    record.abort = abort
    record.error = undefined

    const log = createPluginLogger(manifest.id, this.#port)
    const permissions = new Set<Permission>(manifest.permissions as readonly Permission[])

    try {
      const loaded = await this.#port.loadModule(record.entry)
      record.loaded = loaded

      // 第二道判定：模块已就位，现在能读到 `plugin.inject` 了，合并后重新判定。
      // 若仍缺依赖，必须**释放模块**再 parked —— 代价是模块级代码已经求值过一次，
      // 这正是"清单声明才是权威"的原因（ADR-0010 决策 2）。
      const missing = this.#missingDependencies(record)
      if (missing.length > 0) {
        record.missing = missing
        await this.#release(record)
        this.#setState(record, 'paused', `${reason}：等待依赖 ${missing.join(', ')}`)
        return
      }

      const ctx = createPluginContext({
        id: manifest.id,
        manifest,
        registry: this.#registry,
        effects,
        vscode: this.#port.createApi({ id: manifest.id, permissions, effects, log }),
        log,
        signal: abort.signal,
      })
      record.ctx = ctx
      try {
        await withTimeout(
          Promise.resolve(loaded.plugin.activate(ctx)),
          this.#activationTimeoutMs,
          `插件 ${manifest.id} 的 activate()`,
        )
      } catch (error) {
        // 超时或失败都要先发卸载信号：插件的异步工作可能还在跑，必须让它有机会停下来，
        // 否则"回滚"只是把宿主侧的状态清掉，插件侧仍留着一个活的异步任务。
        abort.abort()
        throw error
      }
      record.missing = []
      this.#checkProvidesDrift(record)
      this.#setState(record, 'active', reason)
    } catch (error) {
      // activate 未成功 → 不调用 deactivate（它面向"已激活"的插件），直接逆序回收已产生的副作用。
      record.error = error
      await this.#release(record)
      this.#setState(record, 'failed', `${reason} 失败：${describe(error)}`)
      throw error
    }
  }

  /**
   * 完整卸载：deactivate → EffectStack LIFO 回收 → 释放模块缓存。
   *
   * `record.effects.dispose()` 会回收 `provide(...)` 登记的 effect，从而触发注册表的 revoke 事件，
   * 级联到下游消费者 —— 这是"空间可组合性"的唯一实现点。
   */
  async #deactivateTo(record: PluginRecord, next: PluginState, reason: string): Promise<void> {
    this.#setState(record, 'unloading', reason)
    record.abort?.abort()

    const loaded = record.loaded
    const ctx = record.ctx
    if (loaded !== undefined && ctx !== undefined) {
      try {
        const result = loaded.plugin.deactivate?.(ctx)
        if (result !== undefined) {
          await withTimeout(Promise.resolve(result), this.#disposeTimeoutMs, 'deactivate()')
        }
      } catch (error) {
        this.#port.log('warn', `deactivate() 抛错（继续回收）`, {
          plugin: record.entry.manifest.id,
          error: describe(error),
        })
      }
    }

    await this.#release(record)
    this.#setState(record, next, reason)
  }

  async #release(record: PluginRecord): Promise<void> {
    const effects = record.effects
    const loaded = record.loaded
    record.effects = undefined
    record.loaded = undefined
    record.ctx = undefined
    record.abort = undefined

    // 顺序很重要：先回收副作用（含 provide → 触发级联 revoke），再释放模块缓存。
    if (effects !== undefined) await effects.dispose()
    if (loaded !== undefined) {
      try {
        loaded.release()
      } catch (error) {
        this.#port.log('warn', '释放插件模块失败', {
          plugin: record.entry.manifest.id,
          error: describe(error),
        })
      }
    }
  }

  // ————————————————————————————————— 内部：依赖协调

  /**
   * 注册表变化 → 投递到**队列尾部**处理。
   *
   * 这一点是顺序正确性的关键：`revoke` 事件是在提供者 `EffectStack.dispose()` 内部同步触发的，
   * 此刻提供者还处于 `unloading`。只有把消费者暂停排到队列尾部，
   * 才能保证"提供者彻底卸载完毕 → 消费者才开始暂停"，不会观察到半个服务状态。
   */
  #handleServiceChange(event: ServiceChangeEvent): void {
    if (this.#disposed) return
    // 注意这里的 catch：`void promise` 只丢弃返回值，不处理拒绝 ——
    // 一旦这个任务抛出，Node 会报未处理的 rejection，而调用方（注册表事件）根本无从感知。
    void this.#enqueue(async () => {
      if (this.#disposed) return
      for (const id of event.affected) {
        const record = this.#records.get(id)
        if (record === undefined || record.state !== 'active') continue
        await this.#deactivateTo(record, 'paused', `硬依赖 "${event.name}" 被撤销`)
      }
      await this.#resumeReady(`服务 "${event.name}" ${event.kind}`)
    }).catch((error: unknown) => {
      this.#port.log('error', '处理服务变化事件时抛错（已吞掉，避免未处理的 rejection）', {
        service: event.name,
        kind: event.kind,
        error: describe(error),
      })
    })
  }

  async #resumeReady(reason: string): Promise<void> {
    for (const record of [...this.#records.values()]) {
      if (record.state !== 'paused') continue
      const missing = this.#missingDependencies(record)
      record.missing = missing
      if (missing.length > 0) continue
      try {
        await this.#activate(record, `自动恢复：${reason}`)
      } catch (error) {
        // 保持 failed，不做自动重试，避免错误风暴（ADR-0009 决策：失败可见优先）。
        this.#port.log('error', '自动恢复失败，插件保持 failed 状态', {
          plugin: record.entry.manifest.id,
          error: describe(error),
        })
      }
    }
  }

  /**
   * 依赖声明有两个来源（ADR-0010 决策 2）：
   * - `plugin.json#dependencies`（**权威**：能在模块求值之前拦下）；
   * - `CordisPlugin.inject`（cordis 风格；必须模块已加载才能读到，缺省范围 `*`）。
   */
  #declaredDependencies(record: PluginRecord): Record<string, string> {
    const declared: Record<string, string> = { ...record.entry.manifest.dependencies }
    for (const name of record.loaded?.plugin.inject ?? []) {
      if (declared[name] === undefined) declared[name] = '*'
    }
    return declared
  }

  /**
   * 比对 `plugin.json#provides` 的声明与实际提供（ADR-0014）。
   *
   * 为什么必须检查：声明了却不生效的字段是陷阱 —— `CordisPlugin.inject` 就吃过这个亏
   * （ADR-0010 决策 2）。但这里只**告警不阻断**：服务是运行期决定的，
   * 静态声明天生只能尽力而为，阻断会让一个纯工具字段变成加载门槛。
   */
  #checkProvidesDrift(record: PluginRecord): void {
    const id = record.entry.manifest.id
    const declared = new Set(record.entry.manifest.provides)
    const actual = new Set(this.#registry.providesOf(id))
    const declaredButNotProvided = [...declared].filter((name) => !actual.has(name))
    const providedButNotDeclared = [...actual].filter((name) => !declared.has(name))
    if (declaredButNotProvided.length === 0 && providedButNotDeclared.length === 0) return

    this.#port.log('warn', 'provides 声明与实际不一致（只告警，不影响加载）', {
      plugin: id,
      declaredButNotProvided: declaredButNotProvided.join(', ') || '-',
      providedButNotDeclared: providedButNotDeclared.join(', ') || '-',
      hint: 'vscordis tree 的依赖图依据声明值，请保持同步',
    })
  }

  #missingDependencies(record: PluginRecord): readonly ServiceName[] {
    const missing: ServiceName[] = []
    for (const [name, range] of Object.entries(this.#declaredDependencies(record))) {
      if (!this.#registry.canResolve(name, range)) missing.push(name)
    }
    return missing
  }

  // ————————————————————————————————— 内部：队列与视图

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(() => task())
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  #setState(record: PluginRecord, next: PluginState, reason: string): void {
    const from = record.state
    if (from === next) return
    record.state = next
    this.#port.log('debug', `状态 ${from} → ${next}（${reason}）`, { plugin: record.entry.manifest.id })
    try {
      this.#onTransition?.({ id: record.entry.manifest.id, from, to: next, reason })
    } catch {
      // 观察者抛错不影响状态机
    }
  }

  #view(record: PluginRecord): PluginView {
    const manifest = record.entry.manifest
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      state: record.state,
      source: record.entry.source,
      provides: this.#registry.providesOf(manifest.id),
      dependencies: manifest.dependencies,
      missing: record.missing,
      error: record.error === undefined ? undefined : describe(record.error),
    }
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error('PluginHost 已 dispose，无法继续操作')
  }
}

export function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function createPluginLogger(id: PluginId, port: HostPort): Logger {
  const meta = (extra?: Record<string, unknown>): Record<string, unknown> => ({ plugin: id, ...extra })
  const emit = (level: LogLevel, message: string, extra?: Record<string, unknown>): void => {
    port.log(level, message, meta(extra))
  }
  return {
    trace: (message, ...args) => emit('trace', message, { args }),
    debug: (message, ...args) => emit('debug', message, { args }),
    info: (message, ...args) => emit('info', message, { args }),
    warn: (message, ...args) => emit('warn', message, { args }),
    error: (message, error) => emit('error', message, { error: describe(error) }),
  }
}
