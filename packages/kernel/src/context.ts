import type {
  DependencyGraphSnapshot,
  DependencyKind,
  Disposable,
  Logger,
  Permission,
  PluginContext,
  PluginId,
  PluginVscodeApi,
  ProvideOptions,
  ServiceName,
} from '@vscordis/sdk'
import type { EffectStack } from './effect-stack.ts'
import type { NormalizedManifest } from './manifest.ts'
import type { ServiceRegistry } from './service-registry.ts'

export interface PluginContextDeps {
  readonly id: PluginId
  readonly manifest: NormalizedManifest
  readonly registry: ServiceRegistry
  readonly effects: EffectStack
  readonly vscode: PluginVscodeApi
  readonly log: Logger
  readonly signal: AbortSignal
}

/**
 * 构造插件可见的上下文。
 *
 * 一条关键规则：**依赖边的登记与服务的解析必须成对发生**。
 * `use()` 先 `registry.depend()` 再 `resolve()`，于是：
 *   - 解析失败时，依赖边仍留在注册表上（并被 EffectStack 回收）→ 诊断信息不丢；
 *   - 解析成功时，边与实例同时存在 → 提供者撤销能精确命中这个消费者。
 */
export function createPluginContext(deps: PluginContextDeps): PluginContext {
  const { id, manifest, registry, effects, vscode, log, signal } = deps

  const registerDependency = (name: ServiceName, kind: DependencyKind): void => {
    const range = manifest.dependencies[name]
    const edge: Disposable = registry.depend(id, name, kind, range)
    effects.add(() => edge.dispose(), `depend:${kind}:${name}`)
  }

  const ctx: PluginContext = {
    id,
    manifest,
    signal,
    log,
    permissions: new Set<Permission>(manifest.permissions as readonly Permission[]),
    vscode,

    effect: (register, dispose, label) => effects.effect(register, dispose, label),
    effectAsync: (register, dispose, label) => effects.effectAsync(register, dispose, label),
    scope: (label?: string) => createPluginContext({ ...deps, effects: effects.scope(label) }),
    effects,

    use<T>(name: ServiceName): T {
      registerDependency(name, 'hard')
      return registry.resolve<T>(name, manifest.dependencies[name])
    },
    tryUse<T>(name: ServiceName): T | undefined {
      registerDependency(name, 'soft')
      return registry.tryResolve<T>(name)
    },
    provide<T>(name: ServiceName, service: T, options?: ProvideOptions): Disposable {
      const handle = registry.provide(id, name, service, options)
      // 双保险：插件显式 dispose 与 EffectStack 回收都会走同一条幂等路径。
      effects.add(() => handle.dispose(), `provide:${name}`)
      return handle
    },
    graph: (): DependencyGraphSnapshot => registry.snapshot(),
    onDispose: (teardown, label) => effects.add(teardown, label),
  }

  return ctx
}
