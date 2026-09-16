import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * 这是**接线测试**，不是行为测试 —— 这一点必须说清楚。
 *
 * `runtime.ts` 顶部 `import * as vscode from 'vscode'`，在 node:test 里无法实例化
 * （与 `bridge.ts` 同因，见 `.github/workflows/ci.yml` 里的说明：桥接层只由 tsc 与手动验收覆盖）。
 * 但 ADR-0017 的 engines 强制有一条很容易断、断了又完全静默的接线：
 * `extension.ts` 把 `hostVersion` 交给 `Runtime` 之后，`Runtime` 必须继续交给 `PluginHost`。
 *
 * 这条链真的断过一次（生产路径因此跳过 engines 检查），所以这里用源码断言守住它。
 * 它只能证明"参数被传了"，证明不了"传得对" —— 行为语义由 `kernel/test/engines.spec.ts` 覆盖。
 */
const here = path.dirname(fileURLToPath(import.meta.url))

test('Runtime 必须把 hostVersion / vscodeVersion 传给 PluginHost（否则 engines 强制形同虚设）', async () => {
  const source = await readFile(path.join(here, '..', 'src', 'runtime.ts'), 'utf8')
  const match = /new PluginHost\(\{([\s\S]*?)\n {4}\}\)/.exec(source)
  assert.ok(match, 'runtime.ts 里应能找到 new PluginHost({...}) 调用')

  const options = match[1]
  assert.match(options, /hostVersion:\s*options\.hostVersion/, 'engines.vscordis 的强制依赖这条接线')
  assert.match(options, /vscodeVersion:\s*vscode\.version/, 'engines.vscode 的强制依赖这条接线')
})
