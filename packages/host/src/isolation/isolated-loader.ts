import { fork, type ChildProcess } from 'node:child_process'
import type { CordisPlugin, Disposable, LogLevel, Permission, PluginContext } from '@vscordis/sdk'
import { PermissionDeniedError, ServiceRegistry, ServiceUnavailableError, describe, type LoadedPluginModule, type PluginEntry } from '@vscordis/kernel'
import type { EffectScopeApi } from '@vscordis/sdk'
import { PluginIntegrityError, verifyPluginArtifact } from '../integrity.ts'
import { buildExecArgv, toIsolatedPermissions, type ExecArgvPlan } from './permissions.ts'
import {
  PROTOCOL_VERSION,
  errorToWire,
  type ChildToHost,
  type HostToChild,
  type SerializedSaveEvent,
  type SerializedWorkspaceFolder,
} from './protocol.ts'

/**
 * 宿主侧的隔离加载器（M4b）。
 *
 * 它把"插件的生命周期"翻译成"子进程的生命周期"，并保证三件事：
 *
 * 1. **校验在 fork 之前**：先过完整性与签名，再启动进程。顺序颠倒等于没校验。
 * 2. **子进程的寿命挂在宿主 EffectStack 上**：`ctx.effect(() => session, s => s.kill())`。
 *    于是"卸载后无残留"对隔离插件有了更强的等价物 —— 不是"尽力清干净"，而是"进程没了"。
 * 3. **子进程一死就撤销所有宿主侧注册**：否则卸载后会留下幽灵命令
 *    （这正是 M1 验收标准「卸载后命令消失」在隔离模式下的翻版）。
 *
 * 本文件刻意**不 import `vscode`**：宿主能力全部通过注入的 `IsolatedHostApi` 获得。
 * 这样整条链路（真实子进程 + 真实 IPC + 真实 --permission 标志）都能用 node --test 端到端验证。
 */

export interface IsolatedHostApi {
  registerCommand(
    pluginId: string,
    command: string,
    invoke: (args: readonly unknown[]) => Promise<unknown>,
  ): Disposable
  unregisterCommand(command: string): void
  executeCommand(pluginId: string, command: string, args: readonly unknown[]): Promise<unknown>
  showMessage(
    kind: 'information' | 'warning' | 'error',
    message: string,
    items: readonly string[],
  ): Promise<string | undefined>
  createOutputChannel(pluginId: string, name: string): number
  appendOutputLine(handle: number, line: string): void
  disposeOutput(handle: number): void
  /**
   * 按插件在 `plugin.json#configuration` 里声明的键**预取**配置值。
   * 返回的键是**全限定名**（`section.key`），因为子进程无法可靠地拼出宿主侧的 section。
   */
  readConfiguration(pluginId: string, section: string, keys: readonly string[]): Promise<Readonly<Record<string, unknown>>>
  /** 订阅这些键的变化，用于把新值推给子进程（ADR-0016）。返回的 Disposable 在卸载时释放。 */
  onDidChangeConfiguration(
    pluginId: string,
    section: string,
    keys: readonly string[],
    listener: (values: Readonly<Record<string, unknown>>) => void,
  ): Disposable
  createStatusBarItem(
    pluginId: string,
    alignment: number,
    priority: number,
    initial: { readonly text: string },
  ): number
  updateStatusBarItem(
    handle: number,
    patch: {
      readonly text?: string
      readonly tooltip?: string
      readonly command?: string
      readonly color?: string
      readonly name?: string
      readonly accessibilityInformation?: unknown
    },
  ): void
  setStatusBarItemVisible(handle: number, visible: boolean): void
  disposeStatusBarItem(handle: number): void
  /**
   * 订阅真实的文档保存事件（ADR-0018）。
   *
   * 宿主负责把 `TextDocument` 转换成纯数据 + **文档句柄**：正文不随事件一起传
   * （大文件每次保存都整篇走 IPC 不可接受），而是等子进程按需用句柄来取。
   */
  subscribeSaveEvents(pluginId: string, forward: (payload: SerializedSaveEvent) => void): Disposable
  /** 按句柄读正文。句柄**有生命周期**且**按插件归属校验**；过期或越权都会给出明确错误。 */
  readDocumentText(pluginId: string, handle: number): Promise<string>
  workspaceFolders(): readonly SerializedWorkspaceFolder[]
  log(pluginId: string, level: LogLevel, message: string): void
}

