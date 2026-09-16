import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  SIGNATURE_FILE,
  canonicalJson,
  sha256Hex,
  signPluginDirectory,
  verifyPluginArtifact,
} from '../src/integrity.ts'

/**
 * 完整性/签名链路（M4a）。
 *
 * 这些测试用**临时生成的密钥对**（不依赖仓库里的私钥），因此可以在任何机器上跑，
 * 也不会把私钥带进 CI。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = path.join(here, 'scratch')

const signer = generateKeyPairSync('ed25519')
const other = generateKeyPairSync('ed25519')
const publicKeyPem = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const privateKeyPem = signer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const otherPublicKeyPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString()

const ARTIFACT_V1 = "module.exports = { activate() {}, __v: 'v1' }\n"

async function makeFixture(
  name: string,
  options: { artifact?: string; manifest?: Record<string, unknown> } = {},
): Promise<string> {
  const dir = path.join(scratch, name)
  await mkdir(path.join(dir, 'dist'), { recursive: true })
  await writeFile(path.join(dir, 'dist', 'index.cjs'), options.artifact ?? ARTIFACT_V1, 'utf8')
  const manifest = {
    id: name,
    name,
    version: '1.0.0',
    main: 'dist/index.cjs',
    trust: 'trusted',
    permissions: [],
    ...options.manifest,
  }
  await writeFile(path.join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return dir
}

/**
 * 注意 `key` 用 `null` 表示"宿主没有公钥"。
 * 不能直接传 `undefined`：显式传 undefined 会触发默认值，参数会悄悄变回 publicKeyPem，
 * 于是"未配置公钥"这条路径根本测不到（这是被这条测试自己抓出来的坑）。
 */
function verify(root: string, requireSignature: boolean, key: string | null = publicKeyPem) {
  return verifyPluginArtifact({
    root,
    publicKeyPem: key === null ? undefined : key,
    requireSignature,
  })
}

test('canonicalJson：与 key 的书写顺序无关（签名的前提）', () => {
  const a = { b: 1, a: 2, nested: { z: [3, { y: 4, x: 5 }], y: 1 } }
  const b = { nested: { y: 1, z: [3, { x: 5, y: 4 }] }, a: 2, b: 1 }
  assert.equal(canonicalJson(a), canonicalJson(b))
  assert.equal(canonicalJson(a), '{"a":2,"b":1,"nested":{"y":1,"z":[3,{"x":5,"y":4}]}}')
})

test('sha256Hex：对已知输入给出已知摘要', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

test('工作区插件（不要求签名）：未签名也能加载', async () => {
  const dir = await makeFixture('dev-unsigned')
  const outcome = verify(dir, false)
  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.equal(outcome.mode, 'unsigned-dev')
})

test('globalStorage 插件（要求签名）：没有 plugin.sig 必须拒绝，并给出可操作信息', async () => {
  const dir = await makeFixture('global-unsigned')
  const outcome = verify(dir, true)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) {
    assert.match(outcome.reason, /必须提供 plugin\.sig/)
    assert.match(outcome.reason, /docs\/signing\.md/)
  }
})

test('签名后校验通过，模式为 signed', async () => {
  const dir = await makeFixture('signed-ok')
  const result = signPluginDirectory(dir, privateKeyPem)

  assert.equal(result.integrity.file, 'dist/index.cjs')
  const outcome = verify(dir, true)
  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.equal(outcome.mode, 'signed')
})

test('只有 integrity 没有签名：不要求签名时是 hash-only，要求签名时被拒', async () => {
  const dir = await makeFixture('hash-only')
  signPluginDirectory(dir, privateKeyPem)
  // 手工删掉签名文件，只留 integrity
  const { rm } = await import('node:fs/promises')
  await rm(path.join(dir, SIGNATURE_FILE))

  const relaxed = verify(dir, false)
  assert.equal(relaxed.ok, true)
  if (relaxed.ok) assert.equal(relaxed.mode, 'hash-only')

  const strict = verify(dir, true)
  assert.equal(strict.ok, false)
})

