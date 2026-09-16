import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { isInside } from './paths.ts'

/**
 * 完整性与签名校验（ADR-0008 决策 + ADR-0012）。
 *
 * 为什么需要它，以及它**不能**解决什么：
 *
 * - 能解决：插件产物在安装后被替换/篡改、清单与产物不匹配、来源不符（未签名却声称已安装）。
 * - 不能解决：**同进程**加载的插件在运行时绕过受控 API（ADR-0003 已用一手证据说明可行）。
 *   签名保证"这段代码是作者发布的那段"，不保证"这段代码是善意的"。
 *   真正的边界只能靠子进程隔离（M4b），这一点不能含糊。
 *
 * 签名放在**独立文件** plugin.sig 而不是 plugin.json 里，避免自引用
 * （把签名放进被签内容里会出现"签什么"的循环）。
 */

export const SIGNATURE_FILE = 'plugin.sig'

/** 完整性/签名校验失败。抛出它意味着**拒绝加载**（fail-closed）。 */
export class PluginIntegrityError extends Error {
  readonly pluginId: string

  constructor(pluginId: string, reason: string) {
    super(`插件 "${pluginId}" 未通过完整性校验：${reason}`)
    this.name = 'PluginIntegrityError'
    this.pluginId = pluginId
  }
}

export interface IntegrityDescriptor {
  readonly algorithm: 'sha256'
  readonly file: string
  readonly hash: string
}

export type VerificationMode = 'unsigned-dev' | 'hash-only' | 'signed'

export type VerificationOutcome =
  | { readonly ok: true; readonly mode: VerificationMode }
  | { readonly ok: false; readonly reason: string }

export interface VerifyOptions {
  readonly root: string
  /** 宿主内置的 Ed25519 公钥（PEM）。未配置时，任何签名都会被判为无法验证。 */
  readonly publicKeyPem: string | undefined
  /** 是否强制要求签名。装入 globalStorage 的插件为 true（用户决策）。 */
  readonly requireSignature: boolean
}

/** 确定性序列化：递归按 key 排序，于是"同一份清单"永远得到同一串字节。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortValue(record[key])
    return sorted
  }
  return value
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 给脚本（发布者）用：对清单负载签名，返回 base64。 */
export function signPayload(payload: string, privateKeyPem: string): string {
  return cryptoSign(null, Buffer.from(payload, 'utf8'), privateKeyPem).toString('base64')
}

export function verifyPayload(payload: string, signatureBase64: string, publicKeyPem: string): boolean {
  return cryptoVerify(
    null,
    Buffer.from(payload, 'utf8'),
    createPublicKey(publicKeyPem),
    Buffer.from(signatureBase64, 'base64'),
  )
}

/**
 * 校验一个插件目录。**只读**，不抛错 —— 全部失败路径都折成 `{ ok: false, reason }`，
 * 因为调用方（加载器）需要把原因变成给用户看的可操作信息。
 */
export function verifyPluginArtifact(options: VerifyOptions): VerificationOutcome {
  const root = path.resolve(options.root)

  const raw = readRawManifest(root)
  if ('error' in raw) return { ok: false, reason: raw.error }

  const integrity = readIntegrity(raw.value)
  if (integrity !== undefined && 'error' in integrity) return { ok: false, reason: integrity.error }

  if (integrity !== undefined) {
    const outcome = checkIntegrity(root, integrity)
    if (outcome !== undefined) return { ok: false, reason: outcome }
  }

  const signature = readSignature(root)

  if (signature === undefined) {
    if (options.requireSignature) {
      return {
        ok: false,
        reason:
          `该插件位于 globalStorage，必须提供 ${SIGNATURE_FILE} 签名文件。` +
          `请发布者用 scripts/sign-plugin.mjs 签名后再安装（见 docs/signing.md）。`,
      }
    }
    return { ok: true, mode: integrity === undefined ? 'unsigned-dev' : 'hash-only' }
  }

  if (options.publicKeyPem === undefined || options.publicKeyPem.trim().length === 0) {
    return {
      ok: false,
      reason:
        '插件带签名，但宿主未配置验证公钥。' +
        '请确认 packages/host/keys/vscordis-ed25519.pub.pem 存在（见 docs/signing.md）。',
    }
  }

  const payload = canonicalJson(raw.value)
  let valid: boolean
  try {
    valid = verifyPayload(payload, signature, options.publicKeyPem)
  } catch (error) {
    return { ok: false, reason: `签名验证过程出错：${errorText(error)}` }
  }
  if (!valid) {
    return {
      ok: false,
      reason: '签名验证失败：清单内容与签名不匹配（被篡改，或用了另一把私钥签名）',
    }
  }

  return { ok: true, mode: 'signed' }
}

