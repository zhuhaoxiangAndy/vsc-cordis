import * as vscode from 'vscode'
import type { Disposable, LogLevel, Permission } from '@vscordis/sdk'
import type { IsolatedHostApi } from './isolated-loader.ts'
import type { SerializedWorkspaceFolder } from './protocol.ts'

/**
 * `IsolatedHostApi` 的 VSCode 实现：隔离子进程唯一能触达的真实能力。
 *
 * 三个要点：
 *
 * 1. **句柄化**。子进程拿不到 `OutputChannel` 对象，只能拿到一个整数句柄。
 *    句柄表由本类持有，于是"插件 A 猜一个数字就能写进插件 B 的输出通道"这条路被堵死。
 * 2. **注册即记账**。每条命令都记下归属插件；子进程一死，`IsolatedSession` 会撤销它们。
 * 3. **执行命令的白名单**。只有 `vscode:commands.execute.any` 才允许执行任意命令；
 *    否则仅限"已注册的 vscordis 插件命令"。这一判定必须在宿主侧做 —— 子进程的自述不可信。
 */

export interface VscodeHostApiOptions {
  /** 用于判断某个命令是否属于 vscordis 插件（跨插件调用时需要）。 */
  readonly isPluginCommand: (command: string) => boolean
  /**
   * 查某个插件被授予的权限。
   *
   * 必须由宿主提供而不是让子进程自述 —— 否则插件只要在握手消息里写
   * `executeAny: true` 就能给自己提权。这条是**宿主侧权威判定**的一部分。
   */
  readonly permissionsOf: (pluginId: string) => ReadonlySet<Permission>
  readonly log: (level: LogLevel, message: string, meta?: Readonly<Record<string, unknown>>) => void
}

export class VscodeHostApi implements IsolatedHostApi {
  readonly #options: VscodeHostApiOptions
  readonly #outputs = new Map<number, vscode.OutputChannel>()
  readonly #commands = new Map<string, string>()
  #nextHandle = 1

  constructor(options: VscodeHostApiOptions) {
    this.#options = options
  }

  /** 当前由隔离子进程注册的活命令（供状态面板显示）。 */
  liveCommands(): readonly { command: string; pluginId: string }[] {
    return [...this.#commands.entries()]
      .map(([command, pluginId]) => ({ command, pluginId }))
      .sort((a, b) => a.command.localeCompare(b.command))
  }

  registerCommand(
    pluginId: string,
    command: string,
    invoke: (args: readonly unknown[]) => Promise<unknown>,
  ): Disposable {
    const disposable = vscode.commands.registerCommand(command, (...args: unknown[]) => invoke(args))
    this.#commands.set(command, pluginId)
    return {
      dispose: () => {
        if (this.#commands.get(command) === pluginId) this.#commands.delete(command)
        disposable.dispose()
      },
    }
  }

  unregisterCommand(command: string): void {
    // 句柄的 dispose 由 IsolatedSession 负责；这里只清归属记账。
    this.#commands.delete(command)
  }

  async executeCommand(pluginId: string, command: string, args: readonly unknown[]): Promise<unknown> {
    const granted = this.#options.permissionsOf(pluginId)
    if (!granted.has('vscode:commands.execute.any')) {
      if (!this.#commands.has(command) && !this.#options.isPluginCommand(command)) {
        throw new Error(
          `插件 ${pluginId} 只能执行已注册的 vscordis 插件命令；` +
            `拒绝执行 ${command}（如需任意命令请申请 vscode:commands.execute.any）`,
        )
      }
    }
    return await vscode.commands.executeCommand(command, ...args)
  }

  async showMessage(
    kind: 'information' | 'warning' | 'error',
    message: string,
    items: readonly string[],
  ): Promise<string | undefined> {
    const extra = items as string[]
    switch (kind) {
      case 'information':
        return await vscode.window.showInformationMessage(message, ...extra)
      case 'warning':
        return await vscode.window.showWarningMessage(message, ...extra)
      case 'error':
        return await vscode.window.showErrorMessage(message, ...extra)
    }
  }

  createOutputChannel(pluginId: string, name: string): number {
    // 通道名带上插件 id，避免两个插件用同名通道时互相覆盖。
    const channel = vscode.window.createOutputChannel(`${name} (${pluginId})`)
    const handle = this.#nextHandle++
    this.#outputs.set(handle, channel)
    return handle
  }

  appendOutputLine(handle: number, line: string): void {
    this.#outputs.get(handle)?.appendLine(line)
  }

  disposeOutput(handle: number): void {
    const channel = this.#outputs.get(handle)
    if (channel === undefined) return
    this.#outputs.delete(handle)
    channel.dispose()
  }

  workspaceFolders(): readonly SerializedWorkspaceFolder[] {
    // 必须降级成纯数据：`Uri` / `WorkspaceFolder` 是类实例，塞进 IPC 会破坏结构。
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      index: folder.index,
      uri: folder.uri.toString(),
      fsPath: folder.uri.fsPath,
    }))
  }

  log(pluginId: string, level: LogLevel, message: string): void {
    this.#options.log(level, message, { plugin: pluginId, isolated: true })
  }

  /** 释放全部宿主侧资源（宿主关闭时兜底）。 */
  dispose(): void {
    for (const handle of [...this.#outputs.keys()]) this.disposeOutput(handle)
    this.#commands.clear()
  }
}
