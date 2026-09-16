import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CordisPlugin, EffectScopeApi, PluginContext } from '@vscordis/sdk'
import { PluginHost } from '../src/plugin-host.ts'
import { FakeHostPort, makeEntry } from './support.ts'

/**
 * 浸泡测试：为「卸载后无残留」这条验收标准提供**可复现的结构性证据**。
 *
 * 为什么是结构而不是内存：结构断言（栈归零、注册表槽位归零、命令表归零、模块已释放）
 * 是确定性的，任何人都能复现；而"内存没涨"在没有 GC 的前提下根本不可断言。
 * 内存只做**宽松上界**的观察（见最后一个用例），用来抓"每轮泄漏一兆"那种灾难性回归。
 *
 * 依赖链 A→B→C 是刻意选的：它同时覆盖"消费者随提供者暂停"的级联路径，
 * 而级联是这套设计里最容易留下残影的地方（B 暂停时它的 provide 会被回收，进而牵动 C）。
 */

const CYCLES = 200

function makePort(): FakeHostPort {
  const port = new FakeHostPort()
  port.define('A', (): CordisPlugin => ({
    activate(ctx) {
      ctx.provide('clock', { n: 1 }, { version: '1.0.0' })
      ctx.effect(
        () => ctx.vscode.commands.registerCommand('a.run', () => 1),
        (disposable) => disposable.dispose(),
        'cmd:a',
      )
    },
  }))
  port.define('B', (): CordisPlugin => ({
    activate(ctx) {
      ctx.use('clock')
      ctx.provide('scheduler', { n: 1 }, { version: '1.0.0' })
      ctx.effect(
        () => ctx.vscode.commands.registerCommand('b.run', () => 1),
        (disposable) => disposable.dispose(),
        'cmd:b',
      )
    },
  }))
  port.define('C', (): CordisPlugin => ({
    activate(ctx) {
      ctx.use('scheduler')
      ctx.effect(
        () => ctx.vscode.commands.registerCommand('c.run', () => 1),
        (disposable) => disposable.dispose(),
        'cmd:c',
      )
    },
  }))
  return port
}

function entries(): { a: ReturnType<typeof makeEntry>; b: ReturnType<typeof makeEntry>; c: ReturnType<typeof makeEntry> } {
  const permissions = ['vscode:commands.register']
  return {
    a: makeEntry('A', { permissions, provides: ['clock'] }),
    b: makeEntry('B', { permissions, provides: ['scheduler'], dependencies: { clock: '^1.0.0' } }),
    c: makeEntry('C', { permissions, dependencies: { scheduler: '^1.0.0' } }),
  }
}

test(`浸泡：${CYCLES} 轮「加载 3 个插件 → 全部卸载」，每轮结构归零`, async () => {
  const port = makePort()
  const { a, b, c } = entries()
  const host = new PluginHost({ port, disposeTimeoutMs: 200, activationTimeoutMs: 2_000 })

  const perCycle: { id: string; effects: EffectScopeApi }[] = []
  port.define('observer-not-used', (): CordisPlugin => ({ activate() {} }))

  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    const snapshot: { id: string; effects: EffectScopeApi }[] = []
    const capture = (id: string, ctx: PluginContext): void => void snapshot.push({ id, effects: ctx.effects })

    // 每轮用新的工厂，目的是把当轮的 ctx.effects 抓出来（工厂在 loadModule 时被调用）
    port.define('A', (): CordisPlugin => ({
      activate(ctx) {
        capture('A', ctx)
        ctx.provide('clock', { n: 1 }, { version: '1.0.0' })
        ctx.effect(
          () => ctx.vscode.commands.registerCommand('a.run', () => 1),
          (disposable) => disposable.dispose(),
          'cmd:a',
        )
      },
    }))

    await host.load(a)
    await host.load(b)
    await host.load(c)
    await host.settle()
    assert.equal(
      host.list().filter((view) => view.state === 'active').length,
      3,
      `第 ${cycle} 轮应三个插件全部 active`,
    )

    await host.unloadAll()
    await host.settle()

    // 每轮都做结构断言 —— 这是"无残留"的核心证据，而不是只在最后看一眼
    assert.deepEqual(host.list(), [], `第 ${cycle} 轮卸载后不应有插件记录`)
    assert.equal(host.registry.size, 0, `第 ${cycle} 轮注册表仍有槽位残留`)
    assert.equal(port.commands.size, 0, `第 ${cycle} 轮宿主命令表仍有残留`)
    assert.equal(port.liveCommands().length, 0)

    for (const { id, effects } of snapshot) {
      assert.equal(effects.closed, true, `第 ${cycle} 轮 ${id} 的副作用栈未关闭`)
      assert.equal(effects.size, 0, `第 ${cycle} 轮 ${id} 的副作用栈有 ${effects.size} 项残留`)
    }
    // 清掉对当轮闭包的引用：否则是**测试自己**在累积内存，会污染后面的内存观察
    snapshot.length = 0
    perCycle.length = 0
  }

  assert.equal(port.moduleReleases.length, CYCLES * 3, '每次加载都应当对应一次模块释放')
  assert.deepEqual(host.registry.providedServices(), [])
  await host.dispose()
})

