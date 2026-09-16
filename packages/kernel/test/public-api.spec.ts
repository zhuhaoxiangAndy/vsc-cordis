import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as cloneable from '../src/cloneable.ts'
import * as context from '../src/context.ts'
import * as effectStack from '../src/effect-stack.ts'
import * as errors from '../src/errors.ts'
import * as publicApi from '../src/index.ts'
import * as manifest from '../src/manifest.ts'
import * as permissions from '../src/permissions.ts'
import * as pluginHost from '../src/plugin-host.ts'
import * as semverMini from '../src/semver-mini.ts'
import * as serviceRegistry from '../src/service-registry.ts'
import * as timing from '../src/timing.ts'

/**
 * 公共出口奇偶：模块里 `export` 的**运行时**符号（类/函数/常量）必须能从 `@vscordis/kernel` 取到。
 *
 * 为什么需要它：这类缺口不会让任何既有测试变红 —— 使用方只会 import 失败，或者被迫相对导入
 * 内部文件（`RemoteServiceError` 就这样漏过一次，直到复核时才被发现）。
 * `import * as` 看不到 type-only 导出（类型在运行时被擦除），所以这个测试天然只约束"值"。
 */

/**
 * 有意**不**公开的运行时导出。加进来必须写明理由 —— 这张白名单本身也被下面的用例守着
 * （条目必须真实存在，且一旦被公开就要从表里删掉）。
 */
const INTERNAL_EXPORTS = new Set([
  // 只在 createPluginContext 内部使用；插件作者拿到的是 ctx.async 的代理，不需要它
  'context.ts#wrapAsyncService',
])

const MODULES: Readonly<Record<string, Record<string, unknown>>> = {
  'cloneable.ts': cloneable,
  'context.ts': context,
  'effect-stack.ts': effectStack,
  'errors.ts': errors,
  'manifest.ts': manifest,
  'permissions.ts': permissions,
  'plugin-host.ts': pluginHost,
  'semver-mini.ts': semverMini,
  'service-registry.ts': serviceRegistry,
  'timing.ts': timing,
}

test('公共出口奇偶：每个模块的运行时导出都必须能从 index.ts 取到（或显式登记为 internal）', () => {
  const missing: string[] = []
  let checked = 0

  for (const [file, module] of Object.entries(MODULES)) {
    for (const name of Object.keys(module)) {
      if (name === 'default') continue
      checked += 1
      if (name in publicApi) continue
      if (INTERNAL_EXPORTS.has(`${file}#${name}`)) continue
      missing.push(`${file}#${name}`)
    }
  }

  assert.deepEqual(missing, [], `这些运行时导出没有公共出口：${missing.join(', ')}`)
  // 哨兵：检查面太小时，上面的断言会退化成永远为真（本仓库吃过一次这种亏，见 ADR-0019）
  assert.ok(checked >= 25, `只检查了 ${checked} 个运行时导出，断言可能空转`)
})

test('internal 白名单不腐烂：条目必须真实存在，且一旦公开就要从表里移除', () => {
  for (const entry of INTERNAL_EXPORTS) {
    const [file, name] = entry.split('#')
    const module = MODULES[file ?? '']
    assert.ok(module !== undefined, `白名单里的 ${entry} 指向未知模块`)
    assert.ok(name !== undefined && name in module, `白名单里的 ${entry} 已不存在（请删除）`)
    assert.ok(
      !(name in publicApi),
      `白名单里的 ${entry} 已经可以从公共出口取到（请从白名单移除）`,
    )
  }
})
