import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CordisPlugin, PluginContext } from '@vscordis/sdk'
import { IsolationUnavailableError, PermissionDeniedError, PluginAlreadyLoadedError } from '../src/errors.ts'
import { PluginHost } from '../src/plugin-host.ts'
import { FakeHostPort, makeEntry } from './support.ts'

const WITH_COMMAND = ['vscode:commands.register']

function hostFor(port: FakeHostPort): PluginHost {
  return new PluginHost({ port, disposeTimeoutMs: 200 })
}

/** 推荐写法：注册副作用 + 显式逆操作。 */
function registerCommandEffect(ctx: PluginContext, id: string): void {
  ctx.effect(
    () => ctx.vscode.commands.registerCommand(id, () => id),
    (handle) => handle.dispose(),
    `command:${id}`,
  )
}

test('M1：加载→注册命令→卸载后命令从注册表消失，且零残留', async () => {
  const port = new FakeHostPort()
  let captured: PluginContext['effects'] | undefined
  let deactivations = 0

  port.define('hello', (): CordisPlugin => ({
    activate(ctx) {
      captured = ctx.effects
      registerCommandEffect(ctx, 'hello.greet')
    },
    deactivate() {
      deactivations += 1
    },
  }))

  const host = hostFor(port)
  const view = await host.load(makeEntry('hello', { permissions: WITH_COMMAND }))

  assert.equal(view.state, 'active')
  assert.deepEqual(port.liveCommands(), ['hello.greet'])

  await host.unload('hello')
  await host.settle()

  // 验收标准：命令注册表为空 + 副作用栈归零 + 模块已释放 + 注册表无残留槽位
  assert.equal(deactivations, 1)
  assert.deepEqual(port.liveCommands(), [])
  assert.equal(captured?.size, 0)
  assert.equal(captured?.closed, true)
  assert.deepEqual(port.moduleReleases, ['hello'])
  assert.deepEqual(host.list(), [])
  assert.deepEqual(host.registry.providedServices(), [])
  assert.equal(host.registry.size, 0)
})

test('桥接层安全网：插件漏写 ctx.effect 也不会泄漏', async () => {
  const port = new FakeHostPort()
  port.define('lazy', (): CordisPlugin => ({
    activate(ctx) {
      // 刻意不包 ctx.effect —— 依赖宿主桥接层的自动登记
      void ctx.vscode.commands.registerCommand('lazy.run', () => 1)
    },
  }))

  const host = hostFor(port)
  await host.load(makeEntry('lazy', { permissions: WITH_COMMAND }))
  assert.deepEqual(port.liveCommands(), ['lazy.run'])

  await host.unload('lazy')
  await host.settle()
  assert.deepEqual(port.liveCommands(), [])
})

test('activate 抛错：回滚已产生的副作用并标记 failed', async () => {
  const port = new FakeHostPort()
  port.define('boom', (): CordisPlugin => ({
    activate(ctx) {
      registerCommandEffect(ctx, 'boom.run')
      throw new Error('故意失败')
    },
  }))

  const host = hostFor(port)
  await assert.rejects(() => host.load(makeEntry('boom', { permissions: WITH_COMMAND })), /故意失败/)

  assert.equal(host.view('boom')?.state, 'failed')
  assert.match(host.view('boom')?.error ?? '', /故意失败/)
  assert.deepEqual(port.liveCommands(), []) // 半成品副作用已回滚
  assert.deepEqual(port.moduleReleases, ['boom'])
})

test('权限不足：越权调用抛 PermissionDeniedError，插件进入 failed 且不留残留', async () => {
  const port = new FakeHostPort()
  port.define('nogrant', (): CordisPlugin => ({
    activate(ctx) {
      registerCommandEffect(ctx, 'nogrant.run')
    },
  }))

  const host = hostFor(port)
  await assert.rejects(() => host.load(makeEntry('nogrant', { permissions: [] })), PermissionDeniedError)

  assert.equal(host.view('nogrant')?.state, 'failed')
  assert.match(host.view('nogrant')?.error ?? '', /未获得权限/)
  assert.deepEqual(port.liveCommands(), [])
})

