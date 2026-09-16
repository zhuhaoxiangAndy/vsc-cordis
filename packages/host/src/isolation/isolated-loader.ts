import { fork, type ChildProcess } from 'node:child_process'
import type { CordisPlugin, Disposable, LogLevel, Permission, PluginContext } from '@vscordis/sdk'
import { PermissionDeniedError, ServiceRegistry, ServiceUnavailableError, describe, type LoadedPluginModule, type PluginEntry } from '@vscordis/kernel'
import type { EffectScopeApi } from '@vscordis/sdk'
import { PluginIntegrityError, verifyPluginArtifact } from '../integrity.ts'
import { assertNoEscapingReparsePoints } from '../paths.ts'
import { buildIsolatedChildEnv } from './environment.ts'
import { buildExecArgv, toIsolatedPermissions, type ExecArgvPlan } from './permissions.ts'
import {
  PROTOCOL_VERSION,
  assertCloneableArgs,
  assertCloneableCommandArgs,
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
  /**
   * 订阅活动编辑器变化（ADR-0018 扩展）。
   * `forward(undefined)` 表示"事件发生了，但当前没有活动编辑器"——必须原样转发。
   */
  subscribeActiveEditorChanges(
    pluginId: string,
    forward: (payload: SerializedSaveEvent | undefined) => void,
  ): Disposable
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
  /**
   * 整栈回收总预算（毫秒）；`0`/缺省 = 不设预算。
   * 必须与 `PluginHost.disposeBudgetMs` 用同一个配置值 —— 否则同进程与隔离两种模式的
   * "卸载最坏耗时"会不一致，而这是 ADR-0015 明确要消除的东西。
   */
  readonly disposeBudgetMs?: number
  readonly usePermissionModel?: boolean
  /**
   * 隔离子进程是否继承宿主的完整环境变量（ADR-0021）。
   * 默认 `false`：只传系统启动所需的白名单，避免把 token/代理凭据/agent socket 等
   * 暴露给 untrusted 插件。显式设为 `true` 才完整继承，并会在日志里给出降级警告。
   */
  readonly inheritEnv?: boolean
  readonly onLog?: (message: string) => void
  /**
   * 子进程在**激活成功后**异常退出时的回调（宿主主动 kill / 优雅停用不触发）。
   * 宿主用它把 `PluginHost` 记录标成 `failed`，避免"进程已死但状态面板仍显示 active"
   * （ADR-0015：失败必须可见）。
   */
  readonly onUnexpectedExit?: (pluginId: string, error: Error) => void
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
        return async (...args: unknown[]): Promise<unknown> => {
          // 前置校验：错误必须出现在**调用点**，而不是 IPC 层的 DataCloneError（ADR-0019）。
          assertCloneableArgs(service, property, args)
          return await call(property, args)
        }
      },
    },
  )
}

