import type { PluginManifest, PluginTrust } from '@vscordis/sdk'
import { isKnownPermission } from './permissions.ts'
import { isValidRange } from './semver-mini.ts'

/**
 * `plugin.json` 的**校验策略**（类型在 @vscordis/sdk，策略在 kernel，见 ADR-0001 分层）。
 *
 * 原则是 fail-closed：
 * - 未知权限 → 拒绝加载（清单可能来自更新版本的宿主，静默忽略等于悄悄降权或提权）；
 * - 超出支持子集的版本范围 → 拒绝（不静默当作 `*`，否则依赖协调会失去意义）；
 * - `main` 必须是**目录内相对路径**（内核做纯字符串检查，宿主还会用 realpath 再查一次防 symlink 逃逸）。
 */

export interface NormalizedManifest {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly main: string
  readonly description: string | undefined
  readonly dependencies: Readonly<Record<string, string>>
  /** 声明的服务（供静态工具使用；运行期以 ctx.provide 为准，宿主会比对并告警，见 ADR-0014）。 */
  readonly provides: readonly string[]
  /**
   * 声明的配置键（供隔离模式的同步读取使用，见 ADR-0016）。
   * 缺省 `undefined` 表示"没有声明" —— 与 `provides` 归一化成数组不同，
   * 这里的"没有"天然就是 undefined，硬造一个空对象反而会掩盖意图。
   */
  readonly configuration?: { readonly section: string; readonly keys: readonly string[] }
  readonly permissions: readonly string[]
  readonly trust: PluginTrust
}

export type ManifestValidation =
  | { readonly ok: true; readonly manifest: NormalizedManifest }
  | { readonly ok: false; readonly errors: readonly string[] }

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/
const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/
/** 配置 section 与插件 id 同形（VSCode 的配置段名就是这个形状）。 */
const SECTION_PATTERN = ID_PATTERN
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const ENTRY_PATTERN = /\.(cjs|mjs|js)$/

/**
 * 纯字符串层面的"目录内相对路径"检查（不依赖 node:path，以便 kernel 在 Web 端也能跑）。
 * 拒绝：绝对路径（POSIX / Windows 盘符 / UNC）、任何 `..` 段、空段。
 */
export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(value)) return false
  // 注意用 [\\/] 而不是 [\\/]+：折叠连续分隔符会漏掉 "a//b.js" 里的空路径段。
  const segments = value.split(/[\\/]/)
  if (segments.includes('..')) return false
  if (segments.some((segment) => segment.length === 0)) return false
  return true
}

export function validateManifest(raw: unknown): ManifestValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['plugin.json 必须是一个 JSON 对象'] }
  }
  const record = raw as Record<string, unknown>
  const errors: string[] = []

  const id = readString(record, 'id', errors)
  if (id !== undefined && !ID_PATTERN.test(id)) {
    errors.push(`id 非法："${id}"（要求小写字母/数字/连字符，可带点分隔的段，例如 com.example.hello）`)
  }

  const name = readString(record, 'name', errors)

  const version = readString(record, 'version', errors)
  if (version !== undefined && !VERSION_PATTERN.test(version)) {
    errors.push(`version 非法："${version}"（要求 x.y.z）`)
  }

  const main = readString(record, 'main', errors)
  if (main !== undefined) {
    if (!isSafeRelativePath(main)) errors.push(`main 非法："${main}"（必须是插件目录内的相对路径，禁止 ..）`)
    if (!ENTRY_PATTERN.test(main)) {
      errors.push(`main 非法："${main}"（必须是打包后的单文件，扩展名为 .cjs/.mjs/.js，见 ADR-0009）`)
    }
  }

  const description = readOptionalString(record, 'description', errors)

  const dependencies = readDependencies(record, errors)

  const provides = readProvides(record, errors)

  const configuration = readConfiguration(record, errors)

  const permissions = readPermissions(record, errors)

  const trust = readTrust(record, errors)

  if (errors.length > 0 || id === undefined || name === undefined || version === undefined || main === undefined) {
    return { ok: false, errors }
  }

  const manifest: NormalizedManifest = {
    id,
    name,
    version,
    main,
    description,
    dependencies,
    provides,
    configuration,
    permissions,
    trust,
  }
  return { ok: true, manifest }
}

