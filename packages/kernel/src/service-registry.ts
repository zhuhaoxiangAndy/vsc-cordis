import type {
  DependencyEdgeView,
  DependencyGraphSnapshot,
  DependencyKind,
  Disposable,
  PluginId,
  ProvideOptions,
  ServiceName,
  ServiceView,
} from '@vscordis/sdk'
import { ServiceConflictError, ServiceUnavailableError, ServiceVersionMismatchError } from './errors.ts'
import { satisfies } from './semver-mini.ts'

export interface ServiceProviderRecord {
  readonly owner: PluginId
  readonly version: string | undefined
  readonly instance: unknown
}

export interface ServiceChangeEvent {
  readonly name: ServiceName
  readonly kind: 'provided' | 'revoked' | 'replaced'
  readonly previous: ServiceProviderRecord | undefined
  readonly current: ServiceProviderRecord | undefined
  /**
   * 受影响的**硬依赖**传递闭包（不含提供者自身）。
   * 软依赖不参与级联（ADR-0007 决策 4），因此不出现在这里。
   */
  readonly affected: readonly PluginId[]
}

interface ConsumerRecord {
  readonly kind: DependencyKind
  readonly range: string | undefined
}

interface Slot {
  provider: ServiceProviderRecord | undefined
  generation: number
  readonly consumers: Map<PluginId, ConsumerRecord>
}

export type RegistryListener = (event: ServiceChangeEvent) => void

/**
 * ServiceRegistry —— 「空间可组合性」的注册表。
 *
 * 三条设计要点：
 * 1. 键是**服务名**而不是插件 id：提供者可以换人，消费者不受影响（ADR-0007 决策 1）。
 * 2. `provide` 返回 Disposable，并且通常会被登记到提供者的 EffectStack 上 ——
 *    于是"提供者卸载 → 服务消失 → 消费者暂停"这条级联**自动发生**，无需特判传递闭包。
 * 3. 冲突默认 exclusive：静默覆盖会让"服务到底谁提供的"变成不可诊断的谜题。
 */
export class ServiceRegistry {
  readonly #slots = new Map<ServiceName, Slot>()
  readonly #provides = new Map<PluginId, Set<ServiceName>>()
  readonly #listeners = new Set<RegistryListener>()
  readonly #onListenerError: (error: unknown) => void

  constructor(options: { readonly onListenerError?: (error: unknown) => void } = {}) {
    this.#onListenerError = options.onListenerError ?? ((): void => {})
  }

  get size(): number {
    return this.#slots.size
  }

