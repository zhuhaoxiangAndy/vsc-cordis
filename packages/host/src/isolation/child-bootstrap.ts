import { createRequire } from 'node:module'
import { EffectStack } from '@vscordis/kernel'
import { resolvePluginExport, type CordisPlugin, type Disposable, type LogLevel, type Permission, type PluginContext, type PluginVscodeApi } from '@vscordis/sdk'
import {
  PROTOCOL_VERSION,
  errorToWire,
  unsupportedReason,
  type ChildToHost,
  type HostMethod,
  type HostToChild,
  type IsolatedPermissions,
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
let callSeq = 0

function send(message: ChildToHost): void {
  // process.send 只在 fork 出来的子进程里存在
  process.send?.(message)
}

function callHost(method: HostMethod, args: readonly unknown[]): Promise<unknown> {
  const id = ++callSeq
  return new Promise<unknown>((resolve, reject) => {
    pendingCalls.set(id, { resolve, reject })
    send({ kind: 'call', id, method, args })
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

    effect: (register, dispose, label) => stack.effect(register, dispose, label),
    effectAsync: (register, dispose, label) => stack.effectAsync(register, dispose, label),
    scope: (label?: string) => buildContext(activation, stack.scope(label)),
    effects: stack,

    use: () => notSupported('services'),
    tryUse: () => notSupported('services'),
    provide: () => notSupported('services'),
    graph: () => notSupported('services'),
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