export function asPluginManifest(manifest: NormalizedManifest): PluginManifest {
  return manifest
}

function readString(record: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const value = record[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`缺少必填字段 ${key}（应为非空字符串）`)
    return undefined
  }
  return value
}

function readOptionalString(record: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    errors.push(`${key} 应为字符串`)
    return undefined
  }
  return value
}

function readDependencies(record: Record<string, unknown>, errors: string[]): Record<string, string> {
  const value = record.dependencies
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('dependencies 应为 { 服务名: 版本范围 } 对象')
    return {}
  }
  const result: Record<string, string> = {}
  for (const [name, range] of Object.entries(value as Record<string, unknown>)) {
    if (!SERVICE_NAME_PATTERN.test(name)) {
      errors.push(`dependencies 的服务名非法："${name}"`)
      continue
    }
    if (typeof range !== 'string' || !isValidRange(range)) {
      errors.push(
        `dependencies["${name}"] 的版本范围非法："${String(range)}"（仅支持 * / 1.2.3 / ^1.2.3 / >=1.2.3）`,
      )
      continue
    }
    result[name] = range
  }
  return result
}

function readProvides(record: Record<string, unknown>, errors: string[]): string[] {
  const value = record.provides
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push('provides 应为服务名字符串数组')
    return []
  }
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !SERVICE_NAME_PATTERN.test(item)) {
      errors.push(`provides 含非法服务名：${String(item)}`)
      continue
    }
    if (!result.includes(item)) result.push(item)
  }
  return result
}

function readConfiguration(
  record: Record<string, unknown>,
  errors: string[],
): { readonly section: string; readonly keys: readonly string[] } | undefined {
  const value = record.configuration
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('configuration 应为 { section, keys } 对象')
    return undefined
  }
  const entry = value as Record<string, unknown>
  const section = entry.section
  if (typeof section !== 'string' || !SECTION_PATTERN.test(section)) {
    errors.push(`configuration.section 非法：${String(section)}（要求小写字母/数字/连字符，可带点分段）`)
    return undefined
  }
  const rawKeys = entry.keys
  if (!Array.isArray(rawKeys)) {
    errors.push('configuration.keys 应为字符串数组')
    return undefined
  }
  const keys: string[] = []
  for (const key of rawKeys) {
    if (typeof key !== 'string' || key.trim().length === 0) {
      errors.push(`configuration.keys 含非法键：${String(key)}`)
      continue
    }
    if (!keys.includes(key)) keys.push(key)
  }
  if (keys.length === 0) {
    errors.push('configuration.keys 不能为空数组（要么不写 configuration，要么至少声明一个键）')
    return undefined
  }
  return { section, keys }
}

function readPermissions(record: Record<string, unknown>, errors: string[]): string[] {
  const value = record.permissions
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push('permissions 应为字符串数组')
    return []
  }
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      errors.push(`permissions 含非字符串项：${String(item)}`)
      continue
    }
    if (!isKnownPermission(item)) {
      errors.push(`未知权限 "${item}"（fail-closed：拒绝加载而不是静默忽略）`)
      continue
    }
    if (!result.includes(item)) result.push(item)
  }
  return result
}

function readTrust(record: Record<string, unknown>, errors: string[]): PluginTrust {
  const value = record.trust
  if (value === undefined) return 'untrusted'
  if (value === 'trusted' || value === 'untrusted') return value
  errors.push(`trust 非法："${String(value)}"（应为 trusted / untrusted）`)
  return 'untrusted'
}
