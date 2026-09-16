import { readFileSync, realpathSync } from 'node:fs'
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

function readPackageName(directory: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const name = (parsed as { name?: unknown }).name
    return typeof name === 'string' && name.length > 0 ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * `node_modules` 下的外部链接只允许普通依赖链接：
 * `node_modules/<pkg>` / `node_modules/@scope/<pkg>`，且目标目录 `package.json#name` 必须等于链接名
 * （`@vscordis/sdk -> packages/sdk` 因此放行）。
 *
 * `node_modules/.bin` 的外部链接**不放行**：它是开发期产物，而插件 `main` 必须是单文件 bundle，
 * 运行期不需要它；"向上找 package.json" 的判定可能被家目录 package.json 放水，所以 fail-closed。
 * 指向 `.ssh` / 系统目录的任意链接仍然拒绝。
 */
function isAllowedDependencyLink(realRoot: string, link: string, target: string): boolean {
  const relative = path.relative(realRoot, link)
  const segments = relative.split(path.sep)

  let nodeModulesIndex = -1
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (segment === undefined) continue
    const isNodeModules =
      process.platform === 'win32' ? segment.toLowerCase() === 'node_modules' : segment === 'node_modules'
    if (isNodeModules) {
      nodeModulesIndex = index
      break
    }
  }
  if (nodeModulesIndex < 0) return false

  const tail = segments.slice(nodeModulesIndex + 1)
  const first = tail[0]
  if (first === undefined || first === '.bin') return false

  const packageName = first.startsWith('@') ? `${first}/${tail[1] ?? ''}` : first
  if (packageName.endsWith('/') || packageName.includes('..')) return false
  return readPackageName(target) === packageName
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
          // pnpm workspace 会把 `node_modules/@scope/pkg` 链接到仓库内另一个包（解析到 root 外）；
          // 这类依赖链接按“链接名 == 目标 package.json#name”白名单放行，其余逃逸链接仍拒绝。
          if (isAllowedDependencyLink(realRoot, full, target)) continue
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
