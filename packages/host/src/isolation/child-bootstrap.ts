import { createRequire } from 'node:module'
import { EffectStack } from '@vscordis/kernel'
import { resolvePluginExport, type AsyncService, type AsyncTextDocument, type CordisPlugin, type Disposable, type LogLevel, type Permission, type PluginContext, type PluginVscodeApi, type ProvideOptions, type ServiceName } from '@vscordis/sdk'
import {
  PROTOCOL_VERSION,
  assertCloneableArgs,
  describeCloneProblem,
  errorToWire,
  unsupportedReason,
  type ChildToHost,
  type HostMethod,
  type HostToChild,
  type IsolatedPermissions,
  type SerializedSaveEvent,
  type SerializedWorkspaceFolder,
} from './protocol.ts'

/**
 * 隔离子进程的引导脚本（M4b）。
 *
 * 它是**唯一**在子进程里运行的 vscordis 代码，职责是：
 *   1. 把插件模块加载进来（此时 `vscode` 模块天然不存在 —— 这是真边界，不是约定）；
 *   2. 给插件一个「长得像 PluginContext，但 vscode 是 RPC 代理」的上下文；
 *   3. 用**同一套 kernel EffectStack** 管理插件的副作用（LIFO 逆序回收仍然成立）；
 *   4. 拦截 Node 内建模块的 require（`net` / `child_process`），作为权限模型的补充。
 *
 * 明确不做的事：不实现 `provide` / `use`（服务是进程内对象，跨进程共享需要完整 IDL，属 M4c）；
 * 不伪造同步 API（宁可响亮失败，也不给"类型同步、实际异步"的假接口）。
 */

const nodeRequire = createRequire(
  typeof __filename === 'string' ? __filename : `${process.cwd()}/isolated-worker.cjs`,
)

// ————————————————————————————————— 与宿主通信

interface PendingCall {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

const pendingCalls = new Map<number, PendingCall>()
const commandHandlers = new Map<string, (...args: unknown[]) => unknown>()
/**
 * 订阅句柄 → 监听器。
 *
 * 参数是**事件载荷**（可为 undefined：活动编辑器事件在"没有活动编辑器"时会原样收到 undefined）。
 * 每个 `ctx.async.*` 入口在登记时把载荷适配成对应签名需要的形状。
 */
const eventListeners = new Map<number, (payload: SerializedSaveEvent | undefined) => void>()
/**
 * 本进程**提供**的服务：名称 → 实例。
 *
 * 方法调用由宿主反向请求进来（`invokeService`），在这里对真实对象求值 ——
 * 与命令 handler 走的是同一套"函数不跨进程，只跨调用"的思路（ADR-0019）。
 */
const localServices = new Map<string, unknown>()
let callSeq = 0

/** 列出服务的方法名。这份"IDL-lite"让消费者的代理能对**不存在的方法**响亮报错。 */
function listMethods(service: unknown): string[] {
  if (service === null || (typeof service !== 'object' && typeof service !== 'function')) return []
  const record = service as Record<string, unknown>
  const names = new Set<string>()
  for (const key of Object.getOwnPropertyNames(record)) {
    if (typeof record[key] === 'function') names.add(key)
  }
  let proto: object | null = Object.getPrototypeOf(record) as object | null
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue
      if (typeof record[key] === 'function') names.add(key)
    }
    proto = Object.getPrototypeOf(proto) as object | null
  }
  return [...names]
}

/**
 * 远程服务的消费者代理：每个方法 → 一次跨进程调用。
 *
 * 只暴露**方法表里声明过**的名字。少了这一步，代理就得对任何属性都返回一个函数，
 * 于是 `clock.nwo()` 这种打字错误会变成一个"调用了一个不存在的方法"的跨进程往返，
 * 而不是立刻报错。
 */
function createRemoteServiceProxy<T>(service: string, methods: readonly string[]): AsyncService<T> {
  const allowed = new Set(methods)
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string') return undefined
        // ⚠️ `then` 必须放行成 undefined：`await proxy` 会去探测 `.then` 判断它是不是 thenable，
        // 而我们的代理对方法表外的属性是抛错的 —— 不特判的话，
        // `await ctx.async.useService('clock')` 会炸在 `then` 上（"没有方法 then"）。
        if (property === 'then') return undefined
        if (!allowed.has(property)) {
          throw new Error(
            `远程服务 "${service}" 没有方法 "${property}"。` +
              `提供者声明的方法：${methods.length === 0 ? '<无>' : methods.join(', ')}`,
          )
        }
        return async (...args: unknown[]): Promise<unknown> => {
          // 前置校验：把"IPC 层才炸、且不告诉你哪个参数"变成调用点就能读懂的错误（ADR-0019）。
          assertCloneableArgs(service, property, args)
          return await callHost('services.invoke', [service, property, args])
        }
      },
    },
  ) as AsyncService<T>
}

