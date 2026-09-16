#!/usr/bin/env node
/**
 * 文档链接检查（接入 `pnpm run verify` 与 CI）。
 *
 * 为什么值得做成门禁：这个仓库的**文档是交付物的一部分**（ADR、验收表、插件作者指南），
 * 而 Markdown 链接失效不会让任何测试变红 —— 只会让读者点到一个 404。历史上已经出现过
 * 一次"文档与实现不一致"（overview 里"服务跨进程 ❌"的过时描述），所以这里做机器检查。
 *
 * 规则：
 * - 检查两类引用：
 *   1. Markdown 链接 `[文字](相对路径)`；
 *   2. **行内代码里的仓库相对路径**（本仓库的引用大多写在反引号里，例如 `docs/adr/0002`）——
 *      只认以 docs/ scripts/ packages/ plugins/ .github/ .vscode/ 开头的**具体**路径，
 *      以及 `docs/adr/NNNN` 这种"编号短引用"（解析为 `NNNN-*.md`）。
 * - 跳过：`http(s)://` / `mailto:` / `data:` / 纯锚点；含通配 `*`、花括号、省略号 `…`、
 *   空格、`#`（上游源码行号）、`..` 的 token（那些是 glob、命令或简写，不是可校验的路径）。
 * - 跳过构建产物（`dist/`、`.vsix`）与包内简写（`host/bridge.ts`、`kernel/context.ts` 这类：
 *   它们相对哪个根都说得通，硬校验会制造误报 —— 这是本检查器**刻意划的边界**）。
 * - 代码块（```…```）先被剥掉；行内代码之外的普通正文不扫路径。
 * - 目标可以是文件或目录。
 *
 * 用法：`node scripts/check-doc-links.mjs [仓库根目录]`（默认本脚本的上一级）。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..')
const targetRoot = process.argv[2] === undefined ? DEFAULT_ROOT : path.resolve(process.argv[2])

const SKIP_PREFIXES = ['http://', 'https://', 'mailto:', 'data:', '#']
const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const INLINE_CODE_PATTERN = /`([^`]+)`/g
/** 可校验的仓库相对引用：不允许通配/花括号/省略号/空白/#/`..`。 */
const INLINE_REF_PATTERN = /^(?:docs|scripts|packages|plugins|\.github|\.vscode)\/[^\s*{}<>…$%#]+$/
/** `docs/adr/0002` 这类编号短引用。 */
const ADR_SHORT_PATTERN = /^docs\/adr\/(\d{4})$/

/** 剥掉围栏代码块：里面的内容是示例，不参与检查。 */
function stripFenced(text) {
  return text.replace(/```[\s\S]*?```/g, '')
}

async function collectMarkdown(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await collectMarkdown(full)))
    else if (entry.name.endsWith('.md')) found.push(full)
  }
  return found
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function main() {
  const files = []
  for (const candidate of ['README.md', 'CHANGELOG.md']) {
    const full = path.join(targetRoot, candidate)
    if (await exists(full)) files.push(full)
  }
  const docsDir = path.join(targetRoot, 'docs')
  if (await exists(docsDir)) files.push(...(await collectMarkdown(docsDir)))

  const problems = []
  let checked = 0

  const checkRef = async (file, display, resolved) => {
    checked += 1
    if (!(await exists(resolved))) {
      problems.push(`${path.relative(targetRoot, file)} → ${display}`)
    }
  }

  for (const file of files) {
    const text = stripFenced(await readFile(file, 'utf8'))
    const fileDir = path.dirname(file)

    // 1) Markdown 链接
    for (const match of text.matchAll(LINK_PATTERN)) {
      const link = match[1]
      if (SKIP_PREFIXES.some((prefix) => link.startsWith(prefix))) continue
      const target = link.split('#')[0].replace(/^<|>$/g, '')
      if (target === '') continue
      await checkRef(file, link, path.resolve(fileDir, decodeURIComponent(target)))
    }

    // 2) 行内代码里的仓库相对引用（本仓库的引用主要写在反引号里）
    for (const match of text.matchAll(INLINE_CODE_PATTERN)) {
      const token = match[1].trim().split('#')[0]
      // 通配/花括号/省略号/空白/相对上跳 —— 这些不是可校验的具体路径
      if (/[*{}<>\s…]|\.\./.test(token)) continue
      if (token.includes('dist/') || token.endsWith('.vsix')) continue

      const adr = ADR_SHORT_PATTERN.exec(token)
      if (adr !== null) {
        const adrDir = path.join(targetRoot, 'docs', 'adr')
        const names = await readdir(adrDir).catch(() => [])
        checked += 1
        if (!names.some((name) => name.startsWith(`${adr[1]}-`))) {
          problems.push(`${path.relative(targetRoot, file)} → ${token}（编号短引用找不到对应 ADR）`)
        }
        continue
      }

      if (!INLINE_REF_PATTERN.test(token)) continue
      await checkRef(file, token, path.resolve(targetRoot, token))
    }
  }

  if (problems.length > 0) {
    console.error(`文档链接检查失败：${problems.length} 条失效链接（共检查 ${files.length} 个文件）`)
    for (const problem of problems) console.error(`  ✗ ${problem}`)
    process.exit(1)
  }
  console.log(`文档链接检查通过：${files.length} 个文件 / ${checked} 条相对链接`)
}

await main()
