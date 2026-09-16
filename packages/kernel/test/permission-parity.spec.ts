import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PERMISSIONS } from '../../sdk/src/permission.ts'
import { KERNEL_PERMISSIONS } from '../src/permissions.ts'

/**
 * 防漂移测试（ADR-0009）。
 *
 * kernel 运行时不允许导入 @vscordis/sdk（否则 Node 的原生类型剥离会因为 node_modules 而失效），
 * 因此权限词表在两处各有一份。这个测试用**相对路径**导入 sdk 的真实列表做全等断言，
 * 任何一侧新增/删除权限都会立刻失败。
 */
test('kernel 与 sdk 的权限词表完全一致（顺序无关）', () => {
  assert.deepEqual([...KERNEL_PERMISSIONS].sort(), [...PERMISSIONS].sort())
})

test('权限词表不含重复项', () => {
  assert.equal(new Set(KERNEL_PERMISSIONS).size, KERNEL_PERMISSIONS.length)
  assert.equal(new Set(PERMISSIONS).size, PERMISSIONS.length)
})
