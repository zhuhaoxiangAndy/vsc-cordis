import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CordisPlugin, PluginContext } from '@vscordis/sdk'
import { PluginAlreadyLoadedError } from '../src/errors.ts'
import { PluginHost } from '../src/plugin-host.ts'
import { FakeHostPort, makeEntry } from './support.ts'

/**
 * 竞态测试。
 *
 * 这套设计的核心承诺之一是「所有生命周期操作共用一条串行队列，所以顺序是可预期的」。
 * 承诺要么被测试守住，要么就是空话 —— 下面每一条都在试图让队列**交错**，
 * 然后断言终态与事件顺序，而不是只看"没抛错"。
 */

const WITH_COMMAND = ['vscode:commands.register']
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function hostFor(port: FakeHostPort): PluginHost {
  return new PluginHost({ port, disposeTimeoutMs: 300, activationTimeoutMs: 2_000 })
}

function registerCommandEffect(ctx: PluginContext, id: string): void {
  ctx.effect(
    () => ctx.vscode.commands.registerCommand(id, () => id),
    (disposable) => disposable.dispose(),
    `command:${id}`,
  )
}

/**
 * 模拟"宿主执行命令"：直接取已注册的 handler 调用。
 * 刻意绕开 fake 的权限层 —— 这些测试关心的是竞态，不是鉴权。
 */
async function invoke(port: FakeHostPort, command: string, ...args: unknown[]): Promise<unknown> {
  const record = port.commands.get(command)
  if (record === undefined) throw new Error(`command not found: ${command}`)
  return await record.handler(...args)
}

test('竞态：卸载与重新加载并发发起 → 串行执行，终态一致（不是 0 条也不是 2 条命令）', async () => {
  const port = new FakeHostPort()
  port.define('x', (): CordisPlugin => ({
    activate(ctx) {
      registerCommandEffect(ctx, 'x.run')
    },
  }))
  const host = hostFor(port)
  const entry = makeEntry('x', { permissions: WITH_COMMAND })

  await host.load(entry)
  await host.settle()
  assert.equal(port.commands.size, 1)

  await Promise.all([host.unload('x'), host.load(entry)])
  await host.settle()

  assert.equal(host.view('x')?.state, 'active')
  assert.deepEqual(port.liveCommands(), ['x.run'])
  assert.equal(port.commands.size, 1, '并发的 unload+load 之后应当恰好剩 1 条命令')
  assert.equal(port.moduleReleases.length, 1, '第一次加载的模块应当被释放且只释放一次')
})

test('竞态：慢速 teardown 期间发起的 load 必须等卸载彻底完成后才执行', async () => {
  const port = new FakeHostPort()
  const order: string[] = []
  let incarnation = 0

  port.define('slow', (): CordisPlugin => {
    incarnation += 1
    const mine = incarnation
    return {
      activate(ctx) {
        order.push(`activate-${mine}`)
        ctx.effect(
          () => mine,
          async () => {
            await sleep(60)
            order.push(`teardown-${mine}`)
          },
          'slow-teardown',
        )
      },
    }
  })

  const host = hostFor(port)
  const entry = makeEntry('slow')
  await host.load(entry)

  // 故意不 await：让 unload 与 load 同时进入队列
  const unloading = host.unload('slow')
  const loading = host.load(entry)
  await Promise.all([unloading, loading])
  await host.settle()

  assert.deepEqual(
    order,
    ['activate-1', 'teardown-1', 'activate-2'],
    '第二个 incarnation 的 activate 绝不能早于第一个的 teardown —— 否则就是"没卸载干净就加载"',
  )
  assert.equal(host.view('slow')?.state, 'active')
  await host.dispose()
})

test('竞态：提供者卸载与消费者加载并发 → 消费者终态必须是 paused，而不是"active 却拿着死服务"', async () => {
  const port = new FakeHostPort()
  port.define('p', (): CordisPlugin => ({
    activate(ctx) {
      ctx.provide('clock', { from: 'p' }, { version: '1.0.0' })
    },
  }))
  port.define('c', (): CordisPlugin => ({
    activate(ctx) {
      ctx.use('clock')
    },
  }))

  const host = hostFor(port)
  await host.load(makeEntry('p'))
  await host.settle()

  await Promise.all([
    host.unload('p'),
    host.load(makeEntry('c', { dependencies: { clock: '^1.0.0' } })),
  ])
  await host.settle()

  assert.equal(host.view('p'), undefined)
  assert.equal(
    host.view('c')?.state,
    'paused',
    '提供者已经走了，消费者不该处于 active —— 那意味着它持有的是一个已经消失的服务的引用',
  )
  assert.deepEqual(host.view('c')?.missing, ['clock'])
  await host.dispose()
})

