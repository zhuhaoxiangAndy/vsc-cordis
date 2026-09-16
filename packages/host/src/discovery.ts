import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import * as path from 'node:path'
import { validateManifest, type PluginEntry, type PluginSource } from '@vscordis/kernel'

/**
 * 插件发现：扫描若干根目录，寻找 `<root>/<name>/plugin.json`。
 *
 * 策略：
 * - 单个插件清单不合法 → 记入 `problems` 并**跳过**，不影响其它插件（不要因为一个坏插件炸掉整个启动）；
 * - id 重复 → 记入 problems 并跳过后者（否则注册表会出现"同名服务的第二个提供者"这类难查问题）；
 * - `main` 用纯字符串校验 + 再算一次相对路径 containment，真正的 realpath 校验在加载器里（防 symlink）；
 * - `${workspaceFolder}` 由本模块替换（VSCode 不对手工读取的配置做变量替换）。
 */

export interface PluginRoot {
  readonly dir: string
  readonly source: PluginSource
}

export interface DiscoveryResult {
  readonly entries: readonly PluginEntry[]
  readonly problems: readonly string[]
}

export const WORKSPACE_FOLDER_TOKEN = '${workspaceFolder}'

export function expandRootVariables(roots: readonly string[], workspaceFolders: readonly string[]): readonly string[] {
  const first = workspaceFolders[0] ?? ''
  return roots.map((root) => root.replaceAll(WORKSPACE_FOLDER_TOKEN, first))
}

export async function discoverPlugins(roots: readonly PluginRoot[]): Promise<DiscoveryResult> {
  const entries: PluginEntry[] = []
  const problems: string[] = []
  const claimed = new Set<string>()

  for (const root of roots) {
    let dirents: Dirent[]
    try {
      dirents = await fs.readdir(root.dir, { withFileTypes: true })
    } catch {
      // 根目录不存在是常态（比如 workspace 里还没有 .vscordis/plugins），不算问题。
      continue
    }

    const names = dirents
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .sort()

    for (const name of names) {
      const dir = path.join(root.dir, name)
      const manifestPath = path.join(dir, 'plugin.json')

      let text: string
      try {
        text = await fs.readFile(manifestPath, 'utf8')
      } catch {
        continue // 没有 plugin.json 的目录不是插件
      }

      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch (error) {
        problems.push(`${manifestPath} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
        continue
      }

      const validated = validateManifest(raw)
      if (!validated.ok) {
        problems.push(`${manifestPath} 校验失败：${validated.errors.join('; ')}`)
        continue
      }

      const manifest = validated.manifest
      if (claimed.has(manifest.id)) {
        problems.push(`插件 id 重复：${manifest.id}（${dir}）已被其它目录占用，跳过`)
        continue
      }

      const mainPath = path.resolve(dir, manifest.main)
      const relative = path.relative(dir, mainPath)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        problems.push(`${manifestPath} 的 main 解析后越出插件目录：${mainPath}`)
        continue
      }

      claimed.add(manifest.id)
      entries.push({ root: dir, mainPath, manifest, source: root.source })
    }
  }

  return { entries, problems }
}

/**
 * 依赖优先排序：被依赖的服务先加载的把握更大，消费者也就更可能在首次加载时直接激活，
 * 而不是先 parked 再被唤醒（正确性不依赖顺序 —— `paused` 会被自动唤醒，这里只是体验优化）。
 */
export function sortByDependencies(entries: readonly PluginEntry[]): readonly PluginEntry[] {
  return [...entries].sort((a, b) => {
    const delta = Object.keys(a.manifest.dependencies).length - Object.keys(b.manifest.dependencies).length
    return delta !== 0 ? delta : a.manifest.id.localeCompare(b.manifest.id)
  })
}