test('fail-closed：无隔离后端时拒绝加载 untrusted 插件（模块根本不会被加载）', async () => {
  const port = new FakeHostPort({ supportsIsolation: false })
  port.define('third-party', (): CordisPlugin => ({
    activate() {
      throw new Error('这段代码永远不应该被执行')
    },
  }))

  const host = hostFor(port)
  await assert.rejects(
    () => host.load(makeEntry('third-party', { trust: 'untrusted' })),
    IsolationUnavailableError,
  )

  assert.equal(host.view('third-party')?.state, 'failed')
  assert.deepEqual(port.moduleLoads, [])
})

test('有隔离后端时，untrusted 插件正常加载（策略门只在后端缺失时关闭）', async () => {
  const port = new FakeHostPort({ supportsIsolation: true })
  port.define('third-party', (): CordisPlugin => ({ activate() {} }))

  const host = hostFor(port)
  const view = await host.load(makeEntry('third-party', { trust: 'untrusted' }))
  assert.equal(view.state, 'active')
})

test('重复加载被拒绝', async () => {
  const port = new FakeHostPort()
  port.define('dup', (): CordisPlugin => ({ activate() {} }))

  const host = hostFor(port)
  await host.load(makeEntry('dup'))
  await assert.rejects(() => host.load(makeEntry('dup')), PluginAlreadyLoadedError)
})

test('M2：提供者卸载 → 消费者自动 paused 且其命令消失；提供者恢复 → 消费者自动 active 并拿到新实例', async () => {
  const port = new FakeHostPort()
  let generation = 0
  let consumerActivations = 0
  let consumerDeactivations = 0
  let seen: { gen: number } | undefined

  port.define('provider', (): CordisPlugin => ({
    activate(ctx) {
      generation += 1
      ctx.provide('clock', { gen: generation }, { version: '1.0.0' })
    },
  }))

  port.define('consumer', (): CordisPlugin => ({
    activate(ctx) {
      consumerActivations += 1
      seen = ctx.use<{ gen: number }>('clock')
      registerCommandEffect(ctx, 'consumer.report')
    },
    deactivate() {
      consumerDeactivations += 1
    },
  }))

  const host = hostFor(port)
  const providerEntry = makeEntry('provider')
  const consumerEntry = makeEntry('consumer', {
    dependencies: { clock: '^1.0.0' },
    permissions: WITH_COMMAND,
  })

  await host.load(providerEntry)
  await host.load(consumerEntry)
  await host.settle()

  assert.equal(host.view('consumer')?.state, 'active')
  assert.equal(seen?.gen, 1)
  assert.deepEqual(port.liveCommands(), ['consumer.report'])

  // 提供者卸载 → 消费者必须自动暂停（完整卸载，但保留记录）
  await host.unload('provider')
  await host.settle()

  assert.equal(host.view('provider'), undefined)
  assert.equal(host.view('consumer')?.state, 'paused')
  assert.deepEqual(host.view('consumer')?.missing, ['clock'])
  assert.equal(consumerDeactivations, 1)
  assert.deepEqual(port.liveCommands(), [])

  // 提供者回来 → 消费者自动恢复，并且拿到的是**新**实例（不是过期引用）
  await host.load(providerEntry)
  await host.settle()

  assert.equal(host.view('consumer')?.state, 'active')
  assert.equal(consumerActivations, 2)
  assert.equal(seen?.gen, 2)
  assert.deepEqual(port.liveCommands(), ['consumer.report'])
})

test('M2：传递闭包 A→B→C 级联暂停、级联恢复（无一行特判代码）', async () => {
  const port = new FakeHostPort()
  port.define('A', (): CordisPlugin => ({
    activate(ctx) {
      ctx.provide('clock', { from: 'A' }, { version: '1.0.0' })
    },
  }))
  port.define('B', (): CordisPlugin => ({
    activate(ctx) {
      ctx.use('clock')
      ctx.provide('scheduler', { from: 'B' }, { version: '1.0.0' })
    },
  }))
  port.define('C', (): CordisPlugin => ({
    activate(ctx) {
      ctx.use('scheduler')
    },
  }))

  const host = hostFor(port)
  const entryA = makeEntry('A')
  await host.load(entryA)
  await host.load(makeEntry('B', { dependencies: { clock: '^1.0.0' } }))
  await host.load(makeEntry('C', { dependencies: { scheduler: '^1.0.0' } }))
  await host.settle()

  assert.deepEqual(
    host.list().map((view) => `${view.id}:${view.state}`),
    ['A:active', 'B:active', 'C:active'],
  )

  await host.unload('A')
  await host.settle()

  // B 因 clock 消失而暂停 → B 的 provide('scheduler') 随其副作用栈被回收 → C 随之暂停
  assert.equal(host.view('B')?.state, 'paused')
  assert.equal(host.view('C')?.state, 'paused')

  await host.load(entryA)
  await host.settle()

  assert.equal(host.view('B')?.state, 'active')
  assert.equal(host.view('C')?.state, 'active')
  assert.deepEqual([...host.registry.providedServices()].sort(), ['clock', 'scheduler'])
})

