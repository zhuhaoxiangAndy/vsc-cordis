import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CordisPlugin } from '@vscordis/sdk'
import { PluginEngineMismatchError } from '../src/errors.ts'
import { validateManifest } from '../src/manifest.ts'
import { PluginHost } from '../src/plugin-host.ts'
import { FakeHostPort, makeEntry } from './support.ts'

/**
 * `plugin.json#engines` 的强制（ADR-0017）。
 *
 * 背景：这个字段在 SDK 类型里声明着，但内核的 `validateManifest` **根本没读它** ——
 * 作者写了等于没写，而且没有任何反馈。这与 `CordisPlugin.inject`、`provides`
 * 属于同一类"声明了却不生效"的陷阱，本项目的处理原则是：**要么强制，要么响亮告警**。
 */

const base = { id: 'engined', name: 'Engined', version: '1.0.0', main: 'dist/index.cjs' }

function hostFor(port: FakeHostPort, hostVersion: string | undefined, vscodeVersion: string | undefined): PluginHost {
  return new PluginHost({
    port,
    disposeTimeoutMs: 200,
    activationTimeoutMs: 2_000,
    ...(hostVersion === undefined ? {} : { hostVersion }),
    ...(vscodeVersion === undefined ? {} : { vscodeVersion }),
  })
}

test('清单校验：engines 会被读取并归一化（不再被静默丢弃）', () => {
  const result = validateManifest({ ...base, engines: { vscordis: '>=0.1.0', vscode: '^1.95.0' } })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.manifest.engines, { vscordis: '>=0.1.0', vscode: '^1.95.0' })
})

test('清单校验：engines 结构或范围非法 → 拒绝加载（fail-closed）', () => {
  for (const engines of [{ vscordis: '~1.2.3' }, { vscordis: 123 }, 'not-an-object']) {
    const result = validateManifest({ ...base, engines })
    assert.equal(result.ok, false, `engines=${JSON.stringify(engines)} 应当被拒绝`)
  }
})

test('清单校验：engines 里没有可识别的键 → 归一化成 undefined（而不是空对象）', () => {
  const result = validateManifest({ ...base, engines: {} })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.manifest.engines, undefined)
})

test('engines.vscordis 不满足 → 拒绝加载，且**模块根本没被加载**', async () => {
  const port = new FakeHostPort()
  port.define('engined', (): CordisPlugin => ({ activate() {} }))

  const host = hostFor(port, '0.1.0', '1.95.0')
  await assert.rejects(host.load(makeEntry('engined', { engines: { vscordis: '^2.0.0' } })), (error: unknown) => {
    assert.ok(error instanceof PluginEngineMismatchError)
    assert.match(String(error), /与当前运行环境不兼容/)
    assert.match(String(error), /engines\.vscordis = \^2\.0\.0（实际 0\.1\.0）/)
    return true
  })

  assert.equal(host.view('engined')?.state, 'failed')
  assert.deepEqual(port.moduleLoads, [], '不兼容的插件不该被加载模块 —— 连求值都不该发生')
  assert.equal(port.moduleReleases.length, 0)
})

test('engines.vscode 不满足 → 拒绝加载', async () => {
  const port = new FakeHostPort()
  port.define('engined', (): CordisPlugin => ({ activate() {} }))

  const host = hostFor(port, '0.1.0', '1.80.0')
  await assert.rejects(host.load(makeEntry('engined', { engines: { vscode: '^1.95.0' } })), (error: unknown) => {
    assert.match(String(error), /engines\.vscode = \^1\.95\.0（实际 1\.80\.0）/)
    return true
  })
})

test('engines 满足 → 正常加载', async () => {
  const port = new FakeHostPort()
  port.define('engined', (): CordisPlugin => ({ activate() {} }))

  const host = hostFor(port, '0.1.0', '1.107.1')
  await host.load(makeEntry('engined', { engines: { vscordis: '>=0.1.0', vscode: '^1.95.0' } }))
  await host.settle()
  assert.equal(host.view('engined')?.state, 'active')
  await host.dispose()
})

test('带预发布后缀的版本会先做宽松归一化（0.1.0-beta 满足 >=0.1.0）', async () => {
  const port = new FakeHostPort()
  port.define('engined', (): CordisPlugin => ({ activate() {} }))

  // 不归一化的话，semver-mini 认不出 '0.1.0-beta.3'，会把一个合法声明判成不兼容
  const host = hostFor(port, '0.1.0-beta.3', '1.107.1-insider')
  await host.load(makeEntry('engined', { engines: { vscordis: '>=0.1.0', vscode: '^1.95.0' } }))
  await host.settle()
  assert.equal(host.view('engined')?.state, 'active')
  await host.dispose()
})

test('调用方未提供版本 → 跳过检查（并记一条 debug 日志，而不是静默跳过）', async () => {
  const port = new FakeHostPort()
  port.define('engined', (): CordisPlugin => ({ activate() {} }))

  const host = hostFor(port, undefined, undefined)
  await host.load(makeEntry('engined', { engines: { vscordis: '^9.9.9' } }))
  await host.settle()
  assert.equal(host.view('engined')?.state, 'active')

  const log = port.logs.find((entry) => entry.message.includes('未提供对应版本'))
  assert.ok(log !== undefined, '跳过检查时必须留下痕迹，否则就是静默跳过')
  assert.equal(log.level, 'debug')
  await host.dispose()
})

test('没有 engines 声明 → 不受影响', async () => {
  const port = new FakeHostPort()
  port.define('plain', (): CordisPlugin => ({ activate() {} }))

  const host = hostFor(port, '0.1.0', '1.107.1')
  await host.load(makeEntry('plain'))
  await host.settle()
  assert.equal(host.view('plain')?.state, 'active')
  await host.dispose()
})