function send(message: ChildToHost): void {
  // process.send 只在 fork 出来的子进程里存在
  process.send?.(message)
}

function callHost(method: HostMethod, args: readonly unknown[]): Promise<unknown> {
  const id = ++callSeq
  return new Promise<unknown>((resolve, reject) => {
    pendingCalls.set(id, { resolve, reject })
    try {
      send({ kind: 'call', id, method, args })
    } catch (error) {
      // structured clone 兜底：函数/类实例已被前置校验拦下，但 Proxy 之类的值在纯 JS 里认不出来。
      // 不删掉 pending 的话，请求会永远挂在表里（消费者等一个永不到来的响应）。
      pendingCalls.delete(id)
      reject(
        new Error(`请求 ${method} 无法发送到宿主（参数可能无法通过 structured clone）：${errorToWire(error)}`),
      )
    }
  })
}

function log(level: LogLevel, message: string): void {
  send({ kind: 'log', level, message })
}

// ————————————————————————————————— 本地最小实现（子进程里没有 vscode 模块）

class LocalDisposable implements Disposable {
  #disposed = false
  readonly #fn: () => void

  constructor(fn: () => void) {
    this.#fn = fn
  }

  get disposed(): boolean {
    return this.#disposed
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#fn()
  }
}

/**
 * 最小 Uri 实现。**只保证结构性**：`scheme` / `path` / `fsPath` / `toString()` 与 VSCode 一致，
 * 便于插件拼接路径。它不会跨进程传递 —— 要传给宿主的一律转成字符串。
 */
class LocalUri {
  readonly scheme: string
  readonly path: string

  constructor(scheme: string, path: string) {
    this.scheme = scheme
    this.path = path
  }

  get fsPath(): string {
    return this.path
  }

  static file(fsPath: string): LocalUri {
    return new LocalUri('file', fsPath)
  }

  static parse(value: string): LocalUri {
    const match = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(value)
    if (match === null) return new LocalUri('file', value)
    return new LocalUri((match[1] ?? 'file').toLowerCase(), match[2] ?? '')
  }

  static joinPath(base: LocalUri, ...segments: string[]): LocalUri {
    const joined = [base.path.replace(/[\\/]+$/, ''), ...segments].join('/')
    return new LocalUri(base.scheme, joined)
  }

  toString(): string {
    return `${this.scheme}:${this.path}`
  }
}

class LocalEventEmitter<T> {
  readonly #listeners = new Set<(value: T) => unknown>()

  readonly event = (listener: (value: T) => unknown): Disposable => {
    this.#listeners.add(listener)
    return new LocalDisposable(() => {
      this.#listeners.delete(listener)
    })
  }

  fire(value: T): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(value)
      } catch (error) {
        log('warn', `插件自己的事件监听器抛错：${errorToWire(error)}`)
      }
    }
  }

  dispose(): void {
    this.#listeners.clear()
  }
}

/** 输出通道代理：只有方法，没有属性，因此可以用句柄 + RPC 表达。 */
interface OutputChannelProxy {
  readonly handle: number
  appendLine(value: string): void
  append(value: string): void
  dispose(): void
}

function createOutputChannelHandle(name: string): OutputChannelProxy {
  let handle = -1
  let pending: Promise<unknown> | undefined
  const ensure = (): Promise<unknown> => {
    pending ??= callHost('window.createOutputChannel', [name]).then((value) => {
      handle = (value as { handle: number }).handle
      return value
    })
    return pending
  }
  // 注意：appendLine 不能是同步的（RPC 天然异步），所以这里"排队等句柄"。
  // 这是隔离模式**真实存在**的语义差异：调用不会立刻生效，但**顺序被保留**。
  const queue = (line: string): void => {
    void ensure().then(() => callHost('output.appendLine', [handle, line])).catch((error: unknown) => {
      log('warn', `写入输出通道失败：${errorToWire(error)}`)
    })
  }
  return {
    handle,
    appendLine: (value: string) => queue(value),
    append: (value: string) => queue(value),
    dispose: () => {
      void ensure()
        .then(() => callHost('output.dispose', [handle]))
        .catch(() => undefined)
    },
  } satisfies OutputChannelProxy
}