test('依赖缺失时加载不报错，parked 为 paused；提供者出现后自动激活', async () => {
  const port = new FakeHostPort()
  port.define('consumer', (): CordisPlugin => ({
    activate(ctx) {
      ctx.use('clock')
    },
  }))

  const host = hostFor(port)
  const view = await host.load(makeEntry('consumer', { dependencies: { clock: '^1.0.0' } }))

  assert.equal(view.state, 'paused')
  assert.deepEqual(view.missing, ['clock'])

  port.define('provider', (): CordisPlugin => ({
    activate(ctx) {
      ctx.provide('clock', 1, { version: '1.0.0' })
    },
  }))
  await host.load(makeEntry('provider'))
  await host.settle()

  assert.equal(host.view('consumer')?.state, 'active')
  assert.deepEqual(host.view('consumer')?.missing, [])
})

test('软依赖缺失不阻塞激活，也不参与级联', async () => {
  const port = new FakeHostPort()
  port.define('optional', (): CordisPlugin => ({
    activate(ctx) {
      assert.equal(ctx.tryUse('missing-service'), undefined)
    },
  }))

  const host = hostFor(port)
  const view = await host.load(makeEntry('optional'))
  assert.equal(view.state, 'active')
})

test('reload：模块被重新加载、状态保持 active', async () => {
  const port = new FakeHostPort()
  let activations = 0
  port.define('x', (): CordisPlugin => ({
    activate() {
      activations += 1
    },
  }))

  const host = hostFor(port)
  await host.load(makeEntry('x'))
  assert.equal(activations, 1)

  const view = await host.reload('x')
  await host.settle()

  assert.equal(view.state, 'active')
  assert.equal(activations, 2)
  assert.equal(port.moduleReleases.filter((id) => id === 'x').length, 1)
  assert.deepEqual(host.registry.providedServices(), [])
})

test('CordisPlugin.inject：清单没有 dependencies 时，仅靠 inject 也能正确 parked 并自动恢复', async () => {
  const port = new FakeHostPort()
  let activations = 0
  port.define('inject-only', (): CordisPlugin => ({
    inject: ['clock'],
    activate(ctx) {
      activations += 1
      ctx.use('clock')
    },
  }))

  const host = hostFor(port)
  const view = await host.load(makeEntry('inject-only')) // 注意：清单里没有任何依赖声明

  assert.equal(view.state, 'paused')
  assert.deepEqual(view.missing, ['clock'])
  assert.equal(activations, 0)
  // 读 inject 需要先加载模块；判定失败后必须把模块释放掉，不能留残留
  assert.deepEqual(port.moduleReleases, ['inject-only'])

  port.define('provider', (): CordisPlugin => ({
    activate(ctx) {
      ctx.provide('clock', 1, { version: '1.0.0' })
    },
  }))
  await host.load(makeEntry('provider'))
  await host.settle()

  assert.equal(host.view('inject-only')?.state, 'active')
  assert.equal(activations, 1)
})

test('deactivate 抛错不阻断回收', async () => {
  const port = new FakeHostPort()
  const stackRef: { current?: PluginContext['effects'] } = {}
  port.define('rude', (): CordisPlugin => ({
    activate(ctx) {
      stackRef.current = ctx.effects
      registerCommandEffect(ctx, 'rude.run')
    },
    deactivate() {
      throw new Error('deactivate 失败')
    },
  }))

  const host = hostFor(port)
  await host.load(makeEntry('rude', { permissions: WITH_COMMAND }))
  await host.unload('rude')
  await host.settle()

  assert.deepEqual(port.liveCommands(), [])
  assert.equal(stackRef.current?.size, 0)
  assert.ok(port.logsFor('rude').some((message) => message.includes('deactivate() 抛错')))
})