  /** 当前存在提供者的服务名（用于状态展示与测试断言）。 */
  providedServices(): readonly ServiceName[] {
    const names: ServiceName[] = []
    for (const [name, slot] of this.#slots) if (slot.provider !== undefined) names.push(name)
    return names
  }

  /** 某个插件当前提供的全部服务名。 */
  providesOf(owner: PluginId): readonly ServiceName[] {
    return [...(this.#provides.get(owner) ?? [])]
  }

  provide<T>(owner: PluginId, name: ServiceName, instance: T, options: ProvideOptions = {}): Disposable {
    const policy = options.conflict ?? 'exclusive'
    let slot = this.#slots.get(name)
    if (slot === undefined) {
      slot = { provider: undefined, generation: 0, consumers: new Map() }
      this.#slots.set(name, slot)
    }

    const existing = slot.provider
    if (existing !== undefined && existing.owner !== owner && policy === 'exclusive') {
      throw new ServiceConflictError(name, existing.owner, owner)
    }

    const affected = existing !== undefined && existing.owner !== owner ? this.affectedBy(existing.owner) : []

    slot.provider = { owner, version: options.version, instance }
    slot.generation += 1
    let mine = this.#provides.get(owner)
    if (mine === undefined) {
      mine = new Set<ServiceName>()
      this.#provides.set(owner, mine)
    }
    mine.add(name)

    this.#emit({
      name,
      kind: existing === undefined ? 'provided' : 'replaced',
      previous: existing,
      current: slot.provider,
      affected,
    })

    let revoked = false
    return {
      dispose: (): void => {
        if (revoked) return
        revoked = true
        this.revoke(owner, name)
      },
    }
  }

  /** 撤销某插件对某服务的提供；若当前提供者不是它，则是空操作。 */
  revoke(owner: PluginId, name: ServiceName): void {
    const slot = this.#slots.get(name)
    if (slot === undefined || slot.provider === undefined || slot.provider.owner !== owner) return

    // 关键顺序：affectedBy 依赖 #provides/#slots 的当前状态，必须先算级联再拆除。
    const affected = this.affectedBy(owner)
    const previous = slot.provider
    slot.provider = undefined
    this.#provides.get(owner)?.delete(name)
    if (this.#provides.get(owner)?.size === 0) this.#provides.delete(owner)
    this.#prune(name)

    this.#emit({ name, kind: 'revoked', previous, current: undefined, affected })
  }

  /** 严格解析：缺失或版本不满足都会抛错。 */
  resolve<T>(name: ServiceName, range?: string): T {
    const provider = this.#slots.get(name)?.provider
    if (provider === undefined) throw new ServiceUnavailableError(name, range)
    if (range !== undefined && range !== '*' && !satisfies(provider.version ?? '', range)) {
      throw new ServiceVersionMismatchError(name, range, provider.version)
    }
    return provider.instance as T
  }

  /** 宽松解析：缺失或无版本信息时返回 undefined。 */
  tryResolve<T>(name: ServiceName): T | undefined {
    return this.#slots.get(name)?.provider?.instance as T | undefined
  }

  /** 非抛出式探测，供加载前的依赖预检使用。 */
  canResolve(name: ServiceName, range?: string): boolean {
    const provider = this.#slots.get(name)?.provider
    if (provider === undefined) return false
    if (range === undefined || range === '*') return true
    return satisfies(provider.version ?? '', range)
  }

  /** 登记一条依赖边；返回的 Disposable 解除该边。 */
  depend(consumer: PluginId, name: ServiceName, kind: DependencyKind = 'hard', range?: string): Disposable {
    let slot = this.#slots.get(name)
    if (slot === undefined) {
      slot = { provider: undefined, generation: 0, consumers: new Map() }
      this.#slots.set(name, slot)
    }
    slot.consumers.set(consumer, { kind, range })

    let detached = false
    return {
      dispose: (): void => {
        if (detached) return
        detached = true
        const target = this.#slots.get(name)
        if (target === undefined) return
        target.consumers.delete(consumer)
        this.#prune(name)
      },
    }
  }

  /**
   * 硬依赖的**传递闭包**：谁会因为 `owner` 的消失而必须暂停。
   *
   * 实现即"沿 provides → consumers 图做广度优先"。注意这只是**诊断与通知**用的加速结构；
   * 真正的级联不依赖它 —— 级联由 EffectStack 回收 provides 时的 revoke 事件自然触发（ADR-0007 决策 5）。
   */
  affectedBy(owner: PluginId): readonly PluginId[] {
    const affected = new Set<PluginId>()
    const queue: ServiceName[] = [...(this.#provides.get(owner) ?? [])]
    const visitedServices = new Set<ServiceName>()

    while (queue.length > 0) {
      const name = queue.shift()
      if (name === undefined) break
      if (visitedServices.has(name)) continue
      visitedServices.add(name)

      const slot = this.#slots.get(name)
      if (slot === undefined) continue
      for (const [consumer, record] of slot.consumers) {
        if (record.kind === 'soft') continue
        if (consumer === owner) continue
        if (affected.has(consumer)) continue
        affected.add(consumer)
        for (const service of this.#provides.get(consumer) ?? []) queue.push(service)
      }
    }
    return [...affected]
  }

  onDidChange(listener: RegistryListener): Disposable {
    this.#listeners.add(listener)
    return {
      dispose: (): void => {
        this.#listeners.delete(listener)
      },
    }
  }

  snapshot(): DependencyGraphSnapshot {
    const edges: DependencyEdgeView[] = []
    const services: ServiceView[] = []

    for (const [name, slot] of this.#slots) {
      const consumers: { owner: PluginId; kind: DependencyKind }[] = []
      for (const [consumer, record] of slot.consumers) {
        edges.push({ consumer, service: name, kind: record.kind, range: record.range })
        consumers.push({ owner: consumer, kind: record.kind })
      }
      services.push({
        name,
        provider:
          slot.provider === undefined
            ? undefined
            : { owner: slot.provider.owner, version: slot.provider.version, generation: slot.generation },
        consumers,
      })
    }
    return { edges, services }
  }

  /** 清空注册表（用于宿主关闭或测试隔离）。不触发事件。 */
  clear(): void {
    this.#slots.clear()
    this.#provides.clear()
  }

  /**
   * 清理"既无提供者又无消费者"的空槽位。
   * 没有这一步，插件反复启停会让 `#slots` 持续膨胀 —— 属于典型的卸载残留。
   */
  #prune(name: ServiceName): void {
    const slot = this.#slots.get(name)
    if (slot !== undefined && slot.provider === undefined && slot.consumers.size === 0) {
      this.#slots.delete(name)
    }
  }

  #emit(event: ServiceChangeEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.#onListenerError(error)
      }
    }
  }
}