test('浸泡：反复 reload 同一插件，模块实例每次都是新的，且不留缓存', async () => {
  const port = new FakeHostPort()
  const incarnations: number[] = []
  let counter = 0
  port.define('reloading', (): CordisPlugin => {
    counter += 1
    const incarnation = counter
    return {
      activate(ctx) {
        incarnations.push(incarnation)
        ctx.effect(
          () => ctx.vscode.commands.registerCommand('r.run', () => incarnation),
          (disposable) => disposable.dispose(),
          'cmd:r',
        )
      },
    }
  })

  const host = new PluginHost({ port, disposeTimeoutMs: 200, activationTimeoutMs: 2_000 })
  const entry = makeEntry('reloading', { permissions: ['vscode:commands.register'] })

  await host.load(entry)
  for (let round = 0; round < 50; round += 1) {
    await host.reload('reloading')
    await host.settle()
    assert.equal(port.commands.size, 1, `第 ${round} 轮重载后应恰好有 1 条命令（不是累积）`)
    assert.equal(port.liveCommands().length, 1)
  }

  assert.equal(incarnations.length, 51, '首载 + 50 次重载，应当有 51 个不同的模块实例')
  assert.deepEqual(
    [...incarnations].sort((x, y) => x - y),
    Array.from({ length: 51 }, (_value, index) => index + 1),
    '每次 reload 都必须拿到全新模块（缓存没清干净时会重复出现同一个 incarnation）',
  )

  await host.unload('reloading')
  await host.settle()
  assert.equal(port.commands.size, 0)
  assert.equal(host.registry.size, 0)
  assert.equal(port.moduleReleases.length, 51)
  await host.dispose()
})

test('浸泡：内存趋势只做宽松上界观察（没做 GC 的堆数据不足以断言泄漏）', async () => {
  const port = makePort()
  const { a, b, c } = entries()
  const host = new PluginHost({ port, disposeTimeoutMs: 200, activationTimeoutMs: 2_000 })

  // 先跑 20 轮热身，让 V8 完成初次优化与内建对象的分配
  for (let cycle = 0; cycle < 20; cycle += 1) {
    await host.load(a)
    await host.load(b)
    await host.load(c)
    await host.settle()
    await host.unloadAll()
    await host.settle()
  }

  const before = process.memoryUsage().heapUsed
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    await host.load(a)
    await host.load(b)
    await host.load(c)
    await host.settle()
    await host.unloadAll()
    await host.settle()
  }
  const growthMb = (process.memoryUsage().heapUsed - before) / (1024 * 1024)

  console.log(
    `  [浸泡] ${CYCLES} 轮 × 3 插件，heapUsed 变化 ≈ ${growthMb.toFixed(1)} MB（未 GC，只作趋势参考）`,
  )

  // 宽松上界：正常实现下这里通常是几 MB 甚至负数；超过 60MB 基本可以断定"每轮泄漏了大量对象"。
  assert.ok(
    growthMb < 60,
    `堆增长 ${growthMb.toFixed(1)} MB 超过宽松上界 60MB，疑似每轮泄漏（请用 --expose-gc 复核）`,
  )

  await host.dispose()
})
