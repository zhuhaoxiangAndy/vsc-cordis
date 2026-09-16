/**
 * 测试替身：把 HostPort 换成一个纯内存实现，于是 kernel 的生命周期可以在**不启动 VSCode**的前提下
 * 被完整断言 —— 这是 ADR-0001「kernel 零 vscode 依赖」换来的最大收益。
 */
import type {
  CordisPlugin,
  Disposable,
  LogLevel,
  PluginId,
  PluginVscodeApi,
  Permission,
} from '@vscordis/sdk'
import { PermissionDeniedError } from '../src/errors.ts'
import type { NormalizedManifest } from '../src/manifest.ts'
import type { CreateApiDeps, HostPort, LoadedPluginModule, PluginEntry, PluginSource } from '../src/ports.ts'

export interface FakeCommand {
  readonly owner: PluginId
  readonly handler: (...args: unknown[]) => unknown
  disposed: boolean
}

export class FakeHostPort implements HostPort {
  readonly platform: 'node' | 'web'
  supportsIsolation: boolean
  readonly logs: { level: LogLevel; message: string; meta?: Readonly<Record<string, unknown>> }[] = []
  readonly commands = new Map<string, FakeCommand>()
  readonly moduleLoads: PluginId[] = []
  readonly moduleReleases: PluginId[] = []
  readonly apiCalls: string[] = []
  readonly factories = new Map<PluginId, () => CordisPlugin>()
  /** 让测试可以模拟"模块加载失败"或"activate 卡住"。 */
  loadDelayMs = 0

  constructor(options: { platform?: 'node' | 'web'; supportsIsolation?: boolean } = {}) {
    this.platform = options.platform ?? 'node'
    this.supportsIsolation = options.supportsIsolation ?? false
  }

  define(id: PluginId, factory: () => CordisPlugin): this {
    this.factories.set(id, factory)
    return this
  }

  async loadModule(entry: PluginEntry): Promise<LoadedPluginModule> {
    const factory = this.factories.get(entry.manifest.id)
    if (factory === undefined) throw new Error(`FakeHostPort 未注册该插件模块：${entry.manifest.id}`)
    if (this.loadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.loadDelayMs))
    this.moduleLoads.push(entry.manifest.id)

    let released = false
    return {
      plugin: factory(),
      release: (): void => {
        if (released) return
        released = true
        this.moduleReleases.push(entry.manifest.id)
      },
    }
  }

  createApi(deps: CreateApiDeps): PluginVscodeApi {
    const port = this

    const guard = (permission: Permission, call: string): void => {
      port.apiCalls.push(call)
      if (!deps.permissions.has(permission)) {
        throw new PermissionDeniedError(deps.id, permission, call)
      }
    }

    const api = {
      commands: {
        registerCommand(
          command: string,
          callback: (...args: unknown[]) => unknown,
        ): Disposable {
          guard('vscode:commands.register', `registerCommand(${command})`)
          const record: FakeCommand = { owner: deps.id, handler: callback, disposed: false }
          port.commands.set(command, record)
          return deps.effects.add(() => {
            if (record.disposed) return
            record.disposed = true
            if (port.commands.get(command) === record) port.commands.delete(command)
          }, `command:${command}`)
        },
        async executeCommand<T>(command: string, ...args: unknown[]): Promise<T> {
          guard('vscode:commands.execute', `executeCommand(${command})`)
          const record = port.commands.get(command)
          if (record === undefined) throw new Error(`command not found: ${command}`)
          return (await record.handler(...args)) as T
        },
      },
      window: {
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        createStatusBarItem: () => ({ dispose(): void {} }),
        createOutputChannel: () => ({ appendLine(): void {}, dispose(): void {} }),
      },
      workspace: {
        workspaceFolders: undefined,
        getConfiguration: () => ({ get: (): undefined => undefined }),
        onDidSaveTextDocument: () => ({ dispose(): void {} }),
      },
      Uri: class {},
      Disposable: class {},
      EventEmitter: class {},
    }

    return api as unknown as PluginVscodeApi
  }

  log(level: LogLevel, message: string, meta?: Readonly<Record<string, unknown>>): void {
    this.logs.push({ level, message, meta })
  }

  /** 模拟宿主侧的命令面板代理（ADR-0002）：只列出**活的**插件命令。 */
  liveCommands(): readonly string[] {
    return [...this.commands.keys()].filter((id) => this.commands.get(id)?.disposed !== true).sort()
  }

  logsFor(plugin: PluginId): readonly string[] {
    return this.logs.filter((entry) => entry.meta?.plugin === plugin).map((entry) => entry.message)
  }
}

export function makeManifest(id: PluginId, overrides: Partial<NormalizedManifest> = {}): NormalizedManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    main: 'dist/index.cjs',
    description: undefined,
    dependencies: {},
    permissions: [],
    trust: 'trusted',
    ...overrides,
  }
}

export function makeEntry(
  id: PluginId,
  overrides: Partial<NormalizedManifest> = {},
  source: PluginSource = 'workspace',
): PluginEntry {
  return {
    root: `/fake/${id}`,
    mainPath: `/fake/${id}/dist/index.cjs`,
    manifest: makeManifest(id, overrides),
    source,
  }
}
