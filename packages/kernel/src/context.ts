import type {
  AsyncService,
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

/**
 * 把服务实例包成"方法全异步"的代理（`ctx.async.useService` 的实现）。
 *
 * - **方法**：包一层 `Promise.resolve`。本地方法本来返回 Promise 也没问题。
 * - **数据属性**：**抛错**而不是返回 undefined。类型层已经把非方法属性映射成 `never`，
 *   运行期也不该给出一个静默无效的值 —— 那是本项目一贯拒绝的形态。
 * - 不存在的属性：按常规返回 `undefined`（`in` 检查走原型链，所以类的实例方法能被识别）。
 */
export function wrapAsyncService<T>(instance: unknown): AsyncService<T> {
  if (instance === null || (typeof instance !== 'object' && typeof instance !== 'function')) {
    throw new Error('ctx.async.useService 只能用于对象形式的服务（方法调用需要一个接收者）')
  }
  const target = instance as Record<string | symbol, unknown>
  return new Proxy(target, {
    get(receiver, property, proxy) {
      const value = Reflect.get(receiver, property, proxy)
      if (typeof property === 'symbol') return value
      // ⚠️ `then` 必须原样透出（通常是 undefined）：`await ctx.async.useService(name)` 会探测 `.then`，
      // 若这里对未知属性抛错，就会炸在"调用了不存在的方法 then"上。
      if (property === 'then') return value
      if (typeof value === 'function') {
        return (...args: unknown[]): Promise<unknown> => Promise.resolve(value.apply(receiver, args))
      }
      if (property in receiver) {
        throw new Error(
          `异步服务只支持方法调用：属性 "${property}" 是数据字段。` +
            '跨进程传不了活对象 —— 请把它做成快照式 API（每次调用返回数据），' +
            '或改用 trust: trusted 的同进程服务（ADR-0019）。',
        )
      }
      return value
    },
  }) as AsyncService<T>
}

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

    /**
     * 显式异步面（ADR-0018）。同进程实现：把真实的 `TextDocument` 适配成
     * `AsyncTextDocument` 的形状（纯数据 + 异步 `getText()`）。
     * 隔离模式在子进程里实现同一签名 —— 于是插件代码不需要按模式分支。
     */
    async: {
      onDidSaveTextDocument: async (listener) => {
        const disposable = vscode.workspace.onDidSaveTextDocument((document) => {
          listener({
            uri: document.uri.toString(),
            fsPath: document.uri.fsPath,
            languageId: document.languageId,
            lineCount: document.lineCount,
            version: document.version,
            getText: async () => document.getText(),
          })
        })
        // 走 EffectStack：插件即使忘了 dispose，卸载时也会被回收。
        effects.add(() => disposable.dispose(), 'async:onDidSaveTextDocument')
        return disposable
      },
      useService: async <T,>(name: ServiceName): Promise<AsyncService<T>> => {
        // 与 ctx.use 一样登记硬依赖边：提供者离开时本插件会被 paused。
        const range = manifest.dependencies[name]
        const edge: Disposable = registry.depend(id, name, 'hard', range)
        effects.add(() => edge.dispose(), `depend:async:${name}`)
        return wrapAsyncService<T>(registry.resolveForAsync<T>(name, range))
      },
    },

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
      // 软依赖同样受清单声明的版本范围约束（ADR-0019）：版本不满足会抛错而不是
      // 静默返回 undefined —— "存在但版本不符"不该被当成"软依赖不存在"。
      return registry.tryResolve<T>(name, manifest.dependencies[name])
    },
    provide<T>(name: ServiceName, service: T, options?: ProvideOptions): Disposable {
      // `remote` 是运行时的标注，不是插件的选项：隔离提供者由 loader 注册时才置位。
      // 若允许插件自设，一个同进程服务会变成"同步消费者被拒绝"的假远程服务。
      if (options?.remote === true) {
        throw new Error(
          'ctx.provide 的 remote 标记由运行时写入（只有隔离进程里的提供者才会是 remote），插件不得自行设置。' +
            '若你的服务确实跑在隔离进程里，注册时宿主会自动标记；若想让消费者用异步面，请让消费者调用 ctx.async.useService（ADR-0019）。',
        )
      }
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