test('签名后**篡改产物**：被 integrity 的 sha256 抓住', async () => {
  const dir = await makeFixture('tamper-artifact')
  signPluginDirectory(dir, privateKeyPem)

  await writeFile(path.join(dir, 'dist', 'index.cjs'), "module.exports = { activate() {}, __v: 'EVIL' }\n", 'utf8')

  const outcome = verify(dir, true)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.match(outcome.reason, /完整性校验失败/)
})

test('篡改产物**并同步改写 integrity.hash**：被签名抓住（这是 hash 单独不够用的原因）', async () => {
  const dir = await makeFixture('tamper-both')
  signPluginDirectory(dir, privateKeyPem)

  const evil = "module.exports = { activate() {}, __v: 'EVIL' }\n"
  await writeFile(path.join(dir, 'dist', 'index.cjs'), evil, 'utf8')

  // 攻击者知道怎么算 sha256，于是把清单里的 hash 也改成一致的 —— 但签名覆盖清单，改不动
  const manifestPath = path.join(dir, 'plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  manifest.integrity = { algorithm: 'sha256', file: 'dist/index.cjs', hash: sha256Hex(evil) }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const outcome = verify(dir, true)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.match(outcome.reason, /签名验证失败/)
})

test('篡改清单里的其它字段（例如描述）同样会破坏签名', async () => {
  const dir = await makeFixture('tamper-manifest')
  signPluginDirectory(dir, privateKeyPem)

  const manifestPath = path.join(dir, 'plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  manifest.description = '偷偷加的一句话'
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const outcome = verify(dir, true)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.match(outcome.reason, /签名验证失败/)
})

test('用另一把私钥签的名 → 验证失败', async () => {
  const dir = await makeFixture('wrong-key')
  const wrongPrivate = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  signPluginDirectory(dir, wrongPrivate)

  const outcome = verify(dir, true, otherPublicKeyPem)
  assert.equal(outcome.ok, true, '用匹配的公钥应当通过')

  const mismatch = verify(dir, true, publicKeyPem)
  assert.equal(mismatch.ok, false)
  if (!mismatch.ok) assert.match(mismatch.reason, /签名验证失败/)
})

test('插件带签名但宿主没配置公钥 → 拒绝（fail-closed，不静默放行）', async () => {
  const dir = await makeFixture('no-host-key')
  signPluginDirectory(dir, privateKeyPem)

  const outcome = verify(dir, false, null)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.match(outcome.reason, /未配置验证公钥/)
})

test('integrity.file 越出插件目录 → 拒绝', async () => {
  const dir = await makeFixture('escape', {
    manifest: { integrity: { algorithm: 'sha256', file: '../../../../package.json', hash: 'a'.repeat(64) } },
  })
  const outcome = verify(dir, false)
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.match(outcome.reason, /越出插件目录/)
})

test('integrity 结构非法 → 拒绝（而不是当作没有 integrity）', async () => {
  const bad = [
    { algorithm: 'md5', file: 'dist/index.cjs', hash: 'a'.repeat(64) },
    { algorithm: 'sha256', file: '', hash: 'a'.repeat(64) },
    { algorithm: 'sha256', file: 'dist/index.cjs', hash: 'not-a-hash' },
  ]
  for (const [index, integrity] of bad.entries()) {
    const dir = await makeFixture(`bad-integrity-${index}`, { manifest: { integrity } })
    const outcome = verify(dir, false)
    assert.equal(outcome.ok, false, `integrity #${index} 应当被拒绝`)
  }
})

test('签名的规范化负载与校验端一致（同一份清单，两种 key 顺序）', async () => {
  const dir = await makeFixture('canonical-roundtrip')
  const result = signPluginDirectory(dir, privateKeyPem)

  const manifest = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as Record<string, unknown>
  // 重新排列 key 后重写，规范化负载应当不变 → 签名仍然有效
  const reordered: Record<string, unknown> = {}
  for (const key of Object.keys(manifest).reverse()) reordered[key] = manifest[key]
  await writeFile(path.join(dir, 'plugin.json'), `${JSON.stringify(reordered, null, 2)}\n`, 'utf8')

  assert.equal(canonicalJson(reordered), result.payload)
  const outcome = verify(dir, true)
  assert.equal(outcome.ok, true)
})
