// 给一个插件目录签名：把产物 sha256 写进 plugin.json 的 integrity，并生成 plugin.sig。
//
// 用法：
//   node scripts/sign-plugin.mjs plugins/hello
//   node scripts/sign-plugin.mjs plugins/hello --key D:\keys\my.pem
//   node scripts/sign-plugin.mjs plugins/hello --verify     # 签完立刻用仓库公钥回验
//
// 注意：**会重写 plugin.json**（保留字段、统一为 2 空格缩进 + 结尾换行）。
// 签名覆盖"整个清单的规范化 JSON"，所以任何字段改动都需要重新签名。

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const target = process.argv[2]
if (target === undefined || target.startsWith('--')) {
  console.error('用法：node scripts/sign-plugin.mjs <插件目录> [--key <私钥路径>]')
  process.exit(1)
}

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

const keyPath = path.resolve(argOf('key', path.join(homedir(), '.dsh', 'keys', 'vscordis-ed25519.pem')))
if (!existsSync(keyPath)) {
  console.error(`[失败] 找不到私钥：${keyPath}`)
  console.error('先运行：node scripts/gen-key.mjs（见 docs/signing.md）')
  process.exit(1)
}

// 复用宿主里的同一份实现，避免"脚本与校验器各写一套"的漂移。
const { signPluginDirectory, verifyPluginArtifact } = await import('../packages/host/src/integrity.ts')

const pluginDir = path.resolve(root, target)
const result = signPluginDirectory(pluginDir, readFileSync(keyPath, 'utf8'))

console.log(`已签名：${path.relative(root, pluginDir)}`)
console.log(`  产物  ：${result.integrity.file}`)
console.log(`  sha256：${result.integrity.hash}`)
console.log(`  签名  ：${result.signature.slice(0, 32)}…（写入 plugin.sig）`)

// --verify：签完立刻用**仓库里那把公钥**回验。
// 这一步能抓住最容易出错的情况：私钥换了但公钥没更新（此时签名看着成功，实际谁也验不过）。
if (process.argv.includes('--verify')) {
  const publicPath = path.resolve(argOf('public', path.join(root, 'packages', 'host', 'keys', 'vscordis-ed25519.pub.pem')))
  if (!existsSync(publicPath)) {
    console.error(`[失败] 找不到公钥：${publicPath}（宿主将无法验签）`)
    process.exit(1)
  }
  const outcome = verifyPluginArtifact({
    root: pluginDir,
    publicKeyPem: readFileSync(publicPath, 'utf8'),
    requireSignature: true,
  })
  if (!outcome.ok) {
    console.error(`[失败] 回验不通过：${outcome.reason}`)
    console.error('提示：若刚换过密钥，请把新公钥提交到 packages/host/keys/')
    process.exit(1)
  }
  console.log(`  回验  ：通过（模式 ${outcome.mode}，公钥 ${path.relative(root, publicPath)}）`)
}

console.log('')
console.log('提示：开发期（工作区目录）插件不要求签名；装入 globalStorage 的插件必须签名（ADR-0008）。')