export interface IsolatedLoaderOptions {
  readonly hostApi: IsolatedHostApi
  /**
   * 宿主的服务注册表。
   *
   * 隔离插件提供的服务要注册到这里（以 `remote: true` 的**异步代理**形态），
   * 这样依赖协调、级联暂停、依赖图快照才对它们一样有效（ADR-0019）。
   */
  readonly registry: ServiceRegistry
  /** 引导脚本的绝对路径（由 esbuild 打到 dist/isolated-worker.cjs）。 */
  readonly workerPath: string
  readonly publicKeyPem: string | undefined
  readonly readyTimeoutMs?: number
  readonly disposeTimeoutMs?: number
  readonly usePermissionModel?: boolean
  readonly onLog?: (message: string) => void
  /** 测试可注入，用来断言 execArgv 的推导结果。 */
  readonly execArgvFor?: (entry: PluginEntry, permissions: ReadonlySet<Permission>) => ExecArgvPlan
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

/**
 * 宿主侧为远程服务创建的实例：每个方法 → 一次到提供者子进程的调用。
 *
 * 只暴露方法表里声明过的名字。少了这一步，代理只能对任何属性都返回一个函数，
 * 于是 `clock.nwo()` 会变成一个"调用不存在的方法"的跨进程往返。
 */
function createRemoteServiceInstance(
  service: string,
  methods: readonly string[],
  call: (method: string, args: readonly unknown[]) => Promise<unknown>,
): object {
  const allowed = new Set(methods)
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string') return undefined
        // 同 child-bootstrap 里的理由：`await proxy` 会探测 `.then`，必须放行成 undefined，
        // 否则会被当成"调用了不存在的方法 then"。
        if (property === 'then') return undefined
        if (!allowed.has(property)) {
          throw new Error(
            `远程服务 "${service}" 没有方法 "${property}"。` +
              `提供者声明的方法：${methods.length === 0 ? '<无>' : methods.join(', ')}`,
          )
        }
        return (...args: unknown[]): Promise<unknown> => call(property, args)
      },
    },
  )
}

/** 隔离会话向外暴露的服务路由（由 loader 实现并注入）。 */
interface IsolatedServiceRouter {
  provide(pluginId: string, name: string, version: string | undefined, methods: readonly string[]): Disposable
  revoke(pluginId: string, name: string): void
  use(consumerId: string, name: string, effects: EffectScopeApi): readonly string[]
  invoke(name: string, method: string, args: readonly unknown[]): Promise<unknown>
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined
  let rejectFn: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

export class PluginIntegrityCheckError extends Error {
  constructor(pluginId: string, reason: string) {
    super(`插件 "${pluginId}" 未通过加载前校验：${reason}`)
    this.name = 'PluginIntegrityCheckError'
  }
}

export class IsolatedPluginLoader {
  readonly #options: IsolatedLoaderOptions
  /**
   * 活跃的隔离会话（pluginId → session）。
   *
   * 它是**泄漏诊断**的关键：子进程是否真的退出了，光看日志不可靠。
   * 有了它，浸泡测试可以直接断言 `activeSessions === 0`，
   * 状态面板也能显示"当前有几个子进程"，而不必去猜。
   */
  readonly #sessions = new Map<string, IsolatedSession>()
  /**
   * 服务名 → 提供者 id + 方法表（ADR-0019）。
   *
   * 方法表就是那份"IDL-lite"：有了它，消费者的代理才能对**不存在的方法**立刻报错，
   * 而不是把打字错误变成一个跨进程往返。
   */
  readonly #remoteServices = new Map<string, { providerId: string; methods: readonly string[] }>()
  readonly #router: IsolatedServiceRouter

  constructor(options: IsolatedLoaderOptions) {
    this.#options = options
    this.#router = {
      provide: (pluginId, name, version, methods) => this.#provideRemote(pluginId, name, version, methods),
      revoke: (pluginId, name) => this.#revokeRemote(pluginId, name),
      use: (consumerId, name, effects) => this.#useRemote(consumerId, name, effects),
      invoke: async (name, method, args) => await this.#invokeRemote(name, method, args),
    }
  }

  get registry(): ServiceRegistry {
    return this.#options.registry
  }

