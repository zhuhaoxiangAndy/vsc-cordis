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

/**
 * `--expose-gc` 下的**严格内存证据**（ADR-0015 已知缺口 2 的补齐）。
 *
 * 默认 skip：`pnpm test` 没有 `global.gc`，未 GC 的堆数据证明不了泄漏（见上一个用例）。
 * 显式运行：`node --expose-gc packages/kernel/test/soak.spec.ts`
 *   （注意：`node --expose-gc --test ...` 的 V8 标志**不会**传给 test runner 的子进程，
 *    那样 `global.gc` 是 undefined，用例会被跳过。）
 *
 * 做法：热身 100 轮 → 清夹具记账 + 强制 GC → 取基线 → 再跑 1000 轮 → 清记账 + 强制 GC → 比较。
 *
 * **为什么必须清夹具记账**：这是实测出来的坑。`PluginHost` 每次状态转换都会记一条 debug 日志，
 * 而 `FakeHostPort.logs` 是数组 —— 3000 轮探针显示：不清记账时堆以 ~4KB/轮**线性**增长
 * （full 变体 +11MB），清掉 `logs` / `moduleLoads` / `moduleReleases` 后曲线是**平台期**
 * （3000 轮后仍稳定在 ~8.5MB）。也就是说，那 11MB 是**测试夹具**的增长，不是运行时残留。
 * 量内存时把夹具自己的记账留在里面，就会把工具当成被测对象。
 *
 * 1000 轮 × 3 插件把"每轮泄漏 1KB"放大成约 1MB —— 越过下面 0.8MB 的阈值。
 */
const STRICT_CYCLES = 1000
const STRICT_WARMUP = 100
const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc

test(
  '浸泡（严格）：--expose-gc 下 1000 轮的堆增长回到噪声范围',
  {
    skip:
      gc === undefined
        ? '需要 --expose-gc：node --expose-gc packages/kernel/test/soak.spec.ts'
        : false,
  },
  async () => {
    const collect = (): void => {
      // 连做三次：把可能进入老生代的引用也推下去，减少"刚好没回收"的假阳性
      for (let round = 0; round < 3; round += 1) gc?.()
    }
    const port = makePort()
    const { a, b, c } = entries()
    const host = new PluginHost({ port, disposeTimeoutMs: 200, activationTimeoutMs: 2_000 })

    /** 清掉**夹具自身**的记账（日志/模块流水/权限调用），否则量到的是夹具的增长。 */
    const clearFixtureBookkeeping = (): void => {
      port.logs.length = 0
      port.moduleLoads.length = 0
      port.moduleReleases.length = 0
      port.apiCalls.length = 0
    }

    const oneCycle = async (): Promise<void> => {
      await host.load(a)
      await host.load(b)
      await host.load(c)
      await host.settle()
      await host.unloadAll()
      await host.settle()
    }

    for (let cycle = 0; cycle < STRICT_WARMUP; cycle += 1) await oneCycle()
    clearFixtureBookkeeping()
    collect()
    const before = process.memoryUsage().heapUsed

    for (let cycle = 0; cycle < STRICT_CYCLES; cycle += 1) await oneCycle()

    const releases = port.moduleReleases.length
    clearFixtureBookkeeping()
    collect()
    const growthMb = (process.memoryUsage().heapUsed - before) / (1024 * 1024)

    console.log(
      `  [浸泡·严格] ${STRICT_CYCLES} 轮 × 3 插件（GC 后、清夹具记账）：heapUsed 变化 ${growthMb.toFixed(2)} MB`,
    )

    // 实测平台期约 0.1–0.3MB；阈值留出余量。真实泄漏（每轮 ~1KB 以上）会超过它。
    assert.ok(growthMb < 0.8, `GC 后堆仍增长 ${growthMb.toFixed(2)} MB，疑似真实泄漏`)
    // 严格模式同样要保住结构不变式（否则"内存没涨"可能只是记账又没生效 —— ADR-0019 的假绿教训）
    assert.deepEqual(host.list(), [])
    assert.equal(host.registry.size, 0)
    assert.equal(port.commands.size, 0)
    assert.equal(releases, STRICT_CYCLES * 3, '每次加载都应当对应一次模块释放')

    await host.dispose()
  },
)

/**
 * 规模证据：**长依赖链**是服务注册表里最贵的形状 —— 卸载 A1 要计算 A1 的传递闭包
 * （`affectedBy` 做 BFS），撤销会沿链级联。300 个插件足以把"每个插件 O(n)"级
 * 的退化放大成肉眼可见的耗时，同时仍是秒级测试。
 *
 * 断言分两层：**结构**（加载后恰好 N 个槽位与命令，卸载后全部归零）与**宽松耗时上界**
 * （实测约几百毫秒；10s 上界只用来抓 O(n²)+ 的灾难性回归，不做性能承诺）。
 */
test('规模：300 插件依赖链加载 → 卸载，结构归零且耗时远低于宽松上界', async () => {
  const COUNT = 300
  const port = new FakeHostPort()
  const entries: ReturnType<typeof makeEntry>[] = []

  for (let index = 0; index < COUNT; index += 1) {
    const id = `chain-${index}`
    const dependency = index === 0 ? undefined : `svc-${index - 1}`
    port.define(id, (): CordisPlugin => ({
      activate(ctx) {
        if (dependency !== undefined) ctx.use(dependency)
        ctx.provide(`svc-${index}`, { n: index }, { version: '1.0.0' })
        ctx.effect(
          () => ctx.vscode.commands.registerCommand(`${id}.run`, () => index),
          (disposable) => disposable.dispose(),
          `cmd:${id}`,
        )
      },
    }))
    entries.push(
      makeEntry(id, {
        permissions: ['vscode:commands.register'],
        provides: [`svc-${index}`],
        ...(dependency === undefined ? {} : { dependencies: { [dependency]: '^1.0.0' } }),
      }),
    )
  }

  const host = new PluginHost({ port, disposeTimeoutMs: 200, activationTimeoutMs: 5_000 })
  const started = Date.now()

  for (const entry of entries) await host.load(entry)
  await host.settle()
  for (const entry of entries) {
    assert.equal(host.view(entry.manifest.id)?.state, 'active', `${entry.manifest.id} 应当是 active`)
  }
  // 中途结构断言：既不少（漏注册）也不多（重复登记）
  assert.equal(host.registry.providedServices().length, COUNT)
  assert.equal(port.commands.size, COUNT)

  await host.unloadAll()
  await host.settle()
  const elapsed = Date.now() - started

  assert.deepEqual(host.list(), [])
  assert.equal(host.registry.size, 0, '卸载后注册表不得留下任何槽位')
  assert.equal(port.commands.size, 0)
  assert.equal(port.moduleReleases.length, COUNT, '每次加载都应当对应一次模块释放')

  console.log(`  [规模] ${COUNT} 插件依赖链：加载 + 卸载共 ${elapsed}ms`)
  assert.ok(elapsed < 10_000, `${COUNT} 插件链加载+卸载耗时 ${elapsed}ms，超过宽松上界 10s`)

  await host.dispose()
})
