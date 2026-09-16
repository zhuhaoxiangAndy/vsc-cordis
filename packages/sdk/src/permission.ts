/**
 * 权限白名单（ADR-0005）。
 *
 * 设计要点：
 * 1. 白名单而非黑名单：清单里没写 = 没授予。
 * 2. 权限是**声明式**的，写在 plugin.json 里，加载时解析、调用时校验。
 * 3. `net` / `fs:*` / `process:spawn` 是"非 VSCode 能力"，在 M4 的隔离后端里才具备强制力；
 *    同进程（trust: trusted）下它们只是代码约定，不具备对抗性。
 */

export const PERMISSIONS = [
  'vscode:commands.register',
  'vscode:commands.execute',
  'vscode:commands.execute.any',
  'vscode:window.messages',
  'vscode:window.statusbar',
  'vscode:window.output',
  'vscode:workspace.read',
  'vscode:workspace.config.read',
  'vscode:workspace.config.write',
  'net',
  'fs:read',
  'fs:write',
  'process:spawn',
] as const

export type Permission = (typeof PERMISSIONS)[number]

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS)

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value)
}

export interface ParsedPermissions {
  readonly granted: readonly Permission[]
  readonly unknown: readonly string[]
}

/**
 * 解析 permissions 字段。
 * 未知权限**不抛错但会被记入 `unknown`**，由调用方决定策略：
 * 加载时未知权限会导致插件被拒绝（fail-closed），因为清单可能来自更新版本的宿主。
 */
export function parsePermissions(value: unknown): ParsedPermissions {
  const granted: Permission[] = []
  const unknown: string[] = []
  if (value === undefined || value === null) return { granted, unknown }
  if (!Array.isArray(value)) {
    unknown.push(String(value))
    return { granted, unknown }
  }
  for (const item of value) {
    if (typeof item === 'string' && isPermission(item)) {
      if (!granted.includes(item)) granted.push(item)
    } else {
      unknown.push(String(item))
    }
  }
  return { granted, unknown }
}
