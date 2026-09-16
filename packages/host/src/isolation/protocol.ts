import { formatCloneProblem, inspectCloneable } from '@vscordis/kernel'
import type { LogLevel } from '@vscordis/sdk'

/**
 * 宿主 ↔ 隔离子进程的线协议（M4b）。
 *
 * 三条约束决定了它的形状：
 *
 * 1. **传不过去函数**。插件的命令 handler 必须留在子进程里，
 *    因此宿主执行命令时要**反向**请求子进程（`invoke` → `result`）。这是整套协议里最实质的部分。
 * 2. **传不过去类实例**。`Uri`、`WorkspaceFolder`、`OutputChannel` 都必须降级成
 *    纯数据（`Serialized*`）或者按句柄（handle）代理，绝不能直接把 VSCode 对象塞进 IPC。
 * 3. **错误不能靠异常类型**。跨进程只传字符串，宿主侧再决定怎么呈现。
 *
 * 序列化用 `serialization: 'advanced'`（structured clone），而不是默认的 JSON：
 * 至少能保住 `undefined`、`Date`、`Map`、`Set` 这些常见值。
 */

export const PROTOCOL_VERSION = 1

/** 子进程可请求的宿主能力。**新增一项都要同时想清楚它的权限归属**。 */
export type HostMethod =
  | 'commands.registerCommand'
  | 'commands.unregisterCommand'
  | 'commands.executeCommand'
  | 'window.showInformationMessage'
  | 'window.showWarningMessage'
  | 'window.showErrorMessage'
  | 'window.createOutputChannel'
  | 'output.appendLine'
  | 'output.dispose'
  | 'statusBar.create'
  | 'statusBar.update'
  | 'statusBar.setVisible'
  | 'statusBar.dispose'
  | 'log'
  | 'events.onDidSaveTextDocument'
  | 'events.unsubscribe'
  | 'document.getText'
  | 'services.provide'
  | 'services.revoke'
  | 'services.use'
  | 'services.invoke'

export interface IsolatedPermissions {
  readonly commands: {
    readonly register: boolean
    readonly execute: boolean
    readonly executeAny: boolean
  }
  readonly window: {
    readonly messages: boolean
    readonly output: boolean
    readonly statusBar: boolean
  }
  readonly workspace: {
    readonly read: boolean
    readonly configRead: boolean
    readonly configWrite: boolean
  }
  readonly fsRead: boolean
  readonly fsWrite: boolean
  readonly processSpawn: boolean
  readonly net: boolean
}

export interface SerializedWorkspaceFolder {
  readonly name: string
  readonly index: number
  readonly uri: string
  readonly fsPath: string
}

/**
 * 一次"文档已保存"事件的载荷：**纯数据** + 一个宿主侧文档句柄。
 *
 * 为什么不直接把正文塞进来：大文件每次保存都整篇走 IPC 是不可接受的。
 * 也不把整篇留到宿主里等插件来取：句柄是**有生命周期的** ——
 * 过期后再 `getText()` 会得到一条明确的错误，而不是静默返回空串。
 */
export interface SerializedSaveEvent {
  readonly uri: string
  readonly fsPath: string
  readonly languageId: string
  readonly lineCount: number
  readonly version: number
  readonly documentHandle: number
}

/** 宿主 → 子进程。 */
export type HostToChild =
  | {
      readonly kind: 'activate'
      readonly protocolVersion: number
      readonly pluginId: string
      readonly pluginEntry: string
      readonly permissions: IsolatedPermissions
      readonly workspaceFolders: readonly SerializedWorkspaceFolder[]
      /** 按 `plugin.json#configuration` 预取的配置**快照**（键 → 值）。 */
      readonly configSnapshot: Readonly<Record<string, unknown>>
      readonly disposeTimeoutMs: number
      /**
       * 整栈回收的总时长预算（ADR-0015 已知缺口 1）。
       *
       * `0` = 不设预算（子进程侧 EffectStack 的既有语义）。宿主必须把它传下来，
       * 否则"总时长有界"只对同进程插件成立 —— 隔离插件的 50 个挂死 teardown
       * 照样能让子进程的卸载拖到 N × 单项超时。
       */
      readonly disposeBudgetMs: number
    }
  /**
   * 配置变化推送。
   *
   * 为什么是"推送"而不是"子进程去问"：VSCode 的 `WorkspaceConfiguration.get()` 是**同步**的。
   * 若让子进程按需向宿主查询，它只能返回 Promise —— 那就成了"类型是同步、实际异步"的假接口。
   * 所以宿主在配置变化时主动把新值推过来，子进程侧始终读本地缓存（ADR-0016）。
   */
  | { readonly kind: 'configChanged'; readonly values: Readonly<Record<string, unknown>> }
  /** 宿主 → 子进程的事件转发。`subscription` 是宿主分配的句柄，子进程按它派发给对应监听器。 */
  | { readonly kind: 'event'; readonly subscription: number; readonly payload: SerializedSaveEvent }
  /**
   * 宿主 → 子进程的**服务方法调用**（ADR-0019）。
   *
   * 与命令的 `invoke` 是同一类：函数传不过 IPC，所以"调用一个方法"必须变成
   * "请对方在自己的进程里执行并回传结果"。
   */
  | {
      readonly kind: 'invokeService'
      readonly requestId: number
      readonly service: string
      readonly method: string
      readonly args: readonly unknown[]
    }
  | { readonly kind: 'response'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly kind: 'response'; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly kind: 'invoke'; readonly requestId: number; readonly command: string; readonly args: readonly unknown[] }
  | { readonly kind: 'deactivate' }