  /** 注册一个由隔离子进程提供的服务：注册表里放的是**宿主侧的异步代理**。 */
  #provideRemote(
    pluginId: string,
    name: string,
    version: string | undefined,
    methods: readonly string[],
  ): Disposable {
    this.#remoteServices.set(name, { providerId: pluginId, methods })
    const instance = createRemoteServiceInstance(name, methods, (method, args) =>
      this.#invokeRemote(name, method, args),
    )
    const handle = this.#options.registry.provide(pluginId, name, instance, {
      ...(version === undefined ? {} : { version }),
      remote: true,
    })
    let disposed = false
    return {
      dispose: (): void => {
        if (disposed) return
        disposed = true
        this.#remoteServices.delete(name)
        handle.dispose()
      },
    }
  }

  #revokeRemote(pluginId: string, name: string): void {
    const entry = this.#remoteServices.get(name)
    if (entry?.providerId !== pluginId) return
    this.#remoteServices.delete(name)
    this.#options.registry.revoke(pluginId, name)
  }

  /**
   * 隔离消费者取用服务：登记依赖边（这样提供者离开会被级联暂停），并返回方法表。
   *
   * 同进程插件提供的服务在这里**明确拒绝** —— 活对象过不了进程边界，
   * 而"给个会抛错的假代理"只会把问题推到运行时。
   */
  #useRemote(consumerId: string, name: string, effects: EffectScopeApi): readonly string[] {
    const info = this.#options.registry.providerInfo(name)
    if (info === undefined) throw new ServiceUnavailableError(name)
    if (!info.remote) {
      throw new Error(
        `服务 "${name}" 由**同进程**插件 "${info.owner}" 提供，隔离插件无法取用（活对象过不了进程边界）。\n` +
          '两个选择：把提供者也改成 trust: untrusted，或让消费者改用 trust: trusted。',
      )
    }
    const edge = this.#options.registry.depend(consumerId, name, 'hard')
    effects.add(() => edge.dispose(), `depend:async:${name}`)
    return this.#remoteServices.get(name)?.methods ?? []
  }

  async #invokeRemote(name: string, method: string, args: readonly unknown[]): Promise<unknown> {
    const entry = this.#remoteServices.get(name)
    if (entry === undefined) throw new Error(`远程服务 "${name}" 已不可用（提供者可能已卸载）`)
    const session = this.#sessions.get(entry.providerId)
    if (session === undefined) {
      throw new Error(`远程服务 "${name}" 的提供者插件 "${entry.providerId}" 当前不在运行中`)
    }
    return await session.invokeServiceMethod(name, method, args)
  }

  get activeSessions(): number {
    return this.#sessions.size
  }

  activeSessionIds(): readonly string[] {
    return [...this.#sessions.keys()]
  }

  async load(entry: PluginEntry): Promise<LoadedPluginModule> {
    const pluginId = entry.manifest.id
    const permissions = new Set<Permission>(entry.manifest.permissions as readonly Permission[])

    // 1) 校验必须在 fork 之前 —— 否则不可信代码已经跑起来了。
    const outcome = verifyPluginArtifact({
      root: entry.root,
      publicKeyPem: this.#options.publicKeyPem,
      requireSignature: entry.source === 'global',
    })
    if (!outcome.ok) throw new PluginIntegrityError(pluginId, outcome.reason)

    const plan = this.#options.execArgvFor?.(entry, permissions) ??
      buildExecArgv({
        workerPath: this.#options.workerPath,
        pluginRoot: entry.root,
        permissions,
        ...(this.#options.usePermissionModel === undefined
          ? {}
          : { usePermissionModel: this.#options.usePermissionModel }),
      })
    for (const warning of plan.warnings) this.#log(`[${pluginId}] ${warning}`)

    const ref: { session: IsolatedSession | undefined } = { session: undefined }

    const plugin: CordisPlugin = {
      name: pluginId,
      activate: async (ctx: PluginContext): Promise<void> => {
        const session = new IsolatedSession({
          entry,
          plan,
          hostApi: this.#options.hostApi,
          services: this.#router,
          workerPath: this.#options.workerPath,
          readyTimeoutMs: this.#options.readyTimeoutMs ?? 10_000,
          disposeTimeoutMs: this.#options.disposeTimeoutMs ?? 2_000,
          log: (message) => this.#log(message),
        })
        ref.session = session
        // 记账：子进程退出（无论是优雅停用还是被 kill）就把它从活跃表里摘掉。
        this.#sessions.set(pluginId, session)
        void session.waitForExit().then(() => {
          if (this.#sessions.get(pluginId) === session) this.#sessions.delete(pluginId)
        })
        // 必须在 start() **之前**交棒：子进程在 activate 期间就可能调用
        // `ctx.async.useService`，而它需要在宿主的 EffectStack 上登记依赖边。
        session.attachHostEffects(ctx.effects)
        try {
          await session.start()
        } catch (error) {
          session.kill()
          ref.session = undefined
          throw error
        }
        // 2) 子进程的寿命 = 宿主侧的一项副作用。
        //    即使插件本身没有登记任何 effect，卸载时也一定会走到 kill。
        ctx.effect(() => session, (current) => {
          current.kill()
        }, `isolated-child:${pluginId}`)
      },
      deactivate: async (): Promise<void> => {
        const session = ref.session
        ref.session = undefined
        await session?.shutdown()
      },
    }

    return {
      plugin,
      release: (): void => {
        const session = ref.session
        ref.session = undefined
        session?.kill()
        this.#log(`[${pluginId}] 隔离会话已释放`)
      },
    }
  }

  #log(message: string): void {
    this.#options.onLog?.(message)
  }
}

interface SessionOptions {
  readonly entry: PluginEntry
  readonly plan: ExecArgvPlan
  readonly hostApi: IsolatedHostApi
  readonly services: IsolatedServiceRouter
  readonly workerPath: string
  readonly readyTimeoutMs: number
  readonly disposeTimeoutMs: number
  readonly log: (message: string) => void
}

class IsolatedSession {
  readonly #options: SessionOptions
  readonly #pluginId: string
  readonly #ready = deferred<void>()
  readonly #activated = deferred<void>()
  readonly #deactivated = deferred<void>()
  readonly #invokes = new Map<number, Deferred<unknown>>()
  readonly #commandHandles = new Map<string, Disposable>()
  readonly #outputHandles = new Set<number>()
  readonly #statusBarHandles = new Set<number>()
  readonly #eventSubscriptions = new Map<number, Disposable>()
  readonly #providedServiceDisposables = new Map<string, Disposable>()
  readonly #serviceInvokes = new Map<number, Deferred<unknown>>()
  #hostEffects: EffectScopeApi | undefined
  #serviceRequestSeq = 0
  #eventSeq = 0
  #configSubscription: Disposable | undefined
  #child: ChildProcess | undefined
  /**
   * 子进程退出信号。
   *
   * ⚠️ 这里**必须**是"字段初始化时就存在的 deferred"，而不能在 `start()` 里才赋值 Promise：
   * loader 会在 `start()` **之前**登记会话并调用 `waitForExit()`，
   * 那时若拿到一个初始的已 resolve 的 Promise，`.then` 会立刻执行 —— 会话被误删，
   * 于是"活跃会话数"永远是 0。
   * 这不是假想：M4b 的浸泡测试曾因此一直是**假绿**（它测的不是"没有泄漏"，
   * 而是"记账根本没生效"）。ADR-0019 里记了这一笔。
   */
  readonly #exited = deferred<void>()
  #requestSeq = 0
  #closed = false

  constructor(options: SessionOptions) {
    this.#options = options
    this.#pluginId = options.entry.manifest.id
  }

  get pluginId(): string {
    return this.#pluginId
  }

  /**
   * 把宿主侧的 EffectStack 交给会话。
   *
   * 用途只有一个但很关键：隔离消费者调用 `ctx.async.useService` 时，
   * 依赖边必须登记在**宿主**的注册表上、并挂在宿主的 EffectStack 上 ——
   * 这样"提供者卸载 → 消费者 paused"的级联才对隔离插件一样有效。
   */
  attachHostEffects(effects: EffectScopeApi): void {
    this.#hostEffects = effects
  }

  /** 宿主反向请求：在本会话的子进程里执行一次服务方法调用。 */
  async invokeServiceMethod(service: string, method: string, args: readonly unknown[]): Promise<unknown> {
    if (!this.alive) {
      throw new Error(`插件 ${this.#pluginId} 的子进程已退出，无法调用 ${service}.${method}()`)
    }
    const requestId = ++this.#serviceRequestSeq
    const pending = deferred<unknown>()
    this.#serviceInvokes.set(requestId, pending)
    this.#send({ kind: 'invokeService', requestId, service, method, args })
    return await pending.promise
  }

  get pid(): number | undefined {
    return this.#child?.pid
  }

  get alive(): boolean {
    const child = this.#child
    if (child === undefined) return false
    // 注意不能用 exitCode === null 单独判断：被信号杀掉时 exitCode 仍是 null，signalCode 才有值。
    return child.exitCode === null && child.signalCode === null
  }

  async start(): Promise<void> {
    const child = fork(this.#options.workerPath, [], {
      execArgv: [...this.#options.plan.execArgv],
      // VSCode 宿主跑在 Electron 里：不设这个变量，fork 会去启动一个完整的 Electron 应用而不是 Node。
      // 在纯 Node 下它是无害的。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // structured clone：至少能保住 undefined / Date / Map / Set（默认的 JSON 序列化会丢）
      serialization: 'advanced',
      silent: true,
      cwd: this.#options.entry.root,
    })
    this.#child = child

    child.stdout?.on('data', (chunk: Buffer) => this.#options.log(`[${this.#pluginId}] ${chunk.toString().trimEnd()}`))
    child.stderr?.on('data', (chunk: Buffer) =>
      this.#options.log(`[${this.#pluginId}] [stderr] ${chunk.toString().trimEnd()}`),
    )
    child.on('message', (message: unknown) => {
      this.#handle(message as ChildToHost)
    })
    child.on('error', (error: Error) => {
      this.#failAll(`子进程错误：${errorToWire(error)}`)
    })

    this.#exited.promise.catch(() => undefined)
    child.on('exit', (code, signal) => {
      this.#cleanupHostSide()
      const detail = `退出码 ${code ?? 'null'} / 信号 ${signal ?? 'none'}`
      if (!this.#closed) this.#options.log(`[${this.#pluginId}] 子进程退出（${detail}）`)
      this.#deactivated.resolve()
      this.#exited.resolve()
    })

    await withTimeout(this.#ready.promise, this.#options.readyTimeoutMs, `等待子进程就绪（${this.#pluginId}）`)

    // 配置快照：按下 plugin.json 的 configuration 声明预取。
    // 没有声明就是空对象 —— 子进程读到未声明的键只会拿默认值并告警（ADR-0016）。
    const configuration = this.#options.entry.manifest.configuration
    const configSnapshot =
      configuration === undefined
        ? {}
        : await this.#options.hostApi.readConfiguration(this.#pluginId, configuration.section, configuration.keys)

    this.#send({
      kind: 'activate',
      protocolVersion: PROTOCOL_VERSION,
      pluginId: this.#pluginId,
      pluginEntry: this.#options.entry.mainPath,
      permissions: toIsolatedPermissions(new Set(this.#options.entry.manifest.permissions as readonly Permission[])),
      workspaceFolders: this.#options.hostApi.workspaceFolders(),
      configSnapshot,
      disposeTimeoutMs: this.#options.disposeTimeoutMs,
    })

    if (configuration !== undefined) {
      // 配置变化时主动推送：这样插件侧的 get() 既能保持同步，又不会读到陈旧值。
      this.#configSubscription = this.#options.hostApi.onDidChangeConfiguration(
        this.#pluginId,
        configuration.section,
        configuration.keys,
        (values) => {
          this.#send({ kind: 'configChanged', values })
        },
      )
    }

    await withTimeout(this.#activated.promise, this.#options.readyTimeoutMs, `等待插件激活（${this.#pluginId}）`)
  }

  /** 反向调用：宿主执行命令时，请求子进程里的 handler 求值。 */
  async invokeCommand(command: string, args: readonly unknown[]): Promise<unknown> {
    if (!this.alive) throw new Error(`插件 ${this.#pluginId} 的子进程已退出，无法执行 ${command}`)
    const requestId = ++this.#requestSeq
    const pending = deferred<unknown>()
    this.#invokes.set(requestId, pending)
    this.#send({ kind: 'invoke', requestId, command, args })
    return await pending.promise
  }

  /** 优雅停用：让子进程自己收尾并 LIFO 回收副作用，超时后由 kill 兜底。 */
  async shutdown(): Promise<void> {
    if (!this.alive) return
    this.#closed = true
    this.#send({ kind: 'deactivate' })
    try {
      await withTimeout(this.#deactivated.promise, this.#options.disposeTimeoutMs, `等待插件停用（${this.#pluginId}）`)
    } catch (error) {
      this.#options.log(`[${this.#pluginId}] 优雅停用失败，改用强制终止：${errorToWire(error)}`)
      this.kill()
    }
  }

  /** 强制终止。幂等。 */
  kill(): void {
    this.#closed = true
    this.#cleanupHostSide()
    const child = this.#child
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGKILL')
    }
    this.#failAll(`插件 ${this.#pluginId} 的隔离会话已终止`)
  }

  async waitForExit(): Promise<void> {
    await this.#exited.promise
  }

  // ————————————————————————————————— 内部

  #send(message: HostToChild): void {
    try {
      this.#child?.send(message)
    } catch (error) {
      this.#options.log(`[${this.#pluginId}] 向子进程发送消息失败：${errorToWire(error)}`)
    }
  }

  #handle(message: ChildToHost): void {
    switch (message.kind) {
      case 'ready':
        this.#ready.resolve()
        break
      case 'activated':
        this.#activated.resolve()
        break
      case 'deactivated':
        this.#deactivated.resolve()
        break
      case 'failed':
        this.#activated.reject(new Error(message.error))
        this.#ready.resolve()
        break
      case 'log':
        this.#options.hostApi.log(this.#pluginId, message.level, message.message)
        break
      case 'call':
        void this.#handleCall(message)
        break
      case 'result': {
        const pending = this.#invokes.get(message.requestId)
        if (pending === undefined) return
        this.#invokes.delete(message.requestId)
        if (message.ok) pending.resolve(message.value)
        else pending.reject(new Error(message.error))
        break
      }
      case 'serviceResult': {
        const pending = this.#serviceInvokes.get(message.requestId)
        if (pending === undefined) return
        this.#serviceInvokes.delete(message.requestId)
        if (message.ok) pending.resolve(message.value)
        else pending.reject(new Error(message.error))
        break
      }
    }
  }

  async #handleCall(call: Extract<ChildToHost, { kind: 'call' }>): Promise<void> {
    const pluginId = this.#pluginId
    const granted = new Set<Permission>(this.#options.entry.manifest.permissions as readonly Permission[])

    const require = (...candidates: Permission[]): void => {
      if (candidates.some((candidate) => granted.has(candidate))) return
      // 宿主侧鉴权是**权威**的：绝不因为"子进程说自己有权限"就放行。
      throw new PermissionDeniedError(pluginId, candidates.join(' 或 '), String(call.method))
    }

    try {
      switch (call.method) {
        case 'commands.registerCommand': {
          require('vscode:commands.register')
          const command = String(call.args[0] ?? '')
          const handle = this.#options.hostApi.registerCommand(pluginId, command, (args) =>
            this.invokeCommand(command, args),
          )
          this.#commandHandles.set(command, handle)
          this.#reply(call.id, undefined)
          break
        }
        case 'commands.unregisterCommand': {
          // 撤销不做权限校验：否则权限被回收后旧命令会永远摘不掉。
          const command = String(call.args[0] ?? '')
          this.#commandHandles.get(command)?.dispose()
          this.#commandHandles.delete(command)
          this.#options.hostApi.unregisterCommand(command)
          this.#reply(call.id, undefined)
          break
        }
        case 'commands.executeCommand': {
          require('vscode:commands.execute', 'vscode:commands.execute.any')
          const command = String(call.args[0] ?? '')
          const args = Array.isArray(call.args[1]) ? (call.args[1] as unknown[]) : []
          this.#reply(call.id, await this.#options.hostApi.executeCommand(pluginId, command, args))
          break
        }
        case 'window.showInformationMessage':
        case 'window.showWarningMessage':
        case 'window.showErrorMessage': {
          require('vscode:window.messages')
          const kind =
            call.method === 'window.showInformationMessage'
              ? 'information'
              : call.method === 'window.showWarningMessage'
                ? 'warning'
                : 'error'
          this.#reply(call.id, await this.#options.hostApi.showMessage(kind, String(call.args[0] ?? ''), []))
          break
        }
        case 'window.createOutputChannel': {
          require('vscode:window.output')
          const handle = this.#options.hostApi.createOutputChannel(pluginId, String(call.args[0] ?? pluginId))
          this.#outputHandles.add(handle)
          this.#reply(call.id, { handle })
          break
        }
        case 'output.appendLine': {
          require('vscode:window.output')
          const handle = Number(call.args[0])
          if (!this.#outputHandles.has(handle)) throw new Error(`未知的输出通道句柄：${handle}`)
          this.#options.hostApi.appendOutputLine(handle, String(call.args[1] ?? ''))
          this.#reply(call.id, undefined)
          break
        }
        case 'output.dispose': {
          require('vscode:window.output')
          const handle = Number(call.args[0])
          if (this.#outputHandles.delete(handle)) this.#options.hostApi.disposeOutput(handle)
          this.#reply(call.id, undefined)
          break
        }
        case 'statusBar.create': {
          require('vscode:window.statusbar')
          const alignment = Number(call.args[0] ?? 0)
          const priority = Number(call.args[1] ?? 0)
          const initial = (call.args[2] ?? { text: '' }) as { text?: string }
          const handle = this.#options.hostApi.createStatusBarItem(pluginId, alignment, priority, {
            text: String(initial.text ?? ''),
          })
          this.#statusBarHandles.add(handle)
          this.#reply(call.id, { handle })
          break
        }
        case 'statusBar.update': {
          require('vscode:window.statusbar')
          const handle = Number(call.args[0])
          if (!this.#statusBarHandles.has(handle)) throw new Error(`未知的状态栏项句柄：${handle}`)
          const raw = (call.args[1] ?? {}) as Record<string, unknown>
          const patch: {
            text?: string
            tooltip?: string
            command?: string
            color?: string
            name?: string
            accessibilityInformation?: unknown
          } = {}
          if (typeof raw.text === 'string') patch.text = raw.text
          if (typeof raw.tooltip === 'string') patch.tooltip = raw.tooltip
          if (typeof raw.command === 'string') patch.command = raw.command
          if (typeof raw.color === 'string') patch.color = raw.color
          if (typeof raw.name === 'string') patch.name = raw.name
          if ('accessibilityInformation' in raw) patch.accessibilityInformation = raw.accessibilityInformation
          this.#options.hostApi.updateStatusBarItem(handle, patch)
          this.#reply(call.id, undefined)
          break
        }
        case 'statusBar.setVisible': {
          require('vscode:window.statusbar')
          const handle = Number(call.args[0])
          if (!this.#statusBarHandles.has(handle)) throw new Error(`未知的状态栏项句柄：${handle}`)
          this.#options.hostApi.setStatusBarItemVisible(handle, Boolean(call.args[1]))
          this.#reply(call.id, undefined)
          break
        }
        case 'statusBar.dispose': {
          require('vscode:window.statusbar')
          const handle = Number(call.args[0])
          if (this.#statusBarHandles.delete(handle)) this.#options.hostApi.disposeStatusBarItem(handle)
          this.#reply(call.id, undefined)
          break
        }
        case 'events.onDidSaveTextDocument': {
          // 事件订阅读的是工作区内容，所以归到 workspace.read 权限下。
          require('vscode:workspace.read')
          const subscriptionId = ++this.#eventSeq
          const disposable = this.#options.hostApi.subscribeSaveEvents(pluginId, (payload) => {
            this.#send({ kind: 'event', subscription: subscriptionId, payload })
          })
          this.#eventSubscriptions.set(subscriptionId, disposable)
          this.#reply(call.id, { subscription: subscriptionId })
          break
        }
        case 'events.unsubscribe': {
          const subscriptionId = Number(call.args[0])
          this.#eventSubscriptions.get(subscriptionId)?.dispose()
          this.#eventSubscriptions.delete(subscriptionId)
          this.#reply(call.id, undefined)
          break
        }
        case 'document.getText': {
          require('vscode:workspace.read')
          this.#reply(call.id, await this.#options.hostApi.readDocumentText(pluginId, Number(call.args[0])))
          break
        }
        case 'services.provide': {
          const name = String(call.args[0] ?? '')
          const rawVersion = call.args[1]
          const version = rawVersion === null || rawVersion === undefined ? undefined : String(rawVersion)
          const methods = Array.isArray(call.args[2]) ? (call.args[2] as unknown[]).map((item) => String(item)) : []
          const disposable = this.#options.services.provide(this.#pluginId, name, version, methods)
          this.#providedServiceDisposables.set(name, disposable)
          this.#reply(call.id, undefined)
          break
        }
        case 'services.revoke': {
          const name = String(call.args[0] ?? '')
          this.#providedServiceDisposables.get(name)?.dispose()
          this.#providedServiceDisposables.delete(name)
          this.#reply(call.id, undefined)
          break
        }
        case 'services.use': {
          const name = String(call.args[0] ?? '')
          const effects = this.#hostEffects
          if (effects === undefined) {
            throw new Error('宿主上下文尚未就绪，无法为 ctx.async.useService 登记依赖边')
          }
          const methods = this.#options.services.use(this.#pluginId, name, effects)
          this.#reply(call.id, { methods })
          break
        }
        case 'services.invoke': {
          const name = String(call.args[0] ?? '')
          const method = String(call.args[1] ?? '')
          const args = Array.isArray(call.args[2]) ? (call.args[2] as unknown[]) : []
          this.#reply(call.id, await this.#options.services.invoke(name, method, args))
          break
        }
        case 'log': {
          this.#options.hostApi.log(pluginId, 'info', String(call.args[0] ?? ''))
          this.#reply(call.id, undefined)
          break
        }
      }
    } catch (error) {
      this.#replyError(call.id, errorToWire(error))
    }
  }

  #reply(id: number, value: unknown): void {
    this.#send({ kind: 'response', id, ok: true, value })
  }

  #replyError(id: number, error: string): void {
    this.#send({ kind: 'response', id, ok: false, error })
  }

  /**
   * 子进程退出/被杀时，撤销**所有**宿主侧注册。
   * 少了这一步，卸载后命令面板代理里会残留幽灵命令 —— 与 M1 那条验收标准同源。
   */
  /**
   * 子进程退出/被杀时，撤销**所有**宿主侧注册。少了这一步，卸载后会留下幽灵命令 ——
   * 与 M1 那条验收标准同源。服务同理：注册表里的条目不清，消费者会拿到一个
   * 指向死进程的代理（调用时报错时机还很晚）。
   */
  #cleanupHostSide(): void {
    for (const [, disposable] of this.#providedServiceDisposables) {
      try {
        disposable.dispose()
      } catch {
        // 撤销失败不应影响其余清理
      }
    }
    this.#providedServiceDisposables.clear()

    for (const [, handle] of this.#commandHandles) {
      try {
        handle.dispose()
      } catch {
        // 撤销失败不应影响其余清理
      }
    }
    this.#commandHandles.clear()

    for (const handle of this.#outputHandles) {
      try {
        this.#options.hostApi.disposeOutput(handle)
      } catch {
        // 同上
      }
    }
    this.#outputHandles.clear()

    // 状态栏项也必须回收：子进程没了而状态栏还挂着，就是一块点不动的僵尸 UI。
    for (const handle of this.#statusBarHandles) {
      try {
        this.#options.hostApi.disposeStatusBarItem(handle)
      } catch {
        // 同上
      }
    }
    this.#statusBarHandles.clear()

    // 事件订阅同理：子进程没了而宿主还在监听文档保存，就是白跑 + 事件发进黑洞。
    for (const [, subscription] of this.#eventSubscriptions) {
      try {
        subscription.dispose()
      } catch {
        // 同上
      }
    }
    this.#eventSubscriptions.clear()

    // 配置订阅同理：不摘掉的话，插件卸载后宿主还在为一个不存在的进程准备推送。
    try {
      this.#configSubscription?.dispose()
    } catch {
      // 同上
    }
    this.#configSubscription = undefined
  }

  #failAll(reason: string): void {
    for (const [, pending] of this.#invokes) pending.reject(new Error(reason))
    this.#invokes.clear()
    // 在途的服务调用也必须一起失败：否则消费者会永远等一个已经死掉的进程。
    for (const [, pending] of this.#serviceInvokes) pending.reject(new Error(reason))
    this.#serviceInvokes.clear()
  }
}

export async function withTimeout<T>(value: T | Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} 超时（>${ms}ms）`))
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
