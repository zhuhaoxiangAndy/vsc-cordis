// 生成 vscordis 的 Ed25519 签名密钥对。
//
// 私钥默认写到 %USERPROFILE%\.dsh\keys\vscordis-ed25519.pem（**工作区之外**），
// 公钥默认写到 packages/host/keys/vscordis-ed25519.pub.pem（应入库，供宿主验签）。
// 设计依据见 docs/adr/0008-secret-management.md，操作步骤见 docs/signing.md。
//
// 用法：
//   node scripts/gen-key.mjs
//   node scripts/gen-key.mjs --force
//   node scripts/gen-key.mjs --out D:\keys\my.pem --public packages/host/keys/my.pub.pem

import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

const force = process.argv.includes('--force')
const privatePath = path.resolve(
  argOf('out', path.join(homedir(), '.dsh', 'keys', 'vscordis-ed25519.pem')),
)
const publicPath = path.resolve(
  argOf('public', path.join(root, 'packages', 'host', 'keys', 'vscordis-ed25519.pub.pem')),
)

if (!force && (existsSync(privatePath) || existsSync(publicPath))) {
  console.error('[拒绝] 密钥文件已存在。加 --force 才会覆盖。')
  console.error(`  私钥：${privatePath}`)
  console.error(`  公钥：${publicPath}`)
  console.error('覆盖会让**所有已发布的旧签名全部失效**，请确认后再执行。')
  process.exit(1)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

mkdirSync(path.dirname(privatePath), { recursive: true })
writeFileSync(privatePath, privatePem, { encoding: 'utf8', mode: 0o600 })

mkdirSync(path.dirname(publicPath), { recursive: true })
writeFileSync(publicPath, publicPem, 'utf8')

console.log('已生成 Ed25519 密钥对')
console.log(`  私钥（绝不入库）：${privatePath}`)
console.log(`  公钥（应当入库）：${publicPath}`)
console.log('')
console.log('下一步：')
console.log('  1. 确认私钥不在仓库里：     git status --short   # 私钥在仓库之外，git 无法跟踪它')
console.log('  2. 给插件签名：             node scripts/sign-plugin.mjs <插件目录> --verify')
console.log('  3. 把公钥提交进仓库，宿主才能验签（见 docs/signing.md）')
