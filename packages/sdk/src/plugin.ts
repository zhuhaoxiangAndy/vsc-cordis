import type { PluginContext } from './context.ts'
import type { MaybePromise } from './disposable.ts'

/**
 * 插件作者实现的接口（对应 cordis 的 `plugin`：apply / inject / name）。
 *
 * 生命周期顺序（ADR-0007 决策 4）：
 *   activate(ctx) → ... → deactivate(ctx) → EffectStack.dispose()（LIFO 逆序）
 *
 * `deactivate` **先于**副作用回收执行，这样插件还能在服务与命令仍然存活时做体面收尾（flush / 落盘）。
 */
export interface CordisPlugin {
  readonly name?: string
  /** 声明的硬依赖服务名；与 plugin.json 的 `dependencies` 合并去重。 */
  readonly inject?: readonly string[]
  activate(ctx: PluginContext): MaybePromise<void>
  deactivate?(ctx: PluginContext): MaybePromise<void>
}

/** 纯类型辅助，让插件产物获得上下文推断。 */
export function definePlugin(plugin: CordisPlugin): CordisPlugin {
  return plugin
}

export class InvalidPluginExportError extends Error {
  constructor(detail: string) {
    super(`插件模块导出非法：${detail}`)
    this.name = 'InvalidPluginExportError'
  }
}

/**
 * 规范化插件模块的导出形态，接受：
 *   - `{ activate, deactivate? }`
 *   - `{ default: CordisPlugin }`（ESM 转 CJS 打包的常见形态）
 *   - `() => CordisPlugin` 或 `{ default: () => CordisPlugin }` 工厂
 */
export function resolvePluginExport(exported: unknown): CordisPlugin {
  const normalized = normalize(exported, 0)
  if (typeof normalized.activate !== 'function') {
    throw new InvalidPluginExportError('缺少 activate(ctx) 函数')
  }
  return normalized
}

function normalize(value: unknown, depth: number): Record<string, unknown> {
  if (depth > 3) throw new InvalidPluginExportError('导出嵌套过深（可能是循环 default）')
  if (typeof value === 'function') {
    return normalize((value as () => unknown)(), depth + 1)
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.activate === 'function') return record
    if ('default' in record) return normalize(record.default, depth + 1)
  }
  throw new InvalidPluginExportError(
    `期望得到 { activate } / { default } / 工厂函数，实际是 ${value === null ? 'null' : typeof value}`,
  )
}