// ————————————————————————————————— 未完成宿主调用的追踪

/**
 * 追踪"发出去就不管"的宿主调用（`registerCommand` 这类必须同步返回 Disposable 的接口）。
 *
 * 为什么需要它：这些调用没法把失败抛给调用方，如果只是 `void call(...).catch(log)`，
 * 就会出现最难查的一类问题 —— **插件显示"激活成功"，但命令其实是死的**。
 * 所以在 `activate()` 结束前设一道屏障：等所有未完成的宿主调用落地，任何一个失败都让激活失败。
 */
const outstandingHostCalls = new Set<Promise<unknown>>()
const asyncFailures: Error[] = []

function trackHostCall(promise: Promise<unknown>, what: string): void {
  let tracked: Promise<unknown>
  tracked = promise
    .catch((error: unknown) => {
      const failure = new Error(`${what} 失败：${errorToWire(error)}`)
      asyncFailures.push(failure)
      log('error', failure.message)
    })
    .finally(() => {
      outstandingHostCalls.delete(tracked)
    })
  outstandingHostCalls.add(tracked)
}

/** 等所有未完成的宿主调用结算。IMPORTANT：等待期间可能又新增，所以是循环而不是一次 allSettled。 */
async function drainHostCalls(): Promise<void> {
  for (let round = 0; round < 5 && outstandingHostCalls.size > 0; round += 1) {
    await Promise.allSettled([...outstandingHostCalls])
  }
}

let workspaceFolders: readonly SerializedWorkspaceFolder[] = []

/**
 * 配置快照（键 → 值，键是**全限定名** `section.key`）。
 *
 * 宿主在激活时预取、在配置变化时推送，插件侧的 `get()` 因此始终同步且不陈旧。
 * 这是"不撒谎地支持同步 API"的唯一办法 —— 详见 ADR-0016。
 */
let configSnapshot: Readonly<Record<string, unknown>> = {}
/** 未声明的键只告警一次，避免刷屏。 */
const warnedConfigKeys = new Set<string>()

function readConfig(section: string | undefined, key: string, fallback: unknown): unknown {
  const qualified = section === undefined || section.length === 0 ? key : `${section}.${key}`
  if (Object.prototype.hasOwnProperty.call(configSnapshot, qualified)) return configSnapshot[qualified]
  if (Object.prototype.hasOwnProperty.call(configSnapshot, key)) return configSnapshot[key]

  const missing = section === undefined ? qualified : qualified
  if (!warnedConfigKeys.has(missing)) {
    warnedConfigKeys.add(missing)
    log(
      'warn',
      `读取了未声明的配置键 "${missing}"，只能返回默认值。` +
        '请在 plugin.json 的 configuration.keys 里声明它（隔离模式靠声明预取，见 ADR-0016）。',
    )
  }
  return fallback
}

function hasConfig(section: string | undefined, key: string): boolean {
  const qualified = section === undefined || section.length === 0 ? key : `${section}.${key}`
  return (
    Object.prototype.hasOwnProperty.call(configSnapshot, qualified) ||
    Object.prototype.hasOwnProperty.call(configSnapshot, key)
  )
}

function createConfigurationView(section: string | undefined): unknown {
  return {
    get: (key: string, fallback?: unknown) => readConfig(section, key, fallback),
    has: (key: string) => hasConfig(section, key),
    inspect: () => undefined,
    update: () => {
      throw new Error(
        '隔离模式不支持写配置。若确实需要，请让宿主代为写入（M4c 未覆盖），或改用 trust: trusted（只防误用）。',
      )
    },
  }
}

/**
 * 状态栏项：本地镜像 + 串行 RPC。
 *
 * 两点值得注意：
 * - **本地镜像**：`item.text = 'x'` 之后 `item.text` 必须立刻读回 'x'。
 *   如果每次都去问宿主，读属性就变成异步的了 —— 那又是假接口。
 * - **串行队列**：`item.text = 'x'; item.show()` 这两步必须按顺序到达宿主，
 *   否则会出现"显示了但文字还是旧的"。用一条 promise 链而不是各自 fire-and-forget。
 */
