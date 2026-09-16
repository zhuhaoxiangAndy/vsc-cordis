import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CordisPlugin } from '@vscordis/sdk'
import { PluginHost } from '../src/plugin-host.ts'
import { FakeHostPort, makeEntry } from './support.ts'

/**
 * 活性缺陷回归（把"卡死宿主"变成一个**确定性的、秒级失败**的测试）。
 *
 * 背景：所有生命周期操作共用一条串行队列。如果 `activate()` 永不 resolve，
 * 队列就永久卡住 —— 连"卸载这个插件"这个操作本身都排在它后面。
 * 那不是"这个插件坏了"，而是**整个宿主失去响应**。
 *
 * 这个测试必须在 1 秒内失败，而不是跑到测试框架超时。所以给 host 一个很短的
 * activationTimeoutMs，并断言：load 抛错、插件进入 failed、队列**仍然可用**。
 */
test('activate 永不 resolve：超时后插件进入 failed，且队列仍可继续服务（宿主不卡死）', async () => {
  const port = new FakeHostPort()
  let abortObserved = false

  port.define('hangs', (): CordisPlugin => ({
    activate(ctx) {
      // 模拟"卡住但可以被信号叫停"的插件：永久 pending，除非收到卸载信号。
      return new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          abortObserved = true
          resolve()
        })
      })
    },
  }))
  port.define('healthy', (): CordisPlugin => ({ activate() {} }))

  const host = new PluginHost({ port, activationTimeoutMs: 60, disposeTimeoutMs: 100 })

  await assert.rejects(host.load(makeEntry('hangs')), (error: unknown) => {
    assert.match(String(error), /activate\(\) 超时/)
    return true
  })

  assert.equal(host.view('hangs')?.state, 'failed')
  assert.equal(abortObserved, true, '超时后必须发 AbortSignal，让插件侧的异步工作有机会停下')

  // 关键断言：队列没有被卡住 —— 后续操作必须照常完成
  await host.load(makeEntry('healthy'))
  await host.settle()
  assert.equal(host.view('healthy')?.state, 'active')

  await host.unload('hangs')
  await host.unload('healthy')
  await host.settle()
  assert.deepEqual(host.list(), [])
  assert.deepEqual(host.registry.providedServices(), [])
})

test('activate 慢但没超时：正常激活（超时不是用来催快的）', async () => {
  const port = new FakeHostPort()
  port.define('slow', (): CordisPlugin => ({
    async activate() {
      await new Promise((resolve) => setTimeout(resolve, 30))
    },
  }))

  const host = new PluginHost({ port, activationTimeoutMs: 2_000, disposeTimeoutMs: 100 })
  await host.load(makeEntry('slow'))
  await host.settle()
  assert.equal(host.view('slow')?.state, 'active')
  await host.dispose()
})

test('activate 抛错时同样发出 AbortSignal（回滚要连插件侧的异步任务一起收）', async () => {
  const port = new FakeHostPort()
  let aborted = false
  port.define('explodes', (): CordisPlugin => ({
    activate(ctx) {
      ctx.signal.addEventListener('abort', () => {
        aborted = true
      })
      throw new Error('activate 故意失败')
    },
  }))

  const host = new PluginHost({ port, activationTimeoutMs: 2_000, disposeTimeoutMs: 100 })
  await assert.rejects(host.load(makeEntry('explodes')), /故意失败/)
  assert.equal(aborted, true)
  assert.equal(host.view('explodes')?.state, 'failed')
  await host.dispose()
})

test('queueDepth：慢 activate 在途中 >=1、再排队 >=2、settle 后归零（诊断"宿主卡住"）', async () => {
  const port = new FakeHostPort()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = false

  port.define('gated', (): CordisPlugin => ({
    activate() {
      started = true
      return gate
    },
  }))
  port.define('next', (): CordisPlugin => ({ activate() {} }))

  const host = new PluginHost({ port, activationTimeoutMs: 2_000, disposeTimeoutMs: 100 })
  assert.equal(host.queueDepth, 0, '空闲时必须是 0')

  const first = host.load(makeEntry('gated'))
  // 让队列真正开始执行第一个任务（入队是同步的，任务本身在微任务里才开始）
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(started, true, '第一个任务应当已经开始执行')
  assert.ok(host.queueDepth >= 1, `执行中深度应 >=1，实际 ${host.queueDepth}`)

  const second = host.load(makeEntry('next'))
  assert.ok(host.queueDepth >= 2, `再排一个任务后深度应 >=2，实际 ${host.queueDepth}`)

  release()
  await first
  await second
  await host.settle()
  assert.equal(host.queueDepth, 0, '队列排空后必须归零 —— 否则状态面板会一直报"卡住"')
  assert.equal(host.view('gated')?.state, 'active')
  assert.equal(host.view('next')?.state, 'active')
  await host.dispose()
})
