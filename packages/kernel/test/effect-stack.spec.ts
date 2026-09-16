import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EffectStack } from '../src/effect-stack.ts'

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('I2：严格 LIFO 逆序回收', async () => {
  const order: string[] = []
  const stack = new EffectStack()
  stack.add(() => void order.push('a'), 'a')
  stack.add(() => void order.push('b'), 'b')
  stack.add(() => void order.push('c'), 'c')

  await stack.dispose()

  assert.deepEqual(order, ['c', 'b', 'a'])
  assert.equal(stack.size, 0)
  assert.equal(stack.closed, true)
})

test('I2：异步 teardown 串行执行（不是并发）', async () => {
  const events: string[] = []
  const stack = new EffectStack()
  stack.add(async () => {
    events.push('start-a')
    await tick(10)
    events.push('end-a')
  }, 'a')
  stack.add(async () => {
    events.push('start-b')
    await tick(1)
    events.push('end-b')
  }, 'b')

  await stack.dispose()

  // b 在 a 之前启动，且 a 完全结束前 b 不会开始（若并发则是 start-a, start-b, end-b, end-a）
  assert.deepEqual(events, ['start-b', 'end-b', 'start-a', 'end-a'])
})

test('I3：单个 teardown 抛错不阻断其余回收', async () => {
  const failures: (string | undefined)[] = []
  const order: string[] = []
  const stack = new EffectStack({ onError: (error, label) => void failures.push(label) })

  stack.add(() => void order.push('a'), 'a')
  stack.add(() => {
    throw new Error('boom')
  }, 'bad')
  stack.add(() => void order.push('c'), 'c')

  await stack.dispose()

  assert.deepEqual(order, ['c', 'a'])
  assert.deepEqual(failures, ['bad'])
  assert.equal(stack.size, 0)
})

test('I3：teardown 超时被记为失败但不阻断回收', async () => {
  const failures: unknown[] = []
  const stack = new EffectStack({ disposeTimeoutMs: 20, onError: (error) => void failures.push(error) })
  stack.add(() => new Promise<void>(() => {  /* 永不 resolve */ }), 'hang')
  stack.add(() => undefined, 'after')

  await stack.dispose()

  assert.equal(failures.length, 1)
  assert.match(String(failures[0]), /超时/)
  assert.equal(stack.size, 0)
})

test('I4：闭栈后登记的副作用立即被回收（卸载/注册竞态不逃逸）', async () => {
  const stack = new EffectStack()
  await stack.dispose()

  let cleaned = false
  const handle = stack.add(() => void (cleaned = true), 'late')
  await tick()

  assert.equal(cleaned, true)
  assert.equal(stack.size, 0)
  // 返回值是空操作，不会抛错
  assert.doesNotThrow(() => handle.dispose())
})

test('I4：effectAsync 在卸载期间完成建资源时同样被回收', async () => {
  const stack = new EffectStack()
  let released = false

  const pending = stack.effectAsync(
    async () => {
      await tick(10)
      return { id: 'resource' }
    },
    () => void (released = true),
    'async-resource',
  )

  await stack.dispose() // 此时资源尚未创建
  assert.equal(released, false)

  await pending // 资源创建完成 → I4 立即回收
  assert.equal(released, true)
  assert.equal(stack.size, 0)
})

test('effect()：建资源并登记逆操作，register 抛错时不留下半成品', () => {
  const stack = new EffectStack()
  const disposed: string[] = []

  const resource = stack.effect(
    () => 'r1',
    (value) => void disposed.push(value),
    'r1',
  )
  assert.equal(resource, 'r1')
  assert.equal(stack.size, 1)

  assert.throws(() =>
    stack.effect<string>(
      () => {
        throw new Error('register failed')
      },
      (value) => void disposed.push(value),
      'r2',
    ),
  )
  // register 抛错 → 没有登记任何东西
  assert.equal(stack.size, 1)
})

test('scope()：子栈先于父栈回收', async () => {
  const order: string[] = []
  const parent = new EffectStack()
  parent.add(() => void order.push('parent'), 'parent-effect')
  const child = parent.scope('child')
  child.add(() => void order.push('child'), 'child-effect')

  await parent.dispose()

  assert.deepEqual(order, ['child', 'parent'])
  assert.equal(parent.size, 0)
  assert.equal(child.closed, true)
})

test('handle.dispose()：提前撤销会立刻执行逆操作，且幂等', async () => {
  const stack = new EffectStack()
  let calls = 0
  const handle = stack.add(() => void (calls += 1), 'temp')
  assert.equal(stack.size, 1)

  handle.dispose() // 立刻撤销：逆操作必须真的跑掉，而不是"从队列里摘掉"
  assert.equal(calls, 1)
  assert.equal(stack.size, 0)

  handle.dispose() // 幂等
  await stack.dispose() // 再整体回收时不得重复执行
  assert.equal(calls, 1)
})

test('嵌套登记：外层 effect 撤销内层资源时，内层逆操作真的会跑', async () => {
  const stack = new EffectStack()
  let innerCleaned = false

  // 复现桥接层的真实写法：register 内部自己 add 了一项，外层 effect 再包一层。
  stack.effect(
    () => stack.add(() => void (innerCleaned = true), 'inner'),
    (handle) => handle.dispose(),
    'outer',
  )

  await stack.dispose()

  assert.equal(innerCleaned, true)
  assert.equal(stack.size, 0)
})

test('dispose() 幂等，且 settled 在回收开始后即为 true', async () => {
  const stack = new EffectStack()
  let count = 0
  stack.add(() => void count++)

  assert.equal(stack.settled, false)
  await stack.dispose()
  await stack.dispose()

  assert.equal(count, 1)
  assert.equal(stack.settled, true)
})