function createStatusBarItem(alignment?: number, priority?: number): unknown {
  const state = {
    text: '',
    tooltip: '',
    command: undefined as string | undefined,
    color: undefined as string | undefined,
    name: undefined as string | undefined,
    accessibilityInformation: undefined as unknown,
  }
  let handle = -1
  let creating: Promise<void> | undefined
  let queue: Promise<void> = Promise.resolve()

  const ensure = (): Promise<void> => {
    creating ??= callHost('statusBar.create', [alignment ?? 0, priority ?? 0, { text: state.text }]).then(
      (value) => {
        handle = (value as { handle: number }).handle
      },
    )
    return creating
  }

  const enqueue = (what: string, task: () => Promise<unknown>): void => {
    queue = queue
      .then(() => ensure())
      .then(task)
      .then(
        () => undefined,
        (error: unknown) => {
          log('warn', `状态栏项 ${what} 失败：${errorToWire(error)}`)
        },
      )
  }

  const patch = (what: string, key: string, value: unknown): void => {
    enqueue(what, () => callHost('statusBar.update', [handle, { [key]: value }]))
  }

  const target = {
    get text(): string {
      return state.text
    },
    set text(value: string) {
      state.text = value
      patch('text', 'text', value)
    },
    get tooltip(): string {
      return state.tooltip
    },
    set tooltip(value: string | undefined) {
      state.tooltip = value ?? ''
      patch('tooltip', 'tooltip', value ?? '')
    },
    get command(): string | undefined {
      return state.command
    },
    set command(value: string | undefined) {
      state.command = value
      patch('command', 'command', value ?? '')
    },
    get color(): string | undefined {
      return state.color
    },
    set color(value: string | undefined) {
      state.color = value
      patch('color', 'color', value ?? '')
    },
    get name(): string | undefined {
      return state.name
    },
    set name(value: string | undefined) {
      state.name = value
      patch('name', 'name', value ?? '')
    },
    get accessibilityInformation(): unknown {
      return state.accessibilityInformation
    },
    set accessibilityInformation(value: unknown) {
      state.accessibilityInformation = value
      patch('accessibilityInformation', 'accessibilityInformation', value)
    },
    get alignment(): number {
      return alignment ?? 0
    },
    get priority(): number {
      return priority ?? 0
    },
    show(): void {
      enqueue('show', () => callHost('statusBar.setVisible', [handle, true]))
    },
    hide(): void {
      enqueue('hide', () => callHost('statusBar.setVisible', [handle, false]))
    },
    dispose(): void {
      enqueue('dispose', () => callHost('statusBar.dispose', [handle]))
    },
  }

  /**
   * 为什么用 Proxy：普通对象对**未支持的属性赋值是静默接受**的 ——
   * 插件写 `item.backgroundColor = 'red'` 会既不改 UI 也不报错，这正是最难查的一类问题。
   * 这里对未知属性直接抛错，并列出真正支持的集合。
   */
  const SUPPORTED_PROPERTIES = new Set([
    'text',
    'tooltip',
    'command',
    'color',
    'name',
    'accessibilityInformation',
    'alignment',
    'priority',
    'show',
    'hide',
    'dispose',
  ])

  return new Proxy(target, {
    set(object, property, value) {
      if (typeof property === 'string' && !SUPPORTED_PROPERTIES.has(property)) {
        throw new Error(
          `隔离模式的状态栏项不支持属性 "${property}"。` +
            '支持的属性：text / tooltip / command / color / name / accessibilityInformation；' +
            '方法：show / hide / dispose。' +
            '（同进程模式没有这个限制，但那样就没有隔离边界了，见 ADR-0003。）',
        )
      }
      return Reflect.set(object, property, value, object)
    },
  })
}

