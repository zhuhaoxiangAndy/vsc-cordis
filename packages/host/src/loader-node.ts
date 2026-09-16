import { createRequire } from 'node:module'
import * as path from 'node:path'
import { resolvePluginExport, type CordisPlugin } from '@vscordis/sdk'
import type { LoadedPluginModule, PluginEntry } from '@vscordis/kernel'
import { PluginIntegrityError, verifyPluginArtifact } from './integrity.ts'
import {
  PluginEntryNotFoundError,
  PluginPathEscapeError,
  isInside,
  realRootOrResolved,
  resolveWithinRoot,
} from './paths.ts'

/**
 * Node 侧的 in-process 模块加载器（trust: trusted 专用，ADR-0003）。
 *
 * 职责边界很窄，但每一处都对应一条真实约束：
 *
 * 1. **路径 containment**：`main` 必须经 realpath 后仍落在插件根目录内。
 *    清单校验只做纯字符串检查（拒绝 `..`），防不住 symlink 逃逸，所以这里必须再查一次真实路径。
 * 2. **加载前先校验完整性/签名**：校验必须在 `require` **之前**，否则恶意代码已经被求值了。
 * 3. **加载前先遗忘**：反复 reload 时，前一次 incarnation 的缓存必须已经不在 require.cache 里，
 *    否则会拿到旧模块（"热重载无效"的经典成因）。
 * 4. **卸载 = 清空插件目录下所有缓存条目**，不只是入口那一条：
 *    未打包的多文件插件会 require 自己的子文件，只删入口会留下整棵残留树。
 * 5. **诚实说明**：清 require.cache 只能保证"下次 require 重新求值"，
 *    并不能强制回收仍然可达的闭包。所以 in-process 层的"无残留"是**尽力而为**，
 *    真正确凿的回收只能靠子进程 kill（M4b）。同理，完整性校验只保证"代码没被换过"，
 *    不保证"代码是善意的" —— 同进程沙箱不存在（ADR-0003）。
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

/** 完整性/签名策略。由宿主按插件来源决定：工作区插件可未签名，globalStorage 插件必须签名。 */
export interface IntegrityPolicy {
  /** 宿主内置公钥（PEM）。未配置时任何签名都会判为「无法验证」。 */
  readonly publicKeyPem: string | undefined
  /** 对给定插件是否强制要求签名。 */
  readonly requireSignature: (entry: PluginEntry) => boolean
}

export interface NodeModuleLoaderOptions {
  /** 每次成功加载/卸载后的调试信息出口。 */
  readonly onLog?: (message: string) => void
  /** 不配置 = 完全不校验（仅供单元测试构造夹具时使用）。 */
  readonly integrity?: IntegrityPolicy
}

// 这些符号现在住在 paths.ts，但既有调用点（含测试）习惯从 loader 引入，故此处保留再导出。
export { PluginEntryNotFoundError, PluginPathEscapeError, isInside, resolveWithinRoot }

export class NodeModuleLoader {
  readonly #onLog: ((message: string) => void) | undefined
  readonly #integrity: IntegrityPolicy | undefined

  constructor(options: NodeModuleLoaderOptions = {}) {
    this.#onLog = options.onLog
    this.#integrity = options.integrity
  }

  load(entry: PluginEntry): LoadedPluginModule {
    const candidate = path.resolve(entry.root, entry.manifest.main)
    const resolved = resolveWithinRoot(entry.root, candidate)

    // 校验放在 require 之前：否则被篡改的代码已经被求值了，校验毫无意义。
    this.#verify(entry)

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

  #verify(entry: PluginEntry): void {
    const policy = this.#integrity
    if (policy === undefined) return

    const outcome = verifyPluginArtifact({
      root: entry.root,
      publicKeyPem: policy.publicKeyPem,
      requireSignature: policy.requireSignature(entry),
    })

    if (!outcome.ok) {
      throw new PluginIntegrityError(entry.manifest.id, outcome.reason)
    }
    this.#onLog?.(`完整性校验通过：${entry.manifest.id}（模式 ${outcome.mode}）`)
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
