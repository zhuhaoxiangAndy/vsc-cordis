import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { PluginEntry } from '@vscordis/kernel'
import {
  NodeModuleLoader,
  PluginEntryNotFoundError,
  PluginPathEscapeError,
  isInside,
} from '../src/loader-node.ts'

/**
 * 这是本项目里唯一能**真实执行**的宿主侧测试（不需要启动 VSCode）：
 * 它验证的是"卸载无残留"在模块层面的那一半 —— require.cache 是否真的被清干净。
 *
 * 桥接层（bridge.ts）需要真实 vscode 模块，只能靠 `tsc --noEmit` + F5 手动验收覆盖，
 * 这一点已在验收文档里显式声明，不做隐瞒。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')
const sampleRoot = path.join(fixtures, 'sample-plugin')
const multiRoot = path.join(fixtures, 'multi-file')
const repoRoot = path.resolve(here, '..', '..', '..')

const nodeRequire = createRequire(import.meta.url)

interface Telemetry {
  incarnation: string
  activations: number
}

interface FixturePlugin {
  name: string
  activate(): void
  __telemetry(): Telemetry
}

function entryFor(root: string, main: string, id = 'fixture'): PluginEntry {
  return {
    root,
    mainPath: path.join(root, main),
    source: 'workspace',
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      main,
      description: undefined,
      provides: [],
      dependencies: {},
      permissions: [],
      trust: 'trusted',
    },
  }
}

function isCached(file: string): boolean {
  const target = path.resolve(file)
  return Object.keys(nodeRequire.cache).some((key) => path.resolve(key) === target)
}

test('加载夹具插件并释放后，require.cache 中不再有它的痕迹', () => {
  const loader = new NodeModuleLoader()
  const loaded = loader.load(entryFor(sampleRoot, 'index.cjs'))
  const plugin = loaded.plugin as unknown as FixturePlugin

  const entryFile = path.join(sampleRoot, 'index.cjs')
  assert.equal(isCached(entryFile), true)

  plugin.activate()
  assert.equal(plugin.__telemetry().activations, 1)

  loaded.release()
  assert.equal(isCached(entryFile), false, '释放后入口不应留在 require.cache 里')
})

test('释放后重新加载得到全新的模块实例（模块级状态被重置）', () => {
  const loader = new NodeModuleLoader()

  const first = loader.load(entryFor(sampleRoot, 'index.cjs'))
  const firstPlugin = first.plugin as unknown as FixturePlugin
  firstPlugin.activate()
  firstPlugin.activate()
  const firstTelemetry = firstPlugin.__telemetry()
  assert.equal(firstTelemetry.activations, 2)
  first.release()

  const second = loader.load(entryFor(sampleRoot, 'index.cjs'))
  const secondPlugin = second.plugin as unknown as FixturePlugin
  const secondTelemetry = secondPlugin.__telemetry()

  // 关键断言：incarnation 变化 = 模块被重新求值；activations 归零 = 旧实例的状态没有泄漏过来
  assert.notEqual(secondTelemetry.incarnation, firstTelemetry.incarnation)
  assert.equal(secondTelemetry.activations, 0)
  second.release()
})

test('多文件插件：释放时整棵子树都被清出缓存，而不只是入口', () => {
  const loader = new NodeModuleLoader()
  const entryFile = path.join(multiRoot, 'index.cjs')
  const helperFile = path.join(multiRoot, 'helper.cjs')

  const loaded = loader.load(entryFor(multiRoot, 'index.cjs', 'multi-file'))
  assert.equal(isCached(entryFile), true)
  assert.equal(isCached(helperFile), true, '入口 require 的子模块应当被缓存')

  loaded.release()

  assert.equal(isCached(entryFile), false)
  assert.equal(isCached(helperFile), false, '只清入口会留下整棵残留树')
})

test('加载前会先遗忘上一代缓存（热重载必须拿到新模块）', () => {
  const loader = new NodeModuleLoader()
  const entry = entryFor(sampleRoot, 'index.cjs')

  const first = loader.load(entry)
  const firstIncarnation = (first.plugin as unknown as FixturePlugin).__telemetry().incarnation
  // 故意**不**调用 release()，模拟上一代没被正确回收的情况
  const second = loader.load(entry)
  const secondIncarnation = (second.plugin as unknown as FixturePlugin).__telemetry().incarnation

  assert.notEqual(secondIncarnation, firstIncarnation)
  second.release()
})

test('入口文件不存在时给出可操作的错误（而不是一句 ENOENT）', () => {
  const loader = new NodeModuleLoader()
  assert.throws(() => loader.load(entryFor(sampleRoot, 'missing.cjs')), PluginEntryNotFoundError)
  assert.throws(() => loader.load(entryFor(sampleRoot, 'missing.cjs')), /npm run build/)
})

test('realpath 后越出插件根目录的入口被拒绝（防 symlink / .. 逃逸）', () => {
  const loader = new NodeModuleLoader()
  // 这个文件真实存在，但不在插件根目录内
  assert.throws(
    () => loader.load(entryFor(sampleRoot, '../../../../../package.json')),
    PluginPathEscapeError,
  )
  assert.equal(repoRoot.endsWith('vsc-cordis'), true, '夹具路径假设：仓库根目录')
})

test('isInside 的边界', () => {
  const root = path.resolve('/repo/plugins/hello')
  assert.equal(isInside(root, path.resolve('/repo/plugins/hello/dist/index.cjs')), true)
  assert.equal(isInside(root, root), false)
  assert.equal(isInside(root, path.resolve('/repo/plugins/hello-other/index.cjs')), false)
  assert.equal(isInside(root, path.resolve('/repo/plugins/../other/index.cjs')), false)
  // `..evil` 是 root 内的普通目录名，不能被 startsWith('..') 误判成越界（审计 M1）
  assert.equal(isInside(root, path.resolve('/repo/plugins/hello/..evil/index.cjs')), true)
})