function buildVscodeProxy(permissions: IsolatedPermissions): PluginVscodeApi {
  const unsupported = (member: string): never => {
    throw new Error(unsupportedReason(member))
  }

  /**
   * 本地先做一次权限检查，让常见的越权**同步抛出**（与 in-process 模式的体验一致）。
   * 宿主的检查仍然是权威的 —— 这里只是"快速失败"，不是安全边界。
   */
  const requireLocally = (granted: boolean, permission: string): void => {
    if (granted) return
    throw new Error(
      `未获得权限 ${permission}（隔离模式本地快速失败；宿主侧还会再校验一次）`,
    )
  }

  const api = {
    commands: {
      registerCommand: (command: string, callback: (...args: never[]) => unknown): Disposable => {
        requireLocally(permissions.commands.register, 'vscode:commands.register')
        commandHandlers.set(command, callback as (...args: unknown[]) => unknown)
        trackHostCall(callHost('commands.registerCommand', [command]), `注册命令 ${command}`)
        return new LocalDisposable(() => {
          commandHandlers.delete(command)
          void callHost('commands.unregisterCommand', [command]).catch(() => undefined)
        })
      },
      executeCommand: ((command: string, ...args: unknown[]) =>
        callHost('commands.executeCommand', [command, args])) as unknown as PluginVscodeApi['commands']['executeCommand'],
    },
    window: {
      showInformationMessage: ((message: string) =>
        callHost('window.showInformationMessage', [message])) as unknown as PluginVscodeApi['window']['showInformationMessage'],
      showWarningMessage: ((message: string) =>
        callHost('window.showWarningMessage', [message])) as unknown as PluginVscodeApi['window']['showWarningMessage'],
      showErrorMessage: ((message: string) =>
        callHost('window.showErrorMessage', [message])) as unknown as PluginVscodeApi['window']['showErrorMessage'],
      createStatusBarItem: ((alignment?: number, priority?: number) => {
        requireLocally(permissions.window.statusBar, 'vscode:window.statusbar')
        return createStatusBarItem(alignment, priority)
      }) as unknown as PluginVscodeApi['window']['createStatusBarItem'],
      createOutputChannel: ((name: string) => {
        requireLocally(permissions.window.output, 'vscode:window.output')
        return createOutputChannelHandle(name)
      }) as unknown as PluginVscodeApi['window']['createOutputChannel'],
      // 同步入口继续不支持，但错误信息必须指向 ctx.async 的替代路径（ADR-0018 决策 3）。
      onDidChangeActiveTextEditor: (() =>
        unsupported('window.onDidChangeActiveTextEditor')) as unknown as PluginVscodeApi['window']['onDidChangeActiveTextEditor'],
    },
    workspace: {
      get workspaceFolders(): readonly never[] | undefined {
        return workspaceFolders as never[]
      },
      getConfiguration: ((section?: string) =>
        createConfigurationView(section)) as unknown as PluginVscodeApi['workspace']['getConfiguration'],
      onDidSaveTextDocument: (() => unsupported('workspace.onDidSaveTextDocument')) as unknown as PluginVscodeApi['workspace']['onDidSaveTextDocument'],
    },
    Uri: LocalUri,
    Disposable: LocalDisposable,
    EventEmitter: LocalEventEmitter,
  }

  return api as unknown as PluginVscodeApi
}

// ————————————————————————————————— require 拦截（权限模型的补充）

const NETWORK_MODULES = new Set([
  'net',
  'http',
  'https',
  'http2',
  'dgram',
  'tls',
  'dns',
  'node:net',
  'node:http',
  'node:https',
  'node:http2',
  'node:dgram',
  'node:tls',
  'node:dns',
])

