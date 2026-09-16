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
  | 'log'

export interface IsolatedPermissions {
  readonly commands: {
    readonly register: boolean
    readonly execute: boolean
    readonly executeAny: boolean
  }
  readonly window: {
    readonly messages: boolean
    readonly output: boolean
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

/** 宿主 → 子进程。 */
export type HostToChild =
  | {
      readonly kind: 'activate'
      readonly protocolVersion: number
      readonly pluginId: string
      readonly pluginEntry: string
      readonly permissions: IsolatedPermissions
      readonly workspaceFolders: readonly SerializedWorkspaceFolder[]
      readonly disposeTimeoutMs: number
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

export function errorToWire(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * 隔离模式下明确不支持的能力。
 *
 * 宁可**响亮地失败**，也不给一个"类型是同步、实际返回 Promise"的假接口 ——
 * 后者会让插件作者在运行时才发现语义完全不同。每个原因都写清"为什么"和"何时会有"。
 */
export const ISOLATION_UNSUPPORTED: Readonly<Record<string, string>> = {
  'window.createStatusBarItem':
    '隔离模式下暂不支持状态栏项：它需要一个能读写属性的代理对象，属于 M4c 的范围。' +
    '如果你不需要隔离，可以把插件改为 trust: trusted（见 ADR-0003 的说明：trusted 只防误用、不防恶意）。',
  'workspace.getConfiguration':
    '隔离模式下暂不支持读取配置：同步语义要求宿主在激活时按"插件声明的配置键"预取快照，' +
    '这需要在 plugin.json 里引入 configuration 声明，属于 M4c 的范围。',
  'workspace.onDidSaveTextDocument':
    '隔离模式下暂不支持事件订阅：需要宿主→子进程的事件转发通道，属于 M4c 的范围。',
}

export function unsupportedReason(member: string): string {
  return ISOLATION_UNSUPPORTED[member] ?? `隔离模式不支持 ${member}`
}
