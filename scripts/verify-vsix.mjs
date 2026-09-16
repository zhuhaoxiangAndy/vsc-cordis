/**
 * 校验打出来的 VSIX（**针对真实产物**，不是针对我的 `.vscodeignore` 理解）。
 *
 * 做法：直接读 ZIP 的中央目录列出条目 —— 不解压、不依赖任何库。
 * 这一点很关键：如果我自己实现一遍 ignore 语义再去断言，那只证明"我的实现和我的理解一致"；
 * 读真实产物才能证明"vsce 打出来的东西是对的"。
 *
 * 用法：node scripts/verify-vsix.mjs [vsix 路径]
 */

import { readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2] ?? path.join(root, 'vscordis-local.vsix')

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50

function listZipEntries(buffer) {
  // 从尾部往回找 EOCD（注释最长 65535 字节）
  let eocd = -1
  const lowest = Math.max(0, buffer.length - 22 - 65_535)
  for (let i = buffer.length - 22; i >= lowest; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP：找不到 EOCD 记录')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)

  const entries = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`中央目录第 ${index} 项签名损坏，偏移 ${cursor}`)
    }
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const compressionMethod = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    entries.push({ name, size: uncompressedSize, compressionMethod, compressedSize, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** 从 ZIP 中真正解出一条 entry（stored 直接切片，deflate 用 zlib）。 */
function extractEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new Error(`本地文件头签名损坏：${entry.name}`)
  }
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26)
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
  const start = entry.localOffset + 30 + nameLength + extraLength
  const data = buffer.subarray(start, start + entry.compressedSize)
  if (entry.compressionMethod === 0) return data
  if (entry.compressionMethod === 8) return inflateRawSync(data)
  throw new Error(`不支持的压缩方式 ${entry.compressionMethod}：${entry.name}`)
}

const REQUIRED = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/package.json',
  'extension/dist/extension.cjs',
  'extension/dist/isolated-worker.cjs',
  'extension/dist/web/extension.js',
  'extension/keys/vscordis-ed25519.pub.pem',
]

/** 这些一旦进包就是事故：源码、测试、依赖、配置 */
const FORBIDDEN_PATTERNS = [/^extension\/src\//, /^extension\/test\//, /node_modules\//, /\.ts$/, /\.map$/]

if (!statSync(target, { throwIfNoEntry: false })) {
  console.error(`[失败] 找不到 VSIX：${target}`)
  console.error('先运行：pnpm run package')
  process.exit(1)
}

const buffer = readFileSync(target)
const entries = listZipEntries(buffer)

const problems = []
for (const required of REQUIRED) {
  const entry = entries.find((candidate) => candidate.name === required)
  if (entry === undefined) problems.push(`缺少必需项：${required}`)
  else if (entry.size <= 0) problems.push(`必需项是 0 字节：${required}`)
}

// 包内 package.json 的入口必须真实存在且非空。只看仓库源码清单不够：
// 真正的验收对象是 vsce 打出来的产物。
try {
  const packageEntry = entries.find((entry) => entry.name === 'extension/package.json')
  if (packageEntry !== undefined) {
    const packaged = JSON.parse(extractEntry(buffer, packageEntry).toString('utf8'))
    const declaredEntries = [packaged.main, packaged.browser]
    for (const declared of declaredEntries) {
      if (typeof declared !== 'string' || declared.length === 0) continue
      const expected = `extension/${declared.replace(/^\.\//, '')}`
      const entry = entries.find((candidate) => candidate.name === expected)
      if (entry === undefined) problems.push(`package.json 入口不存在：${declared}（期望 ${expected}）`)
      else if (entry.size <= 0) problems.push(`package.json 入口是 0 字节：${expected}`)
    }
  }
} catch (error) {
  problems.push(`无法解析 extension/package.json：${error instanceof Error ? error.message : String(error)}`)
}

// 开发构建会把 sourcemap 内联进 JS；只禁 `.map` 文件名会漏掉它。
// `package` 不强制先 build:prod，所以门禁必须自己扫内容。
for (const entry of entries) {
  if (!/\.(?:c|m)?js$/.test(entry.name)) continue
  try {
    const text = extractEntry(buffer, entry).toString('utf8')
    if (/sourceMappingURL=data:/.test(text)) {
      problems.push(`内联 sourcemap 进包：${entry.name}（先运行 pnpm run build:prod 再打包）`)
    }
  } catch (error) {
    problems.push(`无法读取 ${entry.name} 以检查 sourcemap：${error instanceof Error ? error.message : String(error)}`)
  }
}

for (const entry of entries) {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(entry.name)) problems.push(`不该进包：${entry.name}（匹配 ${pattern}）`)
  }
}

const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
console.log(`VSIX 校验：${path.relative(root, target)}（${entries.length} 项，解压后 ${(totalBytes / 1024).toFixed(1)} KB）`)
for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`  ${entry.name}  [${entry.size} B]`)
}

if (problems.length > 0) {
  console.error('')
  console.error(`VSIX 校验失败（${problems.length} 条）：`)
  for (const problem of problems) console.error(`  ✗ ${problem}`)
  process.exit(1)
}

console.log('')
console.log('VSIX 校验通过：必需项齐全，且没有源码 / 测试 / node_modules / sourcemap 进包')