/** 读取并解析 plugin.json。 */
export function readRawManifest(root: string): { value: Record<string, unknown> } | { error: string } {
  let text: string
  try {
    text = readFileSync(path.join(root, 'plugin.json'), 'utf8')
  } catch {
    return { error: `无法读取 plugin.json（${root}）` }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'plugin.json 必须是一个 JSON 对象' }
    }
    return { value: parsed as Record<string, unknown> }
  } catch (error) {
    return { error: `plugin.json 不是合法 JSON：${errorText(error)}` }
  }
}

/** 计算清单负载：签名与验签双方都调用它，保证一致。 */
export function manifestPayload(raw: Record<string, unknown>): string {
  return canonicalJson(raw)
}

export interface SignResult {
  readonly payload: string
  readonly signature: string
  readonly integrity: IntegrityDescriptor
}

/**
 * 给插件目录签名：把产物 sha256 写进 plugin.json 的 `integrity`，再把签名写进 `plugin.sig`。
 *
 * 会**重写** plugin.json（保留其它字段，2 空格缩进 + 结尾换行）。
 * 签名脚本与测试共用这一条代码路径，避免"脚本和校验器各写一套"的经典漂移。
 */
export function signPluginDirectory(
  root: string,
  privateKeyPem: string,
  options: { readonly file?: string } = {},
): SignResult {
  const absoluteRoot = path.resolve(root)
  const raw = readRawManifest(absoluteRoot)
  if ('error' in raw) throw new Error(raw.error)

  const declared = options.file ?? (typeof raw.value.main === 'string' ? raw.value.main : '')
  const file = declared.trim()
  if (file.length === 0) throw new Error('无法确定要签名的产物文件：plugin.json 缺少 main')

  const target = path.resolve(absoluteRoot, file)
  if (!isInside(absoluteRoot, target)) {
    throw new Error(`要签名的文件越出插件目录：${file}`)
  }

  const integrity: IntegrityDescriptor = {
    algorithm: 'sha256',
    file,
    hash: sha256Hex(readFileSync(target)),
  }

  const next: Record<string, unknown> = { ...raw.value, integrity }
  writeFileSync(path.join(absoluteRoot, 'plugin.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8')

  const payload = canonicalJson(next)
  const signature = signPayload(payload, privateKeyPem)
  writeFileSync(path.join(absoluteRoot, SIGNATURE_FILE), `${signature}\n`, 'utf8')

  return { payload, signature, integrity }
}

function readIntegrity(
  raw: Record<string, unknown>,
): IntegrityDescriptor | undefined | { error: string } {
  const value = raw.integrity
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'integrity 必须是 { algorithm, file, hash } 对象' }
  }
  const record = value as Record<string, unknown>
  const algorithm = record.algorithm
  const file = record.file
  const hash = record.hash

  if (algorithm !== 'sha256') return { error: `integrity.algorithm 只支持 "sha256"，实际为 ${String(algorithm)}` }
  if (typeof file !== 'string' || file.length === 0) return { error: 'integrity.file 必须是非空字符串' }
  if (typeof hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hash)) {
    return { error: 'integrity.hash 必须是 64 位十六进制 sha256' }
  }
  return { algorithm: 'sha256', file, hash }
}

function checkIntegrity(root: string, integrity: IntegrityDescriptor): string | undefined {
  const target = path.resolve(root, integrity.file)
  if (!isInside(root, target)) {
    return `integrity.file 越出插件目录：${integrity.file}`
  }
  let actual: string
  try {
    actual = sha256Hex(readFileSync(target))
  } catch {
    return `完整性校验失败：读不到被校验文件 ${integrity.file}`
  }
  if (actual.toLowerCase() !== integrity.hash.toLowerCase()) {
    return `完整性校验失败：${integrity.file} 的实际 sha256 为 ${actual}，清单声明为 ${integrity.hash}`
  }
  return undefined
}

function readSignature(root: string): string | undefined {
  try {
    const value = readFileSync(path.join(root, SIGNATURE_FILE), 'utf8').trim()
    return value.length === 0 ? undefined : value
  } catch {
    return undefined
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
