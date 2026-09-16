/**
 * 冒烟测试：验证**构建产物**（dist/）而不是源码符合运行时契约。
 *
 * 它是"最小 PoC 真的能跑"的第一层证据（第二层是 F5 手动验收，见 docs/acceptance-m1-m2.md）。
 * 五条断言：
 *   1. plugin.json 通过 validateManifest；
 *   2. dist/index.cjs 存在（忘记构建时给出可操作提示）；
 *   3. **产物里不出现 `require("vscode")`** —— 这是 ADR-0003 里那道唯一可靠防线的机器化检查
 *      （扩展宿主会把 vscode 注入给扩展目录下的任何模块）；
 *   4. 产物能被 `resolvePluginExport` 规范化（验证 esbuild 的 CJS wrapper 与我们的导出协议兼容）；
 *   5. 顺带证明 kernel/sdk 的类型导入纪律：它们能被 Node 直接以 ESM 加载，
 *      说明 `import type` 全部被擦除、运行时零跨包依赖。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXPECTED_PLUGINS } from './expected-plugins.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeRequire = createRequire(import.meta.url)

const { resolvePluginExport } = await import('../packages/sdk/src/index.ts')
const { validateManifest } = await import('../packages/kernel/src/index.ts')

const FORBIDDEN = /require\(\s*["']vscode["']\s*\)/

const pluginsDir = path.join(root, 'plugins')
/** 冒烟是门槛：空目录/少一个插件产物都必须失败，不能打印“0 个插件”后退出 0。 */
const names = readdirSync(pluginsDir).sort()
const failures = []
const checkedNames = []
let checked = 0

console.log('构建产物冒烟测试')

for (const name of names) {
  const dir = path.join(pluginsDir, name)
  const manifestPath = path.join(dir, 'plugin.json')
  if (!existsSync(manifestPath)) continue

  const validated = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  if (!validated.ok) {
    failures.push(`${name}: plugin.json 校验失败 → ${validated.errors.join('; ')}`)
    continue
  }

  const builtPath = path.join(dir, 'dist', 'index.cjs')
  if (!existsSync(builtPath)) {
    failures.push(`${name}: 缺少构建产物 ${builtPath}（先运行 npm run build）`)
    continue
  }

  const source = readFileSync(builtPath, 'utf8')
  if (FORBIDDEN.test(source)) {
    failures.push(`${name}: 产物中出现 require("vscode")，绕过了受控 API（ADR-0003）`)
    continue
  }

  let plugin
  try {
    plugin = resolvePluginExport(nodeRequire(builtPath))
  } catch (error) {
    failures.push(`${name}: 无法解析插件导出 → ${error instanceof Error ? error.message : String(error)}`)
    continue
  }

  assert.equal(typeof plugin.activate, 'function', `${name}: activate 必须是函数`)
  checked += 1
  checkedNames.push(name)
  console.log(
    `  ✓ ${name} [${plugin.name ?? '<未命名>'}] trust=${validated.manifest.trust} ` +
      `deps=${JSON.stringify(validated.manifest.dependencies)} permissions=${validated.manifest.permissions.length}`,
  )
}

for (const expected of EXPECTED_PLUGINS) {
  if (!checkedNames.includes(expected)) failures.push(`缺少预期插件产物：${expected}`)
}
for (const unexpected of checkedNames) {
  if (!EXPECTED_PLUGINS.includes(unexpected)) {
    failures.push(`冒烟发现未登记插件 ${unexpected}：请同步 EXPECTED_PLUGINS 后重跑`)
  }
}

if (failures.length > 0) {
  console.error('\n冒烟失败：')
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}

console.log(`\n冒烟通过：${checked} 个插件产物符合契约`)
