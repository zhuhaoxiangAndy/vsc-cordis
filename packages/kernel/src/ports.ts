import type {
  CordisPlugin,
  EffectScopeApi,
  LogLevel,
  Logger,
  Permission,
  PluginId,
  PluginVscodeApi,
} from '@vscordis/sdk'
import type { NormalizedManifest } from './manifest.ts'

/**
 * 依赖倒置端口：kernel 通过它向外要能力，host 提供实现。
 *
 * 这条边界带来三个直接好处：
 * 1. kernel 可以零 `vscode`、零 Node 依赖，从而在纯 Node 单测与 Web Worker 里都能跑；
 * 2. 隔离后端可以整体替换（in-process / child_process / Web 内置），而内核状态机完全不变；
 * 3. 「不可信插件拒绝加载」这条策略有了一个明确的判定点：`supportsIsolation`。
 */

export type PluginSource = 'builtin' | 'workspace' | 'global'

export interface PluginEntry {
  /** 插件根目录的绝对路径（Web 内置插件用逻辑标识）。 */
  readonly root: string
  /** 入口文件绝对路径；必须落在 `root` 之内。 */
  readonly mainPath: string
  readonly manifest: NormalizedManifest
  readonly source: PluginSource
}

export interface LoadedPluginModule {
  readonly plugin: CordisPlugin
  /** 释放模块引用与模块缓存（Node 侧即删除 require.cache 中该插件目录下的全部条目）。 */
  readonly release: () => void
}

export interface CreateApiDeps {
  readonly id: PluginId
  readonly permissions: ReadonlySet<Permission>
  readonly effects: EffectScopeApi
  readonly log: Logger
}

export interface HostPort {
  readonly platform: 'node' | 'web'
  /**
   * 是否具备执行**不可信**插件的能力。
   * `false` 时 kernel 会拒绝加载 `trust: untrusted` 的插件（ADR-0003 fail-closed），
   * 而不是退化成同进程执行。
   */
  readonly supportsIsolation: boolean
  loadModule(entry: PluginEntry): Promise<LoadedPluginModule>
  createApi(deps: CreateApiDeps): PluginVscodeApi
  log(level: LogLevel, message: string, meta?: Readonly<Record<string, unknown>>): void
}