function installModuleGuards(permissions: IsolatedPermissions): void {
  interface LoaderModule {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const moduleApi = nodeRequire('node:module') as unknown as LoaderModule
  const originalLoad = moduleApi._load

  moduleApi._load = function guardedLoad(request: string, parent: unknown, isMain: boolean): unknown {
    if (!permissions.net && NETWORK_MODULES.has(request)) {
      throw new Error(
        `网络访问被拒绝：插件未获得 net 权限（require("${request}")）。` +
          '注意：Node 权限模型没有网络开关，这是一道"防误用"的拦截，不是强制封禁（ADR-0005）。',
      )
    }
    if (!permissions.processSpawn && (request === 'child_process' || request === 'node:child_process')) {
      throw new Error(`子进程创建被拒绝：插件未获得 process:spawn 权限（require("${request}")）`)
    }
    return originalLoad.call(this, request, parent, isMain)
  }
}

// ————————————————————————————————— 激活 / 停用

interface ActivationState {
  readonly pluginId: string
  readonly permissions: IsolatedPermissions
  readonly disposeTimeoutMs: number
  readonly stack: EffectStack
  readonly plugin: CordisPlugin
  /** 卸载信号。停用时 abort，让插件能提前中止长任务（与 in-process 模式的 ctx.signal 语义一致）。 */
  readonly controller: AbortController
}

let state: ActivationState | undefined

/**
 * 把权限结构还原成权限名单。
 *
 * 刻意不直接把那个对象塞进 `ctx.permissions`：`Set` 需要一个可迭代对象，
 * 传对象会在运行时抛 "object is not iterable"，而且那是个类型谎言。
 */
function permissionList(permissions: IsolatedPermissions): Permission[] {
  const list: Permission[] = []
  if (permissions.commands.register) list.push('vscode:commands.register')
  if (permissions.commands.executeAny) list.push('vscode:commands.execute.any')
  else if (permissions.commands.execute) list.push('vscode:commands.execute')
  if (permissions.window.messages) list.push('vscode:window.messages')
  if (permissions.window.output) list.push('vscode:window.output')
  if (permissions.workspace.read) list.push('vscode:workspace.read')
  if (permissions.workspace.configRead) list.push('vscode:workspace.config.read')
  if (permissions.workspace.configWrite) list.push('vscode:workspace.config.write')
  if (permissions.fsRead) list.push('fs:read')
  if (permissions.fsWrite) list.push('fs:write')
  if (permissions.processSpawn) list.push('process:spawn')
  if (permissions.net) list.push('net')
  return list
}

/**
 * 把宿主转发过来的**纯数据载荷**适配成 `AsyncTextDocument`（ADR-0018）。
 *
 * 正文不随事件传：`getText()` 按句柄跨进程取，句柄有生命周期（过期会得到明确错误）。
 */
function adaptAsyncDocument(payload: SerializedSaveEvent): AsyncTextDocument {
  return {
    uri: payload.uri,
    fsPath: payload.fsPath,
    languageId: payload.languageId,
    lineCount: payload.lineCount,
    version: payload.version,
    getText: () => callHost('document.getText', [payload.documentHandle]) as Promise<string>,
  }
}

function buildContext(activation: ActivationState, stack: EffectStack): PluginContext {
  const { pluginId } = activation

  const notSupported = (what: string): never => {
    // 文案来自协议层，保证"不支持的理由"只有一处定义（避免两处说法不一致）
    throw new Error(unsupportedReason(what))
  }

  const ctx: PluginContext = {
    id: pluginId,
    manifest: { id: pluginId, name: pluginId, version: '0.0.0', main: 'index.cjs' },
    signal: activation.controller.signal,
    log: {
      trace: (message, ...args) => log('trace', `${message} ${args.map((a) => String(a)).join(' ')}`.trim()),
      debug: (message, ...args) => log('debug', `${message} ${args.map((a) => String(a)).join(' ')}`.trim()),
      info: (message, ...args) => log('info', `${message} ${args.map((a) => String(a)).join(' ')}`.trim()),
      warn: (message, ...args) => log('warn', `${message} ${args.map((a) => String(a)).join(' ')}`.trim()),
      error: (message, error) => log('error', `${message} ${error === undefined ? '' : errorToWire(error)}`.trim()),
    },
    permissions: new Set<Permission>(permissionList(activation.permissions)),
    vscode: buildVscodeProxy(activation.permissions),

    /**
     * 显式异步面（ADR-0018）：与同进程实现**签名完全一致**，
     * 于是插件代码不需要按模式分支，也不会撞上"类型同步、实际异步"。
     */
    async: {
      onDidSaveTextDocument: async (listener) => {
        const opened = (await callHost('events.onDidSaveTextDocument', [])) as { subscription: number }
        // 保存事件一定带文档；这里显式挡掉 undefined，让类型契约不因"事件种类共用载荷"而变松。
        eventListeners.set(opened.subscription, (payload) => {
          if (payload !== undefined) listener(adaptAsyncDocument(payload))
        })
        return new LocalDisposable(() => {
          eventListeners.delete(opened.subscription)
          void callHost('events.unsubscribe', [opened.subscription]).catch(() => undefined)
        })
      },
      onDidChangeActiveTextEditor: async (listener) => {
        const opened = (await callHost('events.onDidChangeActiveTextEditor', [])) as { subscription: number }
        // undefined 要**原样**传下去：那是"现在没有活动编辑器"，不是"事件丢了"。
        eventListeners.set(opened.subscription, (payload) => {
          listener(payload === undefined ? undefined : adaptAsyncDocument(payload))
        })
        return new LocalDisposable(() => {
          eventListeners.delete(opened.subscription)
          void callHost('events.unsubscribe', [opened.subscription]).catch(() => undefined)
        })
      },
      useService: async <T,>(name: string): Promise<AsyncService<T>> => {
        // 先让宿主在**它的**注册表里登记依赖边（这样提供者离开时本插件会被 paused），
        // 并取回方法表 —— 没有方法表，代理无法区分方法与数据字段。
        const info = (await callHost('services.use', [name])) as { methods: readonly string[] }
        return createRemoteServiceProxy<T>(name, info.methods)
      },
    },

    effect: (register, dispose, label) => stack.effect(register, dispose, label),
    effectAsync: (register, dispose, label) => stack.effectAsync(register, dispose, label),
    scope: (label?: string) => buildContext(activation, stack.scope(label)),
    effects: stack,

    use: () => notSupported('services.syncConsumer'),
    tryUse: () => notSupported('services.syncConsumer'),
    provide: <T,>(name: ServiceName, service: T, options?: ProvideOptions): Disposable => {
      // `remote` 是运行时的标注：隔离提供者由宿主注册时自动置位。允许插件设置会让
      // "我不是远程"变成插件说了算 —— 明确拒绝比静默忽略强。
      if (options?.remote === true) {
        throw new Error(
          'ctx.provide 的 remote 标记由运行时写入（隔离提供者注册到宿主时会自动标记），插件不得自行设置（ADR-0019）。',
        )
      }
      // 方法表就是这份"IDL-lite"：没有它，消费者的代理无法区分方法与数据字段，
      // 只能对任何属性都返回一个函数 —— 那会把打字错误变成"调用了一个不存在的方法"。
      const methods = listMethods(service)
      trackHostCall(
        callHost('services.provide', [
          name,
          options?.version ?? null,
          methods,
          // 冲突策略必须一起过去：丢了它，`conflict: 'last-wins'` 会在宿主侧
          // 被静默当成默认的 exclusive（ADR-0019 / 0017 的"声明必须生效"原则）。
          options?.conflict ?? 'exclusive',
        ]),
        `提供服务 ${name}`,
      )
      localServices.set(name, service)
      const disposable = new LocalDisposable(() => {
        localServices.delete(name)
        void callHost('services.revoke', [name]).catch(() => undefined)
      })
      // ⚠️ 必须与同进程实现保持一致：`ctx.provide` 自动登记到 EffectStack。
      // 少了这一步，**优雅停用**时子进程不会发出 revoke，宿主只能在 exit 事件里兜底清理 ——
      // 那样"提供者卸载 → 消费者 paused"的级联就会晚一步、甚至被 settle() 抢先观察到。
      stack.add(() => disposable.dispose(), `provide:${name}`)
      return disposable
    },
    graph: () => notSupported('services.graph'),
    onDispose: (teardown, label) => stack.add(teardown, label),
  }

  return ctx
}

async function activate(message: Extract<HostToChild, { kind: 'activate' }>): Promise<void> {
  try {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`协议版本不匹配：宿主 ${message.protocolVersion}，子进程 ${PROTOCOL_VERSION}`)
    }
    installModuleGuards(message.permissions)
    workspaceFolders = message.workspaceFolders
    // 配置快照随激活一起下发：插件侧的 get() 因此可以保持同步语义（ADR-0016）。
    configSnapshot = message.configSnapshot
    warnedConfigKeys.clear()

    const exported: unknown = nodeRequire(message.pluginEntry)
    const plugin = resolvePluginExport(exported)
    const stack = new EffectStack({
      label: message.pluginId,
      disposeTimeoutMs: message.disposeTimeoutMs,
      // 与同进程插件用同一份预算配置：隔离插件的一堆挂死 teardown 同样不许拖垮卸载。
      disposeBudgetMs: message.disposeBudgetMs,
      onError: (error, label) => {
        log('error', `副作用回收失败：${label ?? '<未命名>'} ${errorToWire(error)}`)
      },
    })

    const activation: ActivationState = {
      pluginId: message.pluginId,
      permissions: message.permissions,
      disposeTimeoutMs: message.disposeTimeoutMs,
      stack,
      plugin,
      controller: new AbortController(),
    }
    state = activation

    await plugin.activate(buildContext(activation, stack))

    // 激活屏障：等所有"发出去就不管"的宿主调用结算。
    // 少了这一步，越权/重名的注册会变成"插件显示激活成功、命令却是死的"（最难查的一类问题）。
    await drainHostCalls()
    const failure = asyncFailures.shift()
    if (failure !== undefined) throw failure

    send({ kind: 'activated' })
  } catch (error) {
    send({ kind: 'failed', error: errorToWire(error) })
  }
}

