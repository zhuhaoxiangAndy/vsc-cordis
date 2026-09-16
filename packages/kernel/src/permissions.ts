/**
 * kernel 侧的权限词表。
 *
 * 为什么这里会有一份"副本"（见 ADR-0009 与 ADR-0001）：
 * kernel 运行时**零跨包导入**（只允许 `import type`），因此不能 `import { PERMISSIONS } from '@vscordis/sdk'`。
 * 防漂移靠两道保险：
 *   1. 编译期：下面的数组用 `satisfies readonly Permission[]` 约束，sdk 新增权限时此处不会静默出错，
 *      但 kernel 若是**少了**某个权限，parity 测试会失败；
 *   2. 运行期：`packages/kernel/test/permission-parity.spec.ts` 用相对路径导入 sdk 的真实列表做全等断言。
 */
import type { Permission } from '@vscordis/sdk'

export const KERNEL_PERMISSIONS = [
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
] as const satisfies readonly Permission[]

const VALID: ReadonlySet<string> = new Set<string>(KERNEL_PERMISSIONS)

export function isKnownPermission(value: string): value is Permission {
  return VALID.has(value)
}