test('竞态：重复 unload 幂等（模块只释放一次）', async () => {
  const port = new FakeHostPort()
  port.define('x', (): CordisPlugin => ({ activate() {} }))
  const host = hostFor(port)
  const entry = makeEntry('x')

  await host.load(entry)
  await Promise.all([host.unload('x'), host.unload('x'), host.unload('x')])
  await host.settle()

  assert.deepEqual(host.list(), [])
  assert.deepEqual(port.moduleReleases, ['x'])
  await host.dispose()
})

test('竞态：命令在途时卸载 → 卸载照常完成，且之后该命令不可再执行', async () => {
  const port = new FakeHostPort()
  let inFlightResolved = false

  port.define('slow-cmd', (): CordisPlugin => ({
    activate(ctx) {
      ctx.effect(
        () => ctx.vscode.commands.registerCommand('slow.run', async () => {
          await sleep(50)
          inFlightResolved = true
          return 'done'
        }),
        (disposable) => disposable.dispose(),
        'cmd:slow',
      )
    },
  }))

  const host = hostFor(port)
  await host.load(makeEntry('slow-cmd', { permissions: WITH_COMMAND }))

  // 启动一次调用但**不等它**，然后立刻卸载
  const inFlight = invoke(port, 'slow.run')
  await host.unload('slow-cmd')
  await host.settle()

  // 卸载必须已经完成 —— 不能被在途调用拖住
  assert.deepEqual(host.list(), [])
  assert.equal(port.commands.size, 0, '卸载后命令必须立刻从注册表消失')
  await assert.rejects(invoke(port, 'slow.run'), /command not found/)

  // 在途的那次调用仍会跑完（我们没有强制中断同进程里的 Promise）——
  // 这是个**已知边界**：宿主侧状态已经清干净，插件侧那个 Promise 只能靠 ctx.signal 自觉。
  assert.equal(await inFlight, 'done')
  assert.equal(inFlightResolved, true)
  await host.dispose()
})

test('竞态：dispose 与 load 并发 → load 被拒绝，dispose 正常完成', async () => {
  const port = new FakeHostPort()
  port.define('late', (): CordisPlugin => ({ activate() {} }))
  const host = hostFor(port)

  await host.dispose()
  await assert.rejects(host.load(makeEntry('late')), /已 dispose/)
})

test('竞态：已 dispose 的宿主上再 unload 不抛错（幂等清理路径）', async () => {
  const port = new FakeHostPort()
  port.define('x', (): CordisPlugin => ({ activate() {} }))
  const host = hostFor(port)
  await host.load(makeEntry('x'))
  await host.dispose()

  // dispose 已经把一切卸干净；再 unload 是空操作而不是错误
  await host.unload('x')
  await host.settle()
  assert.deepEqual(host.list(), [])
})

test('竞态：重复 load 已激活插件 → 明确拒绝（PluginAlreadyLoadedError）', async () => {
  const port = new FakeHostPort()
  port.define('dup', (): CordisPlugin => ({ activate() {} }))
  const host = hostFor(port)
  const entry = makeEntry('dup')

  await host.load(entry)
  await assert.rejects(host.load(entry), PluginAlreadyLoadedError)
  assert.equal(port.moduleReleases.length, 0, '被拒绝的重复加载不得释放已在运行的模块')
  await host.dispose()
})

test('竞态：settle 在队列持续有新任务时仍然会返回（不会自旋）', async () => {
  const port = new FakeHostPort()
  port.define('p', (): CordisPlugin => ({
    activate(ctx) {
      ctx.provide('clock', 1, { version: '1.0.0' })
    },
  }))
  port.define('c', (): CordisPlugin => ({
    activate(ctx) {
      ctx.use('clock')
    },
  }))

  const host = hostFor(port)
  // 制造一串会互相触发的任务：卸载提供者会级联暂停消费者，再加载提供者又会让它恢复
  const entryP = makeEntry('p')
  await host.load(entryP)
  await host.load(makeEntry('c', { dependencies: { clock: '^1.0.0' } }))
  await host.settle()

  for (let round = 0; round < 5; round += 1) {
    await host.unload('p')
    await host.load(entryP)
    await host.settle()
    assert.equal(host.view('c')?.state, 'active', `第 ${round} 轮级联恢复后消费者应当 active`)
  }
  await host.dispose()
})