/** 优雅停用：先让插件自己收尾，再 LIFO 回收副作用（这期间仍与宿主通信）。 */
async function deactivate(): Promise<void> {
  const current = state
  state = undefined
  if (current === undefined) {
    send({ kind: 'deactivated' })
    return
  }
  try {
    // 先发卸载信号：给插件的长任务一个提前退出的机会（与 in-process 模式一致）。
    current.controller.abort()
    await current.plugin.deactivate?.(buildContext(current, current.stack))
  } catch (error) {
    log('warn', `deactivate() 抛错（继续回收）：${errorToWire(error)}`)
  }
  await current.stack.dispose()
  send({ kind: 'deactivated' })
}

// ————————————————————————————————— 消息循环

/** 宿主反向请求：在**本进程里**对本地服务对象求值，并把结果回传。 */
function invokeLocalService(message: Extract<HostToChild, { kind: 'invokeService' }>): void {
  const instance = localServices.get(message.service)
  if (instance === undefined) {
    send({
      kind: 'serviceResult',
      requestId: message.requestId,
      ok: false,
      error: `本进程不提供名为 "${message.service}" 的服务（可能已被撤销）`,
    })
    return
  }
  const candidate = (instance as Record<string, unknown>)[message.method]
  if (typeof candidate !== 'function') {
    send({
      kind: 'serviceResult',
      requestId: message.requestId,
      ok: false,
      error: `服务 "${message.service}" 没有方法 "${message.method}"`,
    })
    return
  }
  void Promise.resolve()
    .then(() => (candidate as (...args: unknown[]) => unknown).apply(instance, [...message.args]))
    .then(
      (value) => {
        // 返回值也要前置校验：否则消费者拿到的错误来自 IPC 层（没说是哪个方法），
        // 或者更糟 —— 类实例悄悄丢了原型与方法（ADR-0019）。
        const problem = describeCloneProblem(
          `服务 "${message.service}" 的方法 "${message.method}" 的返回值`,
          value,
        )
        if (problem !== undefined) {
          send({ kind: 'serviceResult', requestId: message.requestId, ok: false, error: problem })
          return
        }
        try {
          send({ kind: 'serviceResult', requestId: message.requestId, ok: true, value })
        } catch (error) {
          // 兜底：Proxy 等 precheck 认不出的值。发送失败也必须给出应答，
          // 否则宿主会永远等这个 requestId（活锁）。
          send({
            kind: 'serviceResult',
            requestId: message.requestId,
            ok: false,
            error:
              `服务 "${message.service}" 的方法 "${message.method}" 的返回值无法通过 IPC 序列化：` +
              errorToWire(error),
          })
        }
      },
      (error: unknown) =>
        send({ kind: 'serviceResult', requestId: message.requestId, ok: false, error: errorToWire(error) }),
    )
}

