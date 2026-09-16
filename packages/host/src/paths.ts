import { realpathSync } from 'node:fs'
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
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export function realRootOrResolved(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return path.resolve(root)
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
