import * as vscode from 'vscode'
import type { LogLevel, Permission, PluginVscodeApi } from '@vscordis/sdk'
import { PermissionDeniedError, describe } from '@vscordis/kernel'
import type { CreateApiDeps, HostPort, LoadedPluginModule, PluginEntry } from '@vscordis/kernel'

/**
 * VSCode 适配层：kernel 与真实 API 之间的**唯一**接触面。
 *
 * 三个核心机制：
 *
 * 1. **受控面**：插件拿到的是 `PluginVscodeApi`（由真实 API `Pick` 出来的子集），
 *    不是 `typeof import('vscode')`。宿主不把 vscode 模块给插件 —— 因为扩展宿主本身
 *    会把 vscode 注入给扩展目录下的任何模块（ADR-0003），我们能做的是"不主动给 + 构建期禁止"。
 * 2. **调用时刻鉴权**：每个成员的包装函数在**被调用时**校验权限（不是创建代理时），
 *    于是插件运行中权限被撤销（未来特性）也能立刻生效。
 * 3. **自动登记副作用**：所有 `register*` / `create*` 的返回值都会被挂到调用者的
 *    EffectStack 上。插件即使忘写 `ctx.effect` 也不会泄漏（有对应测试）。
 */

export interface ModuleLoader {
  load(entry: PluginEntry): LoadedPluginModule | Promise<LoadedPluginModule>
}

export interface BridgeOptions {
  readonly platform: 'node' | 'web'
  readonly supportsIsolation: boolean
  readonly output: vscode.LogOutputChannel
  readonly loader: ModuleLoader
}

export interface PluginCommandInfo {
  readonly command: string
  readonly owner: string
}

export class VscodeBridge implements HostPort {
  readonly platform: 'node' | 'web'
  readonly supportsIsolation: boolean

  readonly #output: vscode.LogOutputChannel
  readonly #loader: ModuleLoader
  /** 活命令表：commandId → 提供者插件 id。QuickPick 代理与 executeCommand 鉴权都读它。 */
  readonly #commands = new Map<string, string>()

  constructor(options: BridgeOptions) {
    this.platform = options.platform
    this.supportsIsolation = options.supportsIsolation
    this.#output = options.output
    this.#loader = options.loader
  }

  async loadModule(entry: PluginEntry): Promise<LoadedPluginModule> {
    return await this.#loader.load(entry)
  }