function invokeCommand(requestId: number, command: string, args: readonly unknown[]): void {
  const handler = commandHandlers.get(command)
  if (handler === undefined) {
    send({ kind: 'result', requestId, ok: false, error: `子进程里没有 ${command} 的处理器（可能已被卸载）` })
    return
  }
  void Promise.resolve()
    .then(() => handler(...args))
    .then(
      (value) => send({ kind: 'result', requestId, ok: true, value: value === undefined ? undefined : value }),
      (error: unknown) => send({ kind: 'result', requestId, ok: false, error: errorToWire(error) }),
    )
}

process.on('message', (raw: unknown) => {
  const message = raw as HostToChild
  switch (message.kind) {
    case 'activate':
      void activate(message)
      break
    case 'response': {
      const pending = pendingCalls.get(message.id)
      if (pending === undefined) return
      pendingCalls.delete(message.id)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new Error(message.error))
      break
    }
    case 'configChanged':
      // 增量合并：宿主只推变化的键，未提到的键保留原值。
      configSnapshot = { ...configSnapshot, ...message.values }
      break
    case 'event': {
      const listener = eventListeners.get(message.subscription)
      if (listener === undefined) break
      // 载荷适配在各自的监听器闭包里：保存事件必然非空、活动编辑器事件可以为空。
      // 这里只负责按句柄派发，不解释事件语义。
      listener(message.payload)
      break
    }
    case 'invokeService':
      invokeLocalService(message)
      break
    case 'invoke':
      invokeCommand(message.requestId, message.command, message.args)
      break
    case 'deactivate':
      void deactivate().then(() => {
        // 让宿主先把 deactivated 收下再退出，避免事件丢失。
        setImmediate(() => process.exit(0))
      })
      break
  }
})

send({ kind: 'ready', protocolVersion: PROTOCOL_VERSION, pid: process.pid })
