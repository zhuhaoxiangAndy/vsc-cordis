/**
 * PluginContext —— 插件能看到的**全部**世界。
 *
 * 设计要点（与原始接口草案的差异已在 ADR 中记录）：
 *
 * 1. `ctx.vscode` **不是** `typeof import('vscode')`，而是一个权限代理的子集类型（ADR-0003/0005）。
 *    原草案会一次性开放 `commands.executeCommand` / `env.openExternal` / `workspace.fs`，
 *    与"插件无法直接访问未授权的 VSCode API"这条验收标准直接冲突。
 *
 * 2. 依赖声明拆成三个明确的动词，而不是一个返回 `T | undefined` 的 getter：
 *    - `use(name)`     硬依赖：缺失即抛错，会级联（提供者消失 → 本插件 pause）
 *    - `tryUse(name)`  软依赖：缺失返回 undefined，**不级联**（可选增强）
 *    - `provide(name)` 提供服务：返回 Disposable，并自动登记到本插件的 EffectStack
 *    理由：同步 getter 会把"谁依赖谁"这条信息从注册表里抹掉，运行时也就无法协调。
 *    （cordis 的 `ctx.inject(deps, cb)` 形式确认见 ADR-0004/0007，本项目 v1 采用插件级 PAUSE。）
 *
 * 3. `effect` 的 `register` 必须是**同步**函数（ADR-0004 I2/I4），异步场景用 `effectAsync`。
 */
import type { Disposable, MaybePromise, Teardown } from './disposable.ts'
import type { Logger } from './logger.ts'
import type { PluginManifest } from './manifest.ts'
import type { Permission } from './permission.ts'
import type { PluginVscodeApi } from './vscode-api.ts'

export type PluginId = string
export type ServiceName = string

export interface ProvideOptions {
  /** 默认 `exclusive`：同名第二个提供者直接抛错（ADR-0007）。 */
  readonly conflict?: 'exclusive' | 'last-wins'
  /** 服务版本，用于满足消费者的 `dependencies` 版本范围。 */
  readonly version?: string
  /**
   * 声明该服务位于**独立进程**：消费者不能用 `ctx.use` 同步取用，只能用 `ctx.async.useService`。
   * 隔离模式由宿主自动置位；同进程插件一般不需要关心它。
   */
  readonly remote?: boolean
}

/**
 * 异步服务的形状：**只保留方法**，且每个方法都返回 Promise。
 *
 * 非方法属性映射成 `never` —— 这是刻意的：跨进程传不了活对象，
 * 让它在**编译期**就不可用，而不是运行时给出 undefined。
 */
export type AsyncService<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never
}

export type DependencyKind = 'hard' | 'soft'

/** 直接操作副作用栈的逃生口；`ctx.effect` 等方法都是它的薄封装。 */
export interface EffectScopeApi {
  readonly size: number
  readonly closed: boolean
  add(teardown: Teardown, label?: string): Disposable
  effect<T>(register: () => T, dispose: (resource: T) => void | Promise<void>, label?: string): T
  effectAsync<T>(
    register: () => Promise<T>,
    dispose: (resource: T) => void | Promise<void>,
    label?: string,
  ): Promise<T>
  scope(label?: string): EffectScopeApi
  dispose(): Promise<void>
}

export interface DependencyEdgeView {
  readonly consumer: PluginId
  readonly service: ServiceName
  readonly kind: DependencyKind
  readonly range?: string
}

export interface ServiceView {
  readonly name: ServiceName
  readonly provider?: {
    readonly owner: PluginId
    readonly version?: string
    readonly generation: number
    /** 提供者位于独立进程：只能用 `ctx.async.useService` 取用（ADR-0019）。 */
    readonly remote?: boolean
  }
  readonly consumers: readonly { readonly owner: PluginId; readonly kind: DependencyKind }[]
}

export interface DependencyGraphSnapshot {
  readonly edges: readonly DependencyEdgeView[]
  readonly services: readonly ServiceView[]
}

/**
 * 异步面上的文本文档：**纯数据快照** + 显式异步的正文读取器。
 *
 * 为什么不是 `TextDocument`：它的 `getText()` 是同步返回的，
 * 而隔离模式下正文只能跨进程按需取。给一个"类型上同步、实际上跨进程"的接口
 * 会让插件在运行时才发现语义不同 —— 所以这里**在类型上就是异步的**。
 */
export interface AsyncTextDocument {
  readonly uri: string
  readonly fsPath: string
  readonly languageId: string
  readonly lineCount: number
  readonly version: number
  /** 显式异步。同进程模式下它就是一个已 resolve 的 Promise 包装。 */
  getText(): Promise<string>
}

/**
 * **显式异步面**：两种执行模式都提供，签名完全一致。
 *
 * 这是 ADR-0016 里那个矛盾的解法：与其给隔离模式伪造一套"看起来同步"的 API，
 * 不如把跨进程无法同步的能力单独放在一个**类型上就写着异步**的面上，
 * 并让同进程模式也实现同一份签名 —— 于是插件代码不需要按模式分支，
 * 也不会在运行时撞上语义差异。
 */
export interface AsyncApi {
  /**
   * 订阅文档保存事件。
   *
   * 返回 `Promise<Disposable>` 而不是 `Disposable`：隔离模式下订阅要跨进程建立。
   * 同进程模式下它立刻 resolve，但**签名保持一致**。
   */
  onDidSaveTextDocument(listener: (document: AsyncTextDocument) => void): Promise<Disposable>
  /**
   * 取用一个服务，返回**方法全异步**的代理（ADR-0019）。
   *
   * 两种模式都能用，且签名一致 —— 服务在本进程时，代理只是把返回值包一层 Promise。
   * 这是一个**硬依赖**：提供者离开时，本插件会被 `paused`（与 `ctx.use` 一致）。
   */
  useService<T>(name: ServiceName): Promise<AsyncService<T>>
}

export interface PluginContext {
  readonly id: PluginId
  readonly manifest: PluginManifest
  /** 卸载信号：插件应在长任务中主动监听它并尽快退出（ADR-0007 决策 6 / 2s 强制回收）。 */
  readonly signal: AbortSignal
  readonly log: Logger
  readonly permissions: ReadonlySet<Permission>
  readonly vscode: PluginVscodeApi
  /** 显式异步面，见 `AsyncApi`。两种模式都有，签名一致。 */
  readonly async: AsyncApi

  // —— 时间可组合性 ——
  effect<T>(register: () => T, dispose: (resource: T) => void | Promise<void>, label?: string): T
  effectAsync<T>(
    register: () => Promise<T>,
    dispose: (resource: T) => void | Promise<void>,
    label?: string,
  ): Promise<T>
  /** 派生子上下文：其 effect 可单独回收，父上下文卸载时一并回收。 */
  scope(label?: string): PluginContext
  readonly effects: EffectScopeApi

  // —— 空间可组合性 ——
  use<T>(name: ServiceName): T
  tryUse<T>(name: ServiceName): T | undefined
  provide<T>(name: ServiceName, service: T, options?: ProvideOptions): Disposable
  graph(): DependencyGraphSnapshot

  /** 供宿主内部（如命令注册桥）登记"必须随插件回收"的清理动作。 */
  readonly onDispose: (teardown: Teardown, label?: string) => Disposable
}

export type PluginActivate = (ctx: PluginContext) => MaybePromise<void>
