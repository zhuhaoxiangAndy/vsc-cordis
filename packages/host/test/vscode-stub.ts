/**
 * 测试用的 `vscode` 模块替身（由 `bridge.spec.ts` 通过 `module.registerHooks` 注入）。
 *
 * 只实现 `bridge.ts` 真正用到的成员，外加测试需要的观察点（命令表、事件发射、dispose 计数）。
 *
 * ⚠️ **边界**：它验证的是**桥接层自己的逻辑** —— 权限门、命令表记账、副作用回收、
 * 只读配置视图、事件订阅的建立与撤销。它**不能**证明真实 Electron 里的行为
 * （例如 Node 权限模型是否可用），那仍然需要 `docs/acceptance-quick.md` 的手动验收。
 */

export interface StubStatusBarItem {
  text: string
  tooltip: string
  command: string
  color: string
  name: string
  accessibilityInformation: unknown
  disposed: number
  show(): void
  hide(): void
  dispose(): void
}

export interface StubOutputChannel {
  readonly name: string
  readonly lines: string[]
  disposed: number
  shown: boolean
  appendLine(line: string): void
  trace(message: string): void
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  show(): void
  hide(): void
  dispose(): void
}

class StubDisposable {
  readonly #onDispose: (() => void) | undefined

  constructor(onDispose?: () => void) {
    this.#onDispose = onDispose
  }

  dispose(): void {
    this.#onDispose?.()
  }
}

export const state = {
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  executed: [] as { command: string; args: readonly unknown[] }[],
  messages: [] as string[],
  statusBarItems: [] as StubStatusBarItem[],
  outputChannels: [] as StubOutputChannel[],
  saveListeners: new Set<(document: unknown) => void>(),
  activeEditorListeners: new Set<(editor: unknown) => void>(),
  config: new Map<string, unknown>(),
  configUpdates: [] as { section: string; key: string; value: unknown }[],
}

/** 每条用例前清空（测试之间不串味）。 */
export function resetStub(): void {
  state.commands.clear()
  state.executed.length = 0
  state.messages.length = 0
  state.statusBarItems.length = 0
  state.outputChannels.length = 0
  state.saveListeners.clear()
  state.activeEditorListeners.clear()
  state.config.clear()
  state.configUpdates.length = 0
}

/** 测试用：模拟一次"文档已保存"。 */
export function emitSave(uri = 'file:///stub/doc.ts'): void {
  const document = {
    uri: { toString: () => uri, fsPath: uri.replace(/^file:\/\//, '') },
    languageId: 'plaintext',
    lineCount: 1,
    version: 1,
    getText: () => 'stub',
  }
  for (const listener of [...state.saveListeners]) listener(document)
}

/** 测试用：模拟一次"活动编辑器变化"；`undefined` = 没有活动编辑器。 */
export function emitActiveEditor(editor: unknown): void {
  for (const listener of [...state.activeEditorListeners]) listener(editor)
}

/** 测试用：设置 `section.key` 的配置值（`workspace.getConfiguration(section).get(key, …)` 会读到）。 */
export function setConfig(section: string, key: string, value: unknown): void {
  state.config.set(`${section}.${key}`, value)
}

/** 真实 API 里 `vscode.version` 是一个字符串常量；runtime 会把它作为 engines.vscode 的比对值。 */
export const version = '0.0.0-stub'

export const commands = {
  registerCommand(command: string, callback: (...args: unknown[]) => unknown): StubDisposable {
    state.commands.set(command, callback)
    return new StubDisposable(() => {
      state.commands.delete(command)
    })
  },

  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    state.executed.push({ command, args })
    const handler = state.commands.get(command)
    // 未注册 = 真实 VSCode 里的内建命令：stub 只记录，不当作错误
    return handler === undefined ? undefined : await handler(...args)
  },
}

export const window = {
  async showInformationMessage(message: string): Promise<string | undefined> {
    state.messages.push(`info:${message}`)
    return undefined
  },
  async showWarningMessage(message: string): Promise<string | undefined> {
    state.messages.push(`warn:${message}`)
    return undefined
  },
  async showErrorMessage(message: string): Promise<string | undefined> {
    state.messages.push(`error:${message}`)
    return undefined
  },

  createStatusBarItem(): StubStatusBarItem {
    const item: StubStatusBarItem = {
      text: '',
      tooltip: '',
      command: '',
      color: '',
      name: '',
      accessibilityInformation: undefined,
      disposed: 0,
      show: () => undefined,
      hide: () => undefined,
      dispose: () => {
        item.disposed += 1
      },
    }
    state.statusBarItems.push(item)
    return item
  },

  createOutputChannel(name: string): StubOutputChannel {
    const channel: StubOutputChannel = {
      name,
      lines: [],
      disposed: 0,
      shown: false,
      appendLine: (line: string) => {
        channel.lines.push(line)
      },
      trace: (message: string) => {
        channel.lines.push(`[trace] ${message}`)
      },
      debug: (message: string) => {
        channel.lines.push(`[debug] ${message}`)
      },
      info: (message: string) => {
        channel.lines.push(`[info] ${message}`)
      },
      warn: (message: string) => {
        channel.lines.push(`[warn] ${message}`)
      },
      error: (message: string) => {
        channel.lines.push(`[error] ${message}`)
      },
      show: () => {
        channel.shown = true
      },
      hide: () => {
        channel.shown = false
      },
      dispose: () => {
        channel.disposed += 1
      },
    }
    state.outputChannels.push(channel)
    return channel
  },

  onDidChangeActiveTextEditor(listener: (editor: unknown) => void): StubDisposable {
    state.activeEditorListeners.add(listener)
    return new StubDisposable(() => {
      state.activeEditorListeners.delete(listener)
    })
  },
}

export const workspace = {
  workspaceFolders: undefined as unknown,

  getConfiguration(section?: string) {
    const fullKey = (key: string): string => `${section ?? ''}.${key}`
    return {
      get: (key: string, fallback?: unknown): unknown =>
        state.config.has(fullKey(key)) ? state.config.get(fullKey(key)) : fallback,
      has: (key: string): boolean => state.config.has(fullKey(key)),
      inspect: (): undefined => undefined,
      update: (key: string, value: unknown): Promise<void> => {
        state.configUpdates.push({ section: section ?? '', key, value })
        state.config.set(fullKey(key), value)
        return Promise.resolve()
      },
    }
  },

  onDidSaveTextDocument(listener: (document: unknown) => void): StubDisposable {
    state.saveListeners.add(listener)
    return new StubDisposable(() => {
      state.saveListeners.delete(listener)
    })
  },
}

// bridge.ts 里作为"构造函数类工具"直接放行的成员（无副作用）
export class Uri {}
export class Disposable {
  dispose(): void {}
}
export class EventEmitter {}