/** 隔离会话向外暴露的服务路由（由 loader 实现并注入）。 */
interface IsolatedServiceRouter {
  provide(
    pluginId: string,
    name: string,
    version: string | undefined,
    methods: readonly string[],
    conflict: 'exclusive' | 'last-wins',
  ): Disposable
  revoke(pluginId: string, name: string): void
  /** 取用并返回方法表 + **代际 token**（客户端调用时必须带回，见 #invokeRemote）。 */
  use(
    consumerId: string,
    name: string,
    effects: EffectScopeApi,
  ): { readonly methods: readonly string[]; readonly token: number | undefined }
  invoke(name: string, method: string, args: readonly unknown[], token: number | undefined): Promise<unknown>
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

/**
 * 子进程消息的第一道门：只接受“非 null 对象 + 已知 kind”。
 *
 * 子进程由第三方插件代码控制，`process.send(null)` 或任意对象都会到达宿主的 message
 * 事件；直接读 `message.kind` 会把 TypeError 抛进宿主事件循环，等于给 untrusted 插件
 * 一个 DoS。这里做结构校验，`#handle` 外层再包 try/catch，畸形消息只失败该会话。
 */
const CHILD_MESSAGE_KINDS = new Set<string>([
  'ready',
  'activated',
  'deactivated',
  'failed',
  'log',
  'call',
  'result',
  'serviceResult',
])

function isChildToHost(message: unknown): message is ChildToHost {
  if (message === null || typeof message !== 'object') return false
  const kind = (message as { kind?: unknown }).kind
  return typeof kind === 'string' && CHILD_MESSAGE_KINDS.has(kind)
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
  /** 累计创建过的会话数（单调递增，见 `sessionsStarted`）。 */
  #sessionsStarted = 0
  /**
   * 服务名 → 当前提供者（id + 方法表 + **代际 token**）。
   *
   * 方法表就是那份"IDL-lite"：有了它，消费者的代理才能对**不存在的方法**立刻报错，
   * 而不是把打字错误变成一个跨进程往返。
   *
   * `token` 每次 `provide` 自增：代理在创建时锚定它，调用时比对 ——
   * last-wins 换人后，**过期代理必须响亮失败**而不是静默把调用路由到新提供者
   * （ADR-0019："提供者换了人"是用户看得见的事件，不能藏起来）。
   */
  readonly #remoteServices = new Map<
    string,
    { providerId: string; methods: readonly string[]; token: number }
  >()
  /** 服务代际序号：每注册一代提供者 +1。 */
  #serviceTokenSeq = 0
  readonly #router: IsolatedServiceRouter

  constructor(options: IsolatedLoaderOptions) {
    this.#options = options
    this.#router = {
      provide: (pluginId, name, version, methods, conflict) =>
        this.#provideRemote(pluginId, name, version, methods, conflict),
      revoke: (pluginId, name) => this.#revokeRemote(pluginId, name),
      use: (consumerId, name, effects) => this.#useRemote(consumerId, name, effects),
      invoke: async (name, method, args, token) => await this.#invokeRemote(name, method, args, token),
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
    conflict: 'exclusive' | 'last-wins',
  ): Disposable {
    const token = ++this.#serviceTokenSeq
    const instance = createRemoteServiceInstance(name, methods, (method, args) =>
      this.#invokeRemote(name, method, args, token),
    )
    const handle = this.#options.registry.provide(pluginId, name, instance, {
      ...(version === undefined ? {} : { version }),
      // 冲突策略必须跨进程传过来（ADR-0019）：丢掉它的话，隔离插件写
      // `conflict: 'last-wins'` 会被静默当成 exclusive —— 又一个"声明了却不生效"。
      conflict,
      remote: true,
    })
    // 只有注册**成功**后才更新路由表：否则 exclusive 冲突抛错时，路由会指向一个
    // 从未生效的提供者，而注册表里还是旧提供者 —— 两边不一致。
    this.#remoteServices.set(name, { providerId: pluginId, methods, token })
    let disposed = false
    return {
      dispose: (): void => {
        if (disposed) return
        disposed = true
        // 只有路由表仍指向本次 provide 才删除：last-wins 接管后，被替换者的清理
        // 不能把**当前接管者**的路由删掉（ADR-0019 决策 8 的边界不含这条）。
        if (this.#remoteServices.get(name)?.token === token) {
          this.#remoteServices.delete(name)
        }
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
  #useRemote(
    consumerId: string,
    name: string,
    effects: EffectScopeApi,
  ): { readonly methods: readonly string[]; readonly token: number | undefined } {
    const info = this.#options.registry.providerInfo(name)
    if (info === undefined) throw new ServiceUnavailableError(name)
    if (!info.remote) {
      throw new Error(
        `服务 "${name}" 由**同进程**插件 "${info.owner}" 提供，隔离插件无法取用（活对象过不了进程边界）。\n` +
          '两个选择：把提供者也改成 trust: untrusted，或让消费者改用 trust: trusted。',
      )
    }
    // 版本协商（ADR-0019）：权威数据在**宿主**——子进程里的 manifest 是 stub（没有 dependencies），
    // 所以这里用宿主持有的 plugin.json 声明，在"取用点"再强制一次。
    // 不复用加载前的依赖预检：预检是"能不能启动"，这里是"现在拿到的这个提供者是否满足契约"。
    const range = this.#sessions.get(consumerId)?.declaredDependencies[name]
    this.#options.registry.assertSatisfies(name, range)

    const edge = this.#options.registry.depend(consumerId, name, 'hard', range)
    effects.add(() => edge.dispose(), `depend:async:${name}`)
    // 把**当前代际**发给消费者：它调用时必须带回来，换人后过期代理会被拒绝。
    const current = this.#remoteServices.get(name)
    return { methods: current?.methods ?? [], token: current?.token }
  }

  async #invokeRemote(
    name: string,
    method: string,
    args: readonly unknown[],
    token?: number | undefined,
  ): Promise<unknown> {
    const entry = this.#remoteServices.get(name)
    if (entry === undefined) throw new Error(`远程服务 "${name}" 已不可用（提供者可能已卸载）`)
    // 代际校验：调用方锚定的 token 必须还是当前提供者的（ADR-0019）。
    // 没有这一条，last-wins 换人后旧代理会**静默**把调用路由到新提供者 ——
    // 调用能成功、结果却来自另一个插件，这是最难查的一类问题。
    if (token !== undefined && entry.token !== token) {
      throw new Error(
        `远程服务 "${name}" 的提供者已被替换（last-wins），这个代理已过期：` +
          '请重新调用 ctx.async.useService(name) 取用当前提供者（ADR-0019）。',
      )
    }
    const session = this.#sessions.get(entry.providerId)
    if (session === undefined) {
      throw new Error(`远程服务 "${name}" 的提供者插件 "${entry.providerId}" 当前不在运行中`)
    }
    return await session.invokeServiceMethod(name, method, args)
  }