/** 子进程 → 宿主。 */
export type ChildToHost =
  | { readonly kind: 'ready'; readonly protocolVersion: number; readonly pid: number }
  | { readonly kind: 'activated' }
  | { readonly kind: 'deactivated' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'call'; readonly id: number; readonly method: HostMethod; readonly args: readonly unknown[] }
  | { readonly kind: 'result'; readonly requestId: number; readonly ok: true; readonly value: unknown }
  | { readonly kind: 'result'; readonly requestId: number; readonly ok: false; readonly error: string }
  | { readonly kind: 'log'; readonly level: LogLevel; readonly message: string }
  | { readonly kind: 'serviceResult'; readonly requestId: number; readonly ok: true; readonly value: unknown }
  | { readonly kind: 'serviceResult'; readonly requestId: number; readonly ok: false; readonly error: string }

export function errorToWire(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * 调用点前置校验：参数必须能被 structured clone（ADR-0019 未覆盖第 1 条的补齐）。
 *
 * 为什么必须在**调用点**做：IPC 用 `serialization: 'advanced'`，不可克隆的值会在传输层抛
 * `DataCloneError`，错误里既没有"第几个参数"也没有路径；类实例更糟 —— 它**不报错**，
 * 但原型与方法被静默丢掉。这里把问题变成一条能直接照着改的错误。
 *
 * 同进程消费者代理（宿主侧）与隔离消费者代理（子进程侧）共用它，保证文案一致。
 */
export function assertCloneableArgs(service: string, method: string, args: readonly unknown[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const problem = inspectCloneable(args[index])
    if (problem !== undefined) {
      throw new Error(
        formatCloneProblem(`远程服务 "${service}" 的方法 "${method}" 的第 ${index} 个参数`, problem),
      )
    }
  }
}

/** 返回值方向的同一套校验；可克隆时返回 `undefined`。 */
export function describeCloneProblem(what: string, value: unknown): string | undefined {
  const problem = inspectCloneable(value)
  return problem === undefined ? undefined : formatCloneProblem(what, problem)
}

/**
 * 隔离模式下明确不支持的能力。
 *
 * 宁可**响亮地失败**，也不给一个"类型是同步、实际返回 Promise"的假接口 ——
 * 后者会让插件作者在运行时才发现语义完全不同。每个原因都写清"为什么"和"何时会有"。
 */
export const ISOLATION_UNSUPPORTED: Readonly<Record<string, string>> = {
  'workspace.onDidSaveTextDocument':
    '`ctx.vscode.workspace.onDidSaveTextDocument` 在隔离模式下不可用：它的回调参数是 `TextDocument`，' +
    '带 `getText()` / `positionAt()` 这类**同步方法**，跨进程没法诚实履行。\n' +
    '请改用 **`ctx.async.onDidSaveTextDocument`** —— 那份 API 在两种模式下签名一致，' +
    '回调收到的是纯数据快照 + 显式异步的 `getText()`。详见 ADR-0018。',
  'services.syncConsumer':
    '隔离模式下不能用 `ctx.use` / `ctx.tryUse`：它们的类型是**同步**的（`clock.now()` 返回 `Date`），\n' +
    '而跨进程的服务调用只能是异步的。\n' +
    '    · 如果提供者也在隔离进程里 → 用 **`ctx.async.useService(name)`**（锚定 ADR-0019）；\n' +
    '    · 如果提供者在同进程里 → 隔离模式**无法**取用（活对象过不去），请改用 trust: trusted。',
  'services.graph':
    '隔离模式下拿不到 `ctx.graph()` 的依赖图快照：图在宿主的注册表里，而子进程只有自己的一份。' +
    '要看依赖图请在宿主里用 `vscordis: 显示运行时状态`，或用 CLI 的 `vscordis tree`。',
}

export function unsupportedReason(member: string): string {
  return ISOLATION_UNSUPPORTED[member] ?? `隔离模式不支持 ${member}`
}