  /**
   * 「运行插件命令…」的数据源（ADR-0002）。
   * 运行时注册的命令不会出现在命令面板，所以宿主必须自己提供一个动态入口。
   */
  livePluginCommands(): readonly PluginCommandInfo[] {
    return [...this.#commands.entries()]
      .map(([command, owner]) => ({ command, owner }))
      .sort((a, b) => a.command.localeCompare(b.command))
  }

  log(level: LogLevel, message: string, meta?: Readonly<Record<string, unknown>>): void {
    const suffix = meta === undefined || Object.keys(meta).length === 0 ? '' : ` ${safeJson(meta)}`
    const line = `${message}${suffix}`
    switch (level) {
      case 'trace':
        this.#output.trace(line)
        break
      case 'debug':
        this.#output.debug(line)
        break
      case 'info':
        this.#output.info(line)
        break
      case 'warn':
        this.#output.warn(line)
        break
      case 'error':
        this.#output.error(line)
        break
    }
  }

  createApi(deps: CreateApiDeps): PluginVscodeApi {
    const bridge = this
    const { effects, permissions } = deps

    const allow = (call: string, ...candidates: Permission[]): void => {
      if (candidates.some((candidate) => permissions.has(candidate))) return
      throw new PermissionDeniedError(deps.id, candidates.join(' 或 '), call)
    }

    /** 包装一个纯鉴权转发（用于只读 API）。 */
    const guard = <T>(permission: Permission, call: string, fn: (...args: never[]) => unknown): T =>
      ((...args: unknown[]) => {
        allow(call, permission)
        return (fn as (...inner: unknown[]) => unknown)(...args)
      }) as unknown as T

    /**
     * 包装一个"会注册资源"的 API：自动登记逆操作，并把 dispose 变成幂等。
     *
     * `onRelease` 用来把**同一份释放路径**同时用于"插件提前 dispose"与"EffectStack 回收"——
     * 两处分开写就是两处漂移的起点（命令表清理曾经只在卸载时发生）。
     */
    const track = <T>(
      permission: Permission,
      call: string,
      create: () => vscode.Disposable,
      onRelease?: () => void,
    ): T => {
      allow(call, permission)
      const raw = create()
      // ⚠️ 必须先抓住**原始** dispose：下面会把它覆盖成 release，
      // 否则 release 里的 `raw.dispose()` 会调用 release 自己（递归守卫直接 return），
      // 真正的底层 dispose 永远不执行 —— 表现为"命令从 QuickPick 消失了，
      // 但 VSCode 的命令注册表里还留着"（bridge.spec.ts 钉住了这条）。
      const originalDispose = raw.dispose.bind(raw)
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        originalDispose()
        onRelease?.()
      }
      effects.add(release, call)
      Object.defineProperty(raw, 'dispose', { value: release, configurable: true, writable: true })
      return raw as unknown as T
    }

    const api = {
      commands: {
        registerCommand: ((command: string, callback: (...args: never[]) => unknown) => {
          // 命令 ID 是全局命名空间：禁止插件覆盖别的插件的命令（否则后者可以静默劫持）。
          // 与隔离子进程的 VscodeHostApi 保持同一条归属规则。
          const existingOwner = bridge.#commands.get(command)
          if (existingOwner !== undefined && existingOwner !== deps.id) {
            throw new PermissionDeniedError(
              deps.id,
              'vscode:commands.register',
              `命令 ID "${command}" 已被插件 "${existingOwner}" 注册`,
            )
          }
          const disposable = track<vscode.Disposable>(
            'vscode:commands.register',
            `command:${command}`,
            () => vscode.commands.registerCommand(command, callback as (...args: unknown[]) => unknown),
            // 命令表清理与资源释放走同一条路径：插件**提前** dispose 时 QuickPick 里的条目
            // 也要立刻消失，否则会留下一个点了报错的幽灵条目。
            () => {
              if (bridge.#commands.get(command) === deps.id) bridge.#commands.delete(command)
            },
          )
          bridge.#commands.set(command, deps.id)
          return disposable
        }) as unknown as typeof vscode.commands.registerCommand,

        executeCommand: (async (command: string, ...args: unknown[]) => {
          if (!permissions.has('vscode:commands.execute.any')) {
            if (!permissions.has('vscode:commands.execute')) {
              throw new PermissionDeniedError(deps.id, 'vscode:commands.execute', `executeCommand(${command})`)
            }
            if (!bridge.#commands.has(command)) {
              // 只允许执行"由 vscordis 插件注册"的命令；执行 VSCode 内建命令需要 .any 权限。
              throw new PermissionDeniedError(
                deps.id,
                'vscode:commands.execute',
                `executeCommand(${command})：仅允许执行已注册的 vscordis 插件命令，如需任意命令请申请 vscode:commands.execute.any`,
              )
            }
          }
          return await vscode.commands.executeCommand(command, ...args)
        }) as unknown as typeof vscode.commands.executeCommand,
      },

      window: {
        showInformationMessage: guard<typeof vscode.window.showInformationMessage>(
          'vscode:window.messages',
          'showInformationMessage',
          (...args: unknown[]) => vscode.window.showInformationMessage(...(args as [string])),
        ),
        showWarningMessage: guard<typeof vscode.window.showWarningMessage>(
          'vscode:window.messages',
          'showWarningMessage',
          (...args: unknown[]) => vscode.window.showWarningMessage(...(args as [string])),
        ),
        showErrorMessage: guard<typeof vscode.window.showErrorMessage>(
          'vscode:window.messages',
          'showErrorMessage',
          (...args: unknown[]) => vscode.window.showErrorMessage(...(args as [string])),
        ),
        createStatusBarItem: ((alignment?: vscode.StatusBarAlignment, priority?: number) =>
          track<vscode.StatusBarItem>('vscode:window.statusbar', 'statusBarItem', () =>
            vscode.window.createStatusBarItem(alignment, priority),
          )) as unknown as typeof vscode.window.createStatusBarItem,
        createOutputChannel: ((name: string) =>
          track<vscode.OutputChannel>('vscode:window.output', `outputChannel:${name}`, () =>
            vscode.window.createOutputChannel(name),
          )) as unknown as typeof vscode.window.createOutputChannel,
        // 活动编辑器事件挂在 window 下（与 `PluginVscodeApi.window` 的类型、子进程代理
        // 与 kernel 同进程适配器一致）；但**读的是工作区内容**，所以权限归 workspace.read。
        // ⚠️ 曾经错放在 workspace 下：类型断言把它藏住了，真实宿主里同进程的
        // `ctx.async.onDidChangeActiveTextEditor` 会拿到 undefined —— 由 bridge.spec.ts 钉住。
        onDidChangeActiveTextEditor: ((listener: (editor: vscode.TextEditor | undefined) => unknown) =>
          track<vscode.Disposable>('vscode:workspace.read', 'onDidChangeActiveTextEditor', () =>
            vscode.window.onDidChangeActiveTextEditor(listener),
          )) as unknown as typeof vscode.window.onDidChangeActiveTextEditor,
      },

      workspace: {
        get workspaceFolders(): readonly vscode.WorkspaceFolder[] | undefined {
          allow('workspaceFolders', 'vscode:workspace.read')
          return vscode.workspace.workspaceFolders
        },
        getConfiguration: guard<typeof vscode.workspace.getConfiguration>(
          'vscode:workspace.config.read',
          'getConfiguration',
          (section?: string) => {
            const config = vscode.workspace.getConfiguration(section)
            if (permissions.has('vscode:workspace.config.write')) return config
            // 只读视图：插件即使拿到了配置对象也无法写入（否则 read 权限等于 write 权限）。
            return {
              get: (key: string, fallback?: unknown) => config.get(key, fallback as never),
              has: (key: string) => config.has(key),
              inspect: (key: string) => config.inspect(key),
              update: (): never => {
                throw new PermissionDeniedError(deps.id, 'vscode:workspace.config.write', 'WorkspaceConfiguration.update')
              },
            } as unknown as vscode.WorkspaceConfiguration
          },
        ),
        onDidSaveTextDocument: ((listener: (document: vscode.TextDocument) => unknown) =>
          track<vscode.Disposable>('vscode:workspace.read', 'onDidSaveTextDocument', () =>
            vscode.workspace.onDidSaveTextDocument(listener),
          )) as unknown as typeof vscode.workspace.onDidSaveTextDocument,
      },

      // 构造函数类成员是无副作用的工具，直接放行（插件需要它们来构造 Uri / 事件 / 清理器）。
      Uri: vscode.Uri,
      Disposable: vscode.Disposable,
      EventEmitter: vscode.EventEmitter,
    }

    return api as unknown as PluginVscodeApi
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return describe(value)
  }
}