test('ctx.provide 的 remote 标记不可由插件设置：响亮失败而不是得到"假远程服务"', async () => {
  const port = new FakeHostPort()
  port.define('liar', (): CordisPlugin => ({
    activate(ctx) {
      ctx.provide('fake-remote', { ping: () => 'pong' }, { remote: true })
    },
  }))

  const host = hostFor(port)
  await assert.rejects(host.load(makeEntry('liar')), (error: unknown) => {
    assert.match(String(error), /remote 标记由运行时写入/)
    return true
  })
  await host.settle()

  // 失败要彻底：状态是 failed，注册表里不能留下这个服务，也不能留下空槽位
  assert.equal(host.view('liar')?.state, 'failed')
  assert.deepEqual(host.registry.providedServices(), [])
  assert.equal(host.registry.size, 0)
})

test('disposeBudgetMs：预算耗尽后跳过剩余 teardown，并逐项记日志（ADR-0015 接线）', async () => {
  const port = new FakeHostPort()
  const ran: string[] = []
  port.define('budgeted', (): CordisPlugin => ({
    activate(ctx) {
      // LIFO：后登记的先回收。这里刻意用一个**同步**忙碌项吃掉预算 ——
      // 同步 teardown 无法被预算打断，而预算只在"项与项之间"检查（ADR-0015 的边界），
      // 于是第二项的跳过是确定性的，不依赖 timer 的毫秒级竞态。
      ctx.onDispose(() => {
        ran.push('fast')
      }, 'fast')
      ctx.onDispose(() => {
        const until = Date.now() + 80
        while (Date.now() < until) {
          // 忙等：故意同步占用 80ms，远超下面的 20ms 预算
        }
      }, 'busy')
    },
  }))

  const host = new PluginHost({
    port,
    disposeTimeoutMs: 100,
    disposeBudgetMs: 20,
    activationTimeoutMs: 2_000,
  })
  await host.load(makeEntry('budgeted'))
  await host.settle()

  const started = Date.now()
  await host.unload('budgeted')
  await host.settle()
  const elapsed = Date.now() - started

  assert.deepEqual(ran, [], '预算耗尽后 fast 不应执行（这是刻意的取舍：宁可少回收并留记录）')
  assert.ok(elapsed < 2_000, `卸载必须受预算约束，实际 ${elapsed}ms`)
  // PluginHost 的 onError 把细节放在结构化 meta 里（message 只含 label），
  // 所以这里查 meta.error：被跳过的项必须留下"预算耗尽"这个可检索的原因。
  const details = port.logs
    .filter((entry) => entry.meta?.plugin === 'budgeted')
    .map((entry) => String(entry.meta?.error ?? ''))
    .join('\n')
  assert.match(details, /预算耗尽/)
  assert.match(details, /fast/, '被跳过的项必须留下可检索的记录（不能静默 break）')
})

test('unload：不存在的 id 保持幂等，但会留下 debug 日志（拼错 id 不再静默）', async () => {
  const port = new FakeHostPort()
  port.define('real', (): CordisPlugin => ({ activate() {} }))
  const host = hostFor(port)

  await host.unload('typo-id')
  await host.settle()

  assert.deepEqual(host.list(), [])
  assert.ok(
    port.logsFor('typo-id').some((message) => message.includes('幂等无操作')),
    `应当留下 debug 日志，实际：${port.logsFor('typo-id').join(' | ') || '<无>'}`,
  )
  await host.dispose()
})

