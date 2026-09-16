import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { PluginEntry } from '@vscordis/kernel'
import { NodeModuleLoader } from '../src/loader-node.ts'
import { PluginWatcher, planReload } from '../src/watcher.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootA = path.resolve('/repo/plugins')
const rootB = path.resolve('/repo/extra')

test('planReload：产物变化 → 命中对应插件目录，且不需要重扫', () => {
  const plan = planReload([path.join(rootA, 'hello', 'dist', 'index.cjs')], [rootA])
  assert.deepEqual(plan.changedDirs, [path.join(rootA, 'hello')])
  assert.equal(plan.rediscover, false)
  assert.deepEqual(plan.ignored, [])
})

test('planReload：plugin.json 变化 → 必须升级为重新扫描', () => {
  const plan = planReload([path.join(rootA, 'hello', 'plugin.json')], [rootA])
  assert.deepEqual(plan.changedDirs, [path.join(rootA, 'hello')])
  assert.equal(plan.rediscover, true)
})

test('planReload：多个插件同时变化 → 去重后全部命中', () => {
  const plan = planReload(
    [
      path.join(rootA, 'a', 'dist', 'index.cjs'),
      path.join(rootA, 'a', 'dist', 'index.cjs.map'),
      path.join(rootA, 'b', 'plugin.json'),
    ],
    [rootA],
  )
  assert.deepEqual([...plan.changedDirs].sort(), [path.join(rootA, 'a'), path.join(rootA, 'b')])
  assert.equal(plan.rediscover, true)
})

test('planReload：多根场景按所属根归属', () => {
  const plan = planReload([path.join(rootB, 'x', 'dist', 'index.cjs')], [rootA, rootB])
  assert.deepEqual(plan.changedDirs, [path.join(rootB, 'x')])
})

test('planReload：编辑器噪声文件被忽略', () => {
  const noise = [
    path.join(rootA, 'hello', '.index.cjs.swp'),
    path.join(rootA, 'hello', 'index.cjs~'),
    path.join(rootA, 'hello', '.DS_Store'),
    path.join(rootA, 'hello', 'plugin.json.tmp'),
  ]
  const plan = planReload(noise, [rootA])
  assert.deepEqual(plan.changedDirs, [])
  assert.equal(plan.rediscover, false)
  assert.equal(plan.ignored.length, noise.length)
})

test('planReload：根目录之外的路径被忽略', () => {
  const plan = planReload([path.resolve('/somewhere/else/file.cjs')], [rootA])
  assert.deepEqual(plan.changedDirs, [])
  assert.equal(plan.rediscover, false)
})

test('planReload：直接落在插件根下的文件 → 只能整体重扫（定位不到具体插件）', () => {
  const plan = planReload([path.join(rootA, 'plugin.json')], [rootA])
  assert.deepEqual(plan.changedDirs, [])
  assert.equal(plan.rediscover, true)
  assert.equal(plan.ignored.length, 1)
})

test('planReload：空输入不产生任何计划', () => {
  const plan = planReload([], [rootA])
  assert.deepEqual(plan.changedDirs, [])
  assert.equal(plan.rediscover, false)
})

// ————————————————————————————————— 真实 fs.watch 集成测试

interface FixturePlugin {
  name: string
  activate(): void
  __tag(): string
}

async function writeFixture(pluginDir: string, tag: string): Promise<void> {
  await mkdir(path.join(pluginDir, 'dist'), { recursive: true })
  await writeFile(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify({ id: 'hr-fixture', name: 'Hot reload fixture', version: '1.0.0', main: 'dist/index.cjs', trust: 'trusted', permissions: [] }),
    'utf8',
  )
  await writeFile(
    path.join(pluginDir, 'dist', 'index.cjs'),
    `let activations = 0\nmodule.exports = {\n  name: 'hr-fixture',\n  activate() { activations += 1 },\n  __tag() { return ${JSON.stringify(tag)} },\n}\n`,
    'utf8',
  )
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`等待条件成立超时（${timeoutMs}ms）`)
}

test('集成：dist 产物被重写 → fs.watch 触发计划 → 重载拿到新模块实例', async () => {
  const scratch = path.join(here, 'scratch')
  const pluginDir = path.join(scratch, 'hr-fixture')
  await writeFixture(pluginDir, 'v1')

  const plans: { changedDirs: readonly string[]; rediscover: boolean }[] = []
  const watcher = new PluginWatcher({
    roots: () => [scratch],
    debounceMs: 60,
    onPlan: (plan) => void plans.push(plan),
  })

  const entry: PluginEntry = {
    root: pluginDir,
    mainPath: path.join(pluginDir, 'dist', 'index.cjs'),
    source: 'workspace',
    manifest: {
      id: 'hr-fixture',
      name: 'Hot reload fixture',
      version: '1.0.0',
      main: 'dist/index.cjs',
      description: undefined,
      provides: [],
      dependencies: {},
      permissions: [],
      trust: 'trusted',
    },
  }

  watcher.refresh()
  try {
    assert.equal(watcher.active, 1, '应当成功挂上一个监听器')

    const loader = new NodeModuleLoader()
    const before = loader.load(entry)
    assert.equal((before.plugin as unknown as FixturePlugin).__tag(), 'v1')

    // 模拟 esbuild --watch 的下一次增量产物
    await writeFixture(pluginDir, 'v2')

    await waitFor(() => plans.length > 0)
    const plan = plans[0]
    assert.ok(plan !== undefined)
    assert.ok(
      plan.changedDirs.map((dir) => path.resolve(dir)).includes(path.resolve(pluginDir)),
      `计划应命中插件目录，实际为 ${JSON.stringify(plan.changedDirs)}`,
    )

    // 走一次真实的"卸载 → 重新 require"
    before.release()
    const after = loader.load(entry)
    assert.equal((after.plugin as unknown as FixturePlugin).__tag(), 'v2', '重载后必须是新产物')
    after.release()
  } finally {
    watcher.dispose()
  }

  assert.equal(watcher.active, 0, 'dispose 后不应残留监听器')
})

test('dispose 之后不再产生任何计划（防止卸载后的幽灵重载）', async () => {
  const scratch = path.join(here, 'scratch')
  const pluginDir = path.join(scratch, 'hr-quiet')
  await writeFixture(pluginDir, 'v1')

  const plans: unknown[] = []
  const watcher = new PluginWatcher({ roots: () => [scratch], debounceMs: 40, onPlan: (plan) => void plans.push(plan) })
  watcher.refresh()

  // 哨兵：先证明监听确实工作。否则"dispose 后无计划"可能只是"监听从未工作"。
  await writeFixture(pluginDir, 'v2')
  await waitFor(() => plans.length > 0)
  assert.ok(plans.length > 0, 'dispose 之前必须真的收到过计划，否则本用例没有证明力')
  plans.length = 0

  watcher.dispose()
  await writeFixture(pluginDir, 'v3')
  await new Promise((resolve) => setTimeout(resolve, 250))

  assert.deepEqual(plans, [])
})
