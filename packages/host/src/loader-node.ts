import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { resolvePluginExport, type CordisPlugin } from '@vscordis/sdk'
import type { LoadedPluginModule, PluginEntry } from '@vscordis/kernel'

/**
 * Node 侧的 in-process 模块加载器（trust: trusted 专用，ADR-0003）。
 *
 * 职责边界很窄，但每一处都对应一条真实约束：
 *
 * 1. **路径containment**：`main` 必须经 realpath 后仍落在插件根目录内。
 *    清单校验只做纯字符串检查（拒绝 `..`），防不住 symlink 逃逸，所以这里必须再查一次真实路径。
 * 2. **加载前先遗忘**：反复 reload 时，前一次 incarnation 的缓存必须已经不在 require.cache 里，
 *    否则会拿到旧模块（"热重载无效"的经典成因）。
 * 3. **卸载 = 清空插件目录下所有缓存条目**，不只是入口那一条：
 *    未打包的多文件插件会 require 自己的子文件，只删入口会留下整棵残留树。
 * 4. **诚实说明**：清 require.cache 只能保证"下次 require 重新求值"，
 *    并不能强制回收仍然可达的闭包。所以 in-process 层的"无残留"是**尽力而为**，
 *    真正确凿的回收只能靠子进程 kill（M4）。
 */

/**
 * 取一个可用的 CJS require。
 *
 * 两种运行形态都要成立：
 * - **生产**：宿主扩展被 esbuild 打成 CJS，全局 `require` 存在，直接用它（缓存就是我们熟悉的那张表）；
 * - **测试/原生 ESM**：`node --test` 直接跑 `.ts` 源码，此时没有全局 require，用 `createRequire` 造一个。
 *
 * `createRequire` 的锚点只影响**相对**说明符的解析，而本模块传给 require 的永远是绝对路径
 * （`main` 已在上游解析为 realpath），所以锚点取什么并不影响行为。
 */
function detectRequire(): NodeRequire {
  if (typeof require === 'function') return require
  return createRequire(path.join(process.cwd(), '__vscordis_cjs_anchor__.cjs'))
}

const nodeRequire: NodeRequire = detectRequire()

export interface NodeModuleLoaderOptions {
  /** 每次成功加载/卸载后的调试信息出口。 */
  readonly onLog?: (message: string) => void
}

export class PluginEntryNotFoundError extends Error {
  constructor(candidate: string, root: string) {
    super(`插件入口不存在：${candidate}（是否忘记构建？在仓库根目录运行 npm run build）`)
    this.name = 'PluginEntryNotFoundError'
  }
}

export class PluginPathEscapeError extends Error {
  constructor(candidate: string, root: string) {
    super(`插件入口越出插件根目录：${candidate} 不在 ${root} 之内（拒绝加载）`)
    this.name = 'PluginPathEscapeError'
  }
}

/** `target` 是否位于 `root` 之内（不含 root 自身）。用 path.relative，Windows 下自动大小写不敏感。 */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export function resolveWithinRoot(root: string, candidate: string): string {
  const realRoot = realRootOrResolved(root)
  let realCandidate: string
  try {
    realCandidate = realpathSync(candidate)
  } catch {
    throw new PluginEntryNotFoundError(candidate, root)
  }
  if (!isInside(realRoot, realCandidate)) {
    throw new PluginPathEscapeError(realCandidate, realRoot)
  }
  return realCandidate
}

function realRootOrResolved(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return path.resolve(root)
  }
}

export class NodeModuleLoader {
  readonly #onLog: ((message: string) => void) | undefined

  constructor(options: NodeModuleLoaderOptions = {}) {
    this.#onLog = options.onLog
  }

  load(entry: PluginEntry): LoadedPluginModule {
    const candidate = path.resolve(entry.root, entry.manifest.main)
    const resolved = resolveWithinRoot(entry.root, candidate)

    // 关键：加载前先把上一代 incarnation 从缓存里摘掉。
    this.#forget(entry.root)

    const exported: unknown = nodeRequire(resolved)
    const plugin: CordisPlugin = resolvePluginExport(exported)
    this.#onLog?.(`已加载插件模块 ${entry.manifest.id} ← ${resolved}`)

    let released = false
    return {
      plugin,
      release: (): void => {
        if (released) return
        released = true
        const removed = this.#forget(entry.root)
        this.#onLog?.(`已释放插件模块 ${entry.manifest.id}（清出 ${removed} 条 require.cache）`)
      },
    }
  }

  /** 清空插件根目录下的全部 require.cache 条目。返回清出条数。 */
  #forget(root: string): number {
    const realRoot = realRootOrResolved(root)
    let removed = 0
    for (const key of Object.keys(nodeRequire.cache)) {
      if (isInside(realRoot, key)) {
        delete nodeRequire.cache[key]
        removed += 1
      }
    }
    return removed
  }
}