  get activeSessions(): number {
    return this.#sessions.size
  }

  /**
   * 累计创建过的隔离会话数（单调递增，不随退出减少）。
   *
   * 为什么需要它：`activeSessions === 0` 单独看是**可能永远为真**的 ——
   * 一个"从来没起过进程"的实现也能通过。浸泡测试用这个计数器断言"每轮都真的起了新进程"，
   * 凑齐"应该 > 0"的另一半。状态面板也可以用它判断"这个宿主到底起过几个子进程"。
   */
  get sessionsStarted(): number {
    return this.#sessionsStarted
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

    if (this.#options.inheritEnv === true) {
      this.#log(
        `[${pluginId}] 已开启 vscordis.isolation.inheritEnv：隔离子进程继承宿主完整环境变量，` +
          '可能包含 token/代理凭据等敏感值，隔离强度下降（ADR-0021）。',
      )
    }

    // Node 权限模型不解析 reparse point：先把“指向 root 外”的 symlink/junction 拒掉，
    // 而且必须发生在 fork 之前（ADR-0020）。permissionModel=false 时 execArgv 为空，
    // 用户已经显式接受“没有强制 fs 边界”，不做这项扫描。
    if (plan.execArgv.includes('--permission')) {
      try {
        await assertNoEscapingReparsePoints(entry.root)
      } catch (error) {
        throw new PluginIntegrityCheckError(
          pluginId,
          error instanceof Error ? error.message : String(error),
        )
      }
    }

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
          disposeBudgetMs: this.#options.disposeBudgetMs ?? 0,
          inheritEnv: this.#options.inheritEnv ?? false,
          onUnexpectedExit: this.#options.onUnexpectedExit,
          log: (message) => this.#log(message),
        })
        ref.session = session
        this.#sessionsStarted += 1
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
  /** 整栈回收总预算；`0` = 不设（随 activate 消息下发给子进程的 EffectStack）。 */
  readonly disposeBudgetMs: number
  /** 是否完整继承宿主 env；见 `IsolatedLoaderOptions.inheritEnv`（ADR-0021）。 */
  readonly inheritEnv: boolean
  /** 激活成功后子进程异常退出的回调；见 `IsolatedLoaderOptions.onUnexpectedExit`。 */
  readonly onUnexpectedExit: ((pluginId: string, error: Error) => void) | undefined
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
  /** 是否收到过 `activated`：未激活前异常退出由 start() 自己失败，不触发宿主状态回调。 */
  #everActivated = false

  constructor(options: SessionOptions) {
    this.#options = options
    this.#pluginId = options.entry.manifest.id
  }

  get pluginId(): string {
    return this.#pluginId
  }

  /**
   * 该插件 `plugin.json#dependencies` 的声明（服务名 → 版本范围）。
   *
   * 隔离消费者的 `services.use` 只带服务名；版本范围必须在**宿主**这一侧解析 ——
   * 子进程里的 manifest 是 stub（`version: '0.0.0'`、没有 dependencies），不可信也不完整。
   */
  get declaredDependencies(): Readonly<Record<string, string>> {
    return this.#options.entry.manifest.dependencies
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
    if (!this.#send({ kind: 'invokeService', requestId, service, method, args })) {
      // 同 invokeCommand：发不出去必须变成一次失败应答，而不是让消费者永远等待。
      this.#serviceInvokes.delete(requestId)
      pending.reject(
        new Error(
          `调用 ${service}.${method}() 的请求无法发送到插件 ${this.#pluginId} 的子进程（参数可能无法 structured clone）`,
        ),
      )
    }
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
      // VSCode 宿主跑在 Electron 里：必须设 ELECTRON_RUN_AS_NODE=1，否则 fork 会去启动一个
      // 完整的 Electron 应用而不是 Node。默认只传系统白名单，避免把宿主敏感 env 暴露给
      // untrusted 插件；用户显式开启 vscordis.isolation.inheritEnv 时才完整继承（ADR-0021）。
      env: buildIsolatedChildEnv(this.#options.inheritEnv),
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
      if (!isChildToHost(message)) {
        this.#protocolViolation(`收到非法的隔离 IPC 消息：${describe(message)}`)
        return
      }
      try {
        this.#handle(message)
      } catch (error) {
        this.#protocolViolation(`处理 ${message.kind} 消息时抛错：${errorToWire(error)}`)
      }
    })
    child.on('error', (error: Error) => {
      this.#failAll(`子进程错误：${errorToWire(error)}`)
    })

    this.#exited.promise.catch(() => undefined)
    child.on('exit', (code, signal) => {
      const detail = `退出码 ${code ?? 'null'} / 信号 ${signal ?? 'none'}`
      const unexpected = !this.#closed
      // 子进程**异常退出**（崩溃、被外部杀掉）时不会走 kill() 那条优雅路径，
      // 所以在途调用必须在**这里**也失败一次：否则消费者会永远等一个已经死掉的进程
      // （ADR-0019 决策 5 的另一半；kill() 里的 #failAll 只覆盖宿主主动卸载）。
      // 反向验证过：去掉这行，`isolation.spec.ts` 的"子进程异常退出"用例会以
      // "在途调用必须被拒绝，而不是永远挂起"失败。
      this.#failAll(`插件 ${this.#pluginId} 的子进程已退出（${detail}），在途调用无法完成`)
      this.#cleanupHostSide()

      if (unexpected) {
        const error = new Error(`插件 ${this.#pluginId} 的子进程异常退出（${detail}）`)
        // 启动/激活阶段也要快速失败，而不是干等 readyTimeout；
        // 已 settle 的 deferred 上 reject 是 no-op。
        this.#ready.reject(error)
        this.#activated.reject(error)
        this.#options.log(`[${this.#pluginId}] ${error.message}`)
        // 只有"激活成功后"才通知宿主把记录改成 failed；激活前的失败由 load() 自己负责。
        if (this.#everActivated) this.#options.onUnexpectedExit?.(this.#pluginId, error)
      }

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

    const permissions = toIsolatedPermissions(
      new Set(this.#options.entry.manifest.permissions as readonly Permission[]),
    )

    this.#send({
      kind: 'activate',
      protocolVersion: PROTOCOL_VERSION,
      pluginId: this.#pluginId,
      pluginEntry: this.#options.entry.mainPath,
      permissions,
      // 工作区路径也是数据：没有 workspace.read 时不预取、不发送（ADR-0005 权限表）。
      // 子进程侧还有一道本地同步门；这里少发一份是不让宿主数据先进入不可信进程。
      workspaceFolders: permissions.workspace.read ? this.#options.hostApi.workspaceFolders() : [],
      configSnapshot,
      disposeTimeoutMs: this.#options.disposeTimeoutMs,
      disposeBudgetMs: this.#options.disposeBudgetMs,
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
    // 命令参数与服务参数走同一条 IPC、只是方向不同：同样在**调用点**校验，
    // 错误信息带"哪个命令、第几个参数、哪条路径"（否则只会在传输层炸，或类实例静默失真）。
    assertCloneableCommandArgs(command, args)
    const requestId = ++this.#requestSeq
    const pending = deferred<unknown>()
    this.#invokes.set(requestId, pending)
    if (!this.#send({ kind: 'invoke', requestId, command, args })) {
      // 发不出去就必须给出失败应答：否则 executeCommand 的调用方永远等下去。
      this.#invokes.delete(requestId)
      pending.reject(
        new Error(`执行命令 ${command} 的请求无法发送到插件 ${this.#pluginId} 的子进程（可能无法 structured clone）`),
      )
    }
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

  /**
   * 发送一条宿主 → 子进程消息；返回是否真的发出去了。
   *
   * 返回值不是装饰：`serialization: 'advanced'` 下遇到无法序列化的值会在 `send()` 里抛错，
   * 而调用方（`invokeServiceMethod` / `invokeCommand`）必须把"发不出去"变成一次**明确的失败应答**，
   * 否则等待方会永远挂起（活锁）。
   */
  #send(message: HostToChild): boolean {
    try {
      this.#child?.send(message)
      return true
    } catch (error) {
      this.#options.log(`[${this.#pluginId}] 向子进程发送消息失败：${errorToWire(error)}`)
      return false
    }
  }

  #handle(message: ChildToHost): void {
    switch (message.kind) {
      case 'ready':
        this.#ready.resolve()
        break
      case 'activated':
        this.#everActivated = true
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
            this.#send({ kind: 'event', subscription: subscriptionId, event: 'save', payload })
          })
          this.#eventSubscriptions.set(subscriptionId, disposable)
          this.#reply(call.id, { subscription: subscriptionId })
          break
        }
        case 'events.onDidChangeActiveTextEditor': {
          // 与保存事件同一套句柄/权限/清理机制（ADR-0018）：差别只在事件种类与"可以为空"。
          require('vscode:workspace.read')
          const subscriptionId = ++this.#eventSeq
          const disposable = this.#options.hostApi.subscribeActiveEditorChanges(pluginId, (payload) => {
            this.#send({ kind: 'event', subscription: subscriptionId, event: 'activeEditor', payload })
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
          // 未知策略 fail-closed：静默回退到 exclusive 是"声明了却不生效"的温床。
          const rawConflict = call.args[3]
          if (rawConflict !== undefined && rawConflict !== null && rawConflict !== 'exclusive' && rawConflict !== 'last-wins') {
            throw new Error(
              `未知的服务冲突策略 "${String(rawConflict)}"：只支持 'exclusive' 与 'last-wins'（ADR-0007 决策 3）。`,
            )
          }
          const conflict = rawConflict === 'last-wins' ? 'last-wins' : 'exclusive'
          const disposable = this.#options.services.provide(this.#pluginId, name, version, methods, conflict)
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
          const { methods, token } = this.#options.services.use(this.#pluginId, name, effects)
          this.#reply(call.id, { methods, token })
          break
        }
        case 'services.invoke': {
          const name = String(call.args[0] ?? '')
          const method = String(call.args[1] ?? '')
          const args = Array.isArray(call.args[2]) ? (call.args[2] as unknown[]) : []
          // 第 4 个参数是消费者取用时拿到的代际 token（见 services.use 的应答）。
          const rawToken = call.args[3]
          const token = typeof rawToken === 'number' ? rawToken : undefined
          this.#reply(call.id, await this.#options.services.invoke(name, method, args, token))
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

  /**
   * 协议违规（畸形消息/处理时抛错）只失败本会话：
   * reject 启动阶段的两个 deferred 让 `load()` 快速失败，而不是干等 readyTimeout；
   * 再 kill 子进程，避免后续任意消息继续冲击宿主事件循环。
   */
  #protocolViolation(reason: string): void {
    const error = new Error(`插件 ${this.#pluginId} 违反隔离 IPC 协议：${reason}`)
    this.#options.log(`[${this.#pluginId}] ${error.message}`)
    this.#ready.reject(error)
    this.#activated.reject(error)
    this.#failAll(error.message)
    this.kill()
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