test('PluginView.effectCount：active 时是当前副作用项数，paused / 卸载后归零', async () => {
  const port = new FakeHostPort()
  port.define('counted', (): CordisPlugin => ({
    activate(ctx) {
      ctx.onDispose(() => undefined, 'a')
      ctx.onDispose(() => undefined, 'b')
    },
  }))
  // 真实副作用（命令）也要计入；不断言具体条数，避免绑定桥接层的实现细节
  port.define('commander', (): CordisPlugin => ({
    activate(ctx) {
      ctx.effect(
        () => ctx.vscode.commands.registerCommand('commander.run', () => 1),
        (disposable) => disposable.dispose(),
        'cmd',
      )
    },
  }))
  port.define('waiter', (): CordisPlugin => ({ activate() {} }))

  const host = hostFor(port)
  await host.load(makeEntry('counted'))
  await host.settle()
  assert.equal(host.view('counted')?.effectCount, 2, '两个 onDispose 应当对应两项')

  await host.load(makeEntry('commander', { permissions: WITH_COMMAND }))
  await host.settle()
  assert.ok((host.view('commander')?.effectCount ?? 0) >= 1, '命令这类真实副作用必须计入')

  // 缺依赖的插件停在 paused：它**从未建过副作用栈**（预检在模块加载前就拦下了）→ 0
  await host.load(makeEntry('waiter', { dependencies: { nowhere: '^1.0.0' } }))
  await host.settle()
  assert.equal(host.view('waiter')?.state, 'paused')
  assert.equal(host.view('waiter')?.effectCount, 0)

  await host.unload('counted')
  await host.settle()
  assert.equal(host.view('counted'), undefined, '卸载后记录消失，effectCount 也随之不可见')
  await host.dispose()
})

test('settle：必须等到级联产生的后续任务完成，而不是单次 no-op 屏障', async () => {
  const port = new FakeHostPort()
  port.define('q', (): CordisPlugin => ({
    activate(ctx) {
      ctx.provide('c', { v: 'from-q' }, { version: '1.0.0' })
    },
  }))
  port.define('x', (): CordisPlugin => ({
    activate(ctx) {
      ctx.use('c')
    },
  }))
  port.define('r', (): CordisPlugin => ({
    activate(ctx) {
      ctx.use('a')
      ctx.use('b')
      // last-wins 接管 c：这会级联触发 x 的暂停/恢复，属于第二级任务
      ctx.provide('c', { v: 'from-r' }, { conflict: 'last-wins' })
    },
  }))
  port.define('a', (): CordisPlugin => ({
    activate(ctx) {
      ctx.provide('a', {})
    },
  }))
  port.define('b', (): CordisPlugin => ({
    activate(ctx) {
      ctx.provide('b', {})
    },
  }))

  const host = hostFor(port)
  try {
    await host.load(makeEntry('q'))
    await host.load(makeEntry('x', { dependencies: { c: '*' } }))
    await host.load(makeEntry('r', { dependencies: { a: '*', b: '*' } }))
    await host.load(makeEntry('a'))
    await host.settle()
    assert.equal(host.view('r')?.state, 'paused', 'r 应停在 paused 等 b')

    await host.load(makeEntry('b'))
    await host.settle()
    assert.equal(host.queueDepth, 0, 'settle() 必须等到包括二级级联在内的队列排空')
    assert.equal(host.view('x')?.state, 'active', 'x 应已拿到 r 接管后的 c 并恢复 active')
    assert.equal(host.registry.providerInfo('c')?.owner, 'r')
  } finally {
    await host.dispose()
  }
})

test('reportExternalFailure：外部资源死亡后把记录标成 failed 并回收宿主侧副作用', async () => {
  const port = new FakeHostPort()
  let effects: PluginContext['effects'] | undefined
  port.define('external', (): CordisPlugin => ({
    activate(ctx) {
      effects = ctx.effects
      registerCommandEffect(ctx, 'external.run')
    },
  }))

  const host = hostFor(port)
  try {
    await host.load(makeEntry('external', { permissions: WITH_COMMAND }))
    assert.equal(host.view('external')?.state, 'active', '哨兵：先确实 active')
    assert.deepEqual(port.liveCommands(), ['external.run'])

    await host.reportExternalFailure('external', '子进程异常退出')
    assert.equal(host.view('external')?.state, 'failed', '外部失败必须可见')
    assert.match(host.view('external')?.error ?? '', /子进程异常退出/)
    assert.deepEqual(port.liveCommands(), [], '状态转 failed 时必须回收宿主侧命令')
    assert.equal(effects?.closed, true, '副作用栈必须已回收')
  } finally {
    await host.dispose()
  }
})
