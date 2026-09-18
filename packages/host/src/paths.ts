import { readdirSync, realpathSync } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import * as path from 'node:path'

/**
 * 路径安全工具。
 *
 * 单独成模块是为了避免循环依赖：loader 需要用完整性校验（integrity），
 * 而 integrity 又需要 isInside —— 于是两者都依赖本模块，而不是互相依赖。
 */

export class PluginEntryNotFoundError extends Error {
  constructor(candidate: string, root: string) {
    super(`插件入口不存在：${candidate}（是否忘记构建？在仓库根目录运行 npm run build）`)
    this.name = 'PluginEntryNotFoundError'
  }
}

export class PluginPathEscapeError extends Error {
  constructor(candidate: string, root: string) {
    super(`路径越出插件根目录：${candidate} 不在 ${root} 之内（拒绝加载）`)
    this.name = 'PluginPathEscapeError'
  }
}

/** `target` 是否位于 `root` 之内（不含 root 自身）。用 path.relative，Windows 下自动大小写不敏感。 */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  // 注意不能用 `startsWith('..')`：`<root>/..evil/x` 的 relative 是 `..evil/x`，仍在 root 内。
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

export function realRootOrResolved(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return path.resolve(root)
  }
}

function isNodeModulesName(name: string): boolean {
  return process.platform === 'win32' ? name.toLowerCase() === 'node_modules' : name === 'node_modules'
}

/**
 * 权限模型允许读取的路径列表：`pluginRoot` 的**顶层条目**，排除 `node_modules`。
 *
 * 为什么不直接 `--allow-fs-read=<pluginRoot>`：pnpm workspace 会在插件根下放
 * `node_modules/@vscordis/sdk -> packages/sdk` 这类外部链接；只要 root 被整体授权，
 * 任何名字匹配/伪装都无法阻止链接把读取带到 root 外（审计已端到端复现）。
 * 把 `node_modules` 从扫描和授权里同时移除，pnpm 链接不再需要“白名单”，
 * 藏在外面的恶意链接也因为没有授权而读不到。
 */
export function pluginReadPaths(root: string): readonly string[] {
  const realRoot = realRootOrResolved(root)
  let entries
  try {
    entries = readdirSync(realRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const paths: string[] = []
  for (const entry of entries) {
    if (isNodeModulesName(entry.name)) continue
    const full = path.join(realRoot, entry.name)
    // 外部链接已由 assertNoEscapingReparsePoints 拒绝（node_modules 外的部分）；
    // 这里保留链接路径本身，让 root 内链接仍可被读取（真实目标也在 root 内）。
    paths.push(full)
  }
  return paths.sort()
}

/**
 * 隔离前的 reparse point 校验（ADR-0020）。
 *
 * Node 权限模型的 `--allow-fs-read=<root>` 只对**路径字符串**做限制，不会解析 root 内的
 * 符号链接/junction。实测（Windows junction + Electron 39 / Node 22.22.1）：
 * root 内的 junction 可以读到 root 外文件，而普通 `..` 越界读会被 `ERR_ACCESS_DENIED` 拦住。
 * 因此必须在 fork 之前拒绝“指向 root 外”的链接，否则 `--permission` 给的是假边界。
 */
export class PluginReparsePointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginReparsePointError'
  }
}

/**
 * 递归扫描插件根目录：任何 symlink/junction 的 realpath 落在 root 之外都 fail-closed。
 *
 * 只允许“解析后仍在 root 内”的链接（monorepo/开发目录里可能有），并且不递归进链接目录
 * 本身（避免循环与重复扫描）；链接目标的真实路径会在正常目录遍历中被再次扫描到。
 * 插件根很小（`main` 必须是单文件 bundle），所以这里是可接受的加载期成本。
 */
export async function assertNoEscapingReparsePoints(root: string): Promise<void> {
  const realRoot = realRootOrResolved(root)
  const pending: string[] = [realRoot]

  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break

    const entries = await readdir(current, { withFileTypes: true }).catch(() => {
      throw new PluginReparsePointError(
        `无法读取插件目录以校验链接：${current}（fail-closed 拒绝加载，见 ADR-0020）`,
      )
    })

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (isNodeModulesName(entry.name)) {
        // 顶层 node_modules 是 pnpm 的正常布局：跳过扫描，同时它也不在
        // pluginReadPaths 里，所以里面的链接读不到。
        // 嵌套 node_modules 则是刻意隐藏链接的温床：既然 main 必须是单文件 bundle，
        // 正常插件不需要它，直接 fail-closed（否则外层目录被整体授权会带出链接读取权）。
        if (current !== realRoot) {
          throw new PluginReparsePointError(
            `插件目录内存在嵌套 node_modules：${full}。` +
              'main 必须是单文件 bundle；嵌套依赖目录会绕过链接扫描，拒绝加载（ADR-0020）。',
          )
        }
        continue
      }

      // Dirent.isSymbolicLink() 在 Windows 上对 junction 同样返回 true（已实测）。
      if (entry.isSymbolicLink()) {
        const target = await realpath(full).catch(() => {
          throw new PluginReparsePointError(
            `插件目录内的链接无法解析：${full}（fail-closed 拒绝加载，见 ADR-0020）`,
          )
        })

        const relative = path.relative(realRoot, target)
        const insideRoot =
          !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        if (!insideRoot) {
          throw new PluginReparsePointError(
            `插件目录内存在指向目录外的链接：${full} → ${target}。` +
              'Node 的 --allow-fs-read 会跟随链接，必须在 fork 前拒绝（ADR-0020）。',
          )
        }
        continue
      }
      if (entry.isDirectory()) pending.push(full)
    }
  }
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
