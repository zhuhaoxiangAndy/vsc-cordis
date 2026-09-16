import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AsyncService, CordisPlugin } from '@vscordis/sdk'
import { PluginHost } from '../src/plugin-host.ts'
import { RemoteServiceError } from '../src/errors.ts'
import { FakeHostPort, makeEntry } from './support.ts'

/**
 * 跨进程服务（ADR-0019）在内核层面的行为。
 *
 * 隔离模式那一半（真实子进程 + 真实 IPC）在 `packages/host/test/isolation.spec.ts`；
 * 这里测的是**与模式无关**的注册表语义：远程标记、拒绝同步解析、以及
 * "依赖边随 EffectStack 回收后，恢复判定仍然正确"这条容易出错的路径。
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function hostFor(port: FakeHostPort): PluginHost {
  return new PluginHost({ port, disposeTimeoutMs: 200, activationTimeoutMs: 2_000 })
}

/**
 * 模拟**隔离加载器**注册远程服务的方式。
 *
 * 两个关键点必须与生产一致，否则测试会得出假结论：
 * 1. `remote: true` 由**运行时**写入（隔离 loader 在宿主侧注册远程代理）；
 *    插件自己 `ctx.provide(..., { remote: true })` 现在会被明确拒绝（见 plugin-host.spec.ts）。
 * 2. 注册句柄挂在提供者插件的 EffectStack 上 → 提供者卸载时撤销服务 → 级联暂停消费者。
 */
function defineRemoteProvider(
  port: FakeHostPort,
  host: PluginHost,
  pluginId: string,
  service: { readonly name: string; readonly instance: unknown; readonly version: string },
): void {
  port.define(pluginId, (): CordisPlugin => ({
    activate(ctx) {
      ctx.effect(
        () =>
          host.registry.provide(pluginId, service.name, service.instance, {
            version: service.version,
            remote: true,
          }),
        (handle) => handle.dispose(),
        `remote-provide:${service.name}`,
      )
    },
  }))
}

test('远程服务：ctx.use 被拒绝并指向 ctx.async.useService', async () => {
  const port = new FakeHostPort()
  const host = hostFor(port)
  defineRemoteProvider(port, host, 'remote-provider', {
    name: 'clock',
    instance: { now: async () => 'tick' },
    version: '1.0.0',
  })
  port.define('sync-consumer', (): CordisPlugin => ({
    activate(ctx) {
      ctx.use('clock')
    },
  }))

  await host.load(makeEntry('remote-provider'))
  await host.settle()

  await assert.rejects(
    host.load(makeEntry('sync-consumer', { dependencies: { clock: '^1.0.0' } })),
    (error: unknown) => {
      assert.ok(error instanceof RemoteServiceError)
      assert.match(String(error), /ctx\.async\.useService/)
      return true
    },
  )
  assert.equal(host.view('sync-consumer')?.state, 'failed')
  await host.dispose()
})

test('远程服务：ctx.async.useService 可取用，且是硬依赖（提供者走了会被暂停）', async () => {
  const port = new FakeHostPort()
  const host = hostFor(port)
  defineRemoteProvider(port, host, 'remote-provider', {
    name: 'clock',
    instance: { now: async () => 'tick' },
    version: '1.0.0',
  })
  port.define('async-consumer', (): CordisPlugin => ({
    async activate(ctx) {
      const clock = await ctx.async.useService<{ now(): Promise<string> }>('clock')
      const value = await clock.now()
      ctx.effect(
        () => ctx.vscode.commands.registerCommand('c.now', () => value),
        (disposable) => disposable.dispose(),
        'cmd',
      )
    },
  }))

  const provider = makeEntry('remote-provider')
  await host.load(provider)
  await host.load(makeEntry('async-consumer', { permissions: ['vscode:commands.register'] }))
  await host.settle()

  assert.equal(host.view('async-consumer')?.state, 'active')
  assert.equal(port.commands.get('c.now')?.handler(), 'tick')

  // 提供者离开 → 消费者被级联暂停（依赖边登记在注册表上）
  await host.unload('remote-provider')
  await host.settle()
  assert.equal(host.view('async-consumer')?.state, 'paused')

  // 提供者回来 → 自动恢复
  await host.load(provider)
  await host.settle()
  assert.equal(host.view('async-consumer')?.state, 'active')
  await host.dispose()
})

test('回归：未在 plugin.json 里声明、但运行期用过的依赖，恢复判定必须仍然正确', async () => {
  const port = new FakeHostPort()
  const host = hostFor(port)

  /**
   * 这是被隔离测试逼出来的真实缺陷：
   * 依赖边随 EffectStack 回收而消失，而 `#missingDependencies` 若只看清单声明，
   * 一个"用了服务却没声明"的插件会被误判成"没有缺失依赖"，
   * 于是在提供者仍然缺席时被尝试恢复 → 直接变成 `failed`（本该停在 `paused`）。
   */
  defineRemoteProvider(port, host, 'provider', {
    name: 'clock',
    instance: { now: async () => 'tick' },
    version: '1.0.0',
  })
  port.define('undeclared-consumer', (): CordisPlugin => ({
    async activate(ctx) {
      // 注意：这个插件的 plugin.json 里 **没有** clock 依赖
      await ctx.async.useService<AsyncService<{ now(): Promise<string> }>>('clock')
    },
  }))

  const provider = makeEntry('provider')
  const consumer = makeEntry('undeclared-consumer') // 故意不带 dependencies

  await host.load(provider)
  await host.load(consumer)
  await host.settle()
  assert.equal(host.view('undeclared-consumer')?.state, 'active')

  await host.unload('provider')
  await host.settle()

  assert.equal(
    host.view('undeclared-consumer')?.state,
    'paused',
    '未声明的动态依赖也必须让插件停在 paused，而不是变 failed',
  )
  assert.deepEqual(host.view('undeclared-consumer')?.missing, ['clock'])

  // 提供者回来之后仍能自动恢复
  await host.load(provider)
  await host.settle()
  assert.equal(host.view('undeclared-consumer')?.state, 'active')
  await host.dispose()
})

test('远程服务：异步代理只暴露方法表里的方法', async () => {
  const port = new FakeHostPort()
  const host = hostFor(port)
  defineRemoteProvider(port, host, 'p', {
    name: 'clock',
    // 宿主侧注册的远程实例：`now` 是方法，`label` 是数据字段
    instance: { label: 'x', now: async () => 'tick' },
    version: '1.0.0',
  })

  await host.load(makeEntry('p'))
  await host.settle()

  // 同步入口被拒绝；异步入口拿到的是方法全异步的代理
  assert.throws(() => host.registry.resolve('clock'), RemoteServiceError)
  const proxy = host.registry.resolveForAsync<{ now(): Promise<string>; label: string }>('clock')
  assert.equal(await proxy.now(), 'tick')

  await host.dispose()
})

test('用注册表快照能看出"服务在隔离进程里"（供状态面板与 CLI 显示）', async () => {
  const port = new FakeHostPort()
  const host = hostFor(port)
  defineRemoteProvider(port, host, 'p', {
    name: 'remote-thing',
    instance: { go: async () => 1 },
    version: '2.0.0',
  })

  await host.load(makeEntry('p'))
  await host.settle()

  const service = host.registry.snapshot().services.find((entry) => entry.name === 'remote-thing')
  assert.equal(service?.provider?.remote, true)
  assert.equal(service?.provider?.owner, 'p')
  await host.dispose()
  await sleep(0)
})
