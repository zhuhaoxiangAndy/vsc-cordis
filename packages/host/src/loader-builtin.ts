import type { CordisPlugin } from '@vscordis/sdk'
import type { LoadedPluginModule, PluginEntry } from '@vscordis/kernel'

/**
 * Web 宿主的内置插件加载器（ADR-0006）。
 *
 * 浏览器里无法运行期加载代码（没有 require / importScripts / 嵌套 Worker），
 * 所以 Web 端的"插件"必须是**构建期由 esbuild 静态内联进宿主 bundle** 的模块。
 * 于是"动态加载"退化为"动态启停"：同一套 kernel 状态机、同一套依赖协调，
 * 只是模块来源从磁盘变成内存里的一张表。
 */

export interface BuiltinPlugin {
  readonly entry: PluginEntry
  readonly factory: () => CordisPlugin
}

export class UnknownBuiltinPluginError extends Error {
  constructor(id: string) {
    super(`内置插件未注册：${id}（Web 宿主只支持构建体内置插件）`)
    this.name = 'UnknownBuiltinPluginError'
  }
}

export class BuiltinModuleLoader {
  readonly #plugins = new Map<string, BuiltinPlugin>()

  constructor(plugins: readonly BuiltinPlugin[]) {
    for (const plugin of plugins) this.#plugins.set(plugin.entry.manifest.id, plugin)
  }

  get size(): number {
    return this.#plugins.size
  }

  list(): readonly BuiltinPlugin[] {
    return [...this.#plugins.values()]
  }

  load(entry: PluginEntry): LoadedPluginModule {
    const builtin = this.#plugins.get(entry.manifest.id)
    if (builtin === undefined) throw new UnknownBuiltinPluginError(entry.manifest.id)
    // 内置插件的代码常驻内存，卸载只需丢弃工厂产物（状态随 EffectStack 回收而消失）。
    return { plugin: builtin.factory(), release: (): void => {} }
  }
}
