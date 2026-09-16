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
  assert.deepEqual(host.registry.providedServices().sort(), ['clock', 'scheduler'])
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
