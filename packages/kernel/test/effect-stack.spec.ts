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

test('I2：并发 dispose() 共享同一次回收，teardown 不交错', async () => {
  const events: string[] = []
  const stack = new EffectStack()
  stack.add(async () => {
    events.push('a:start')
    await tick(10)
    events.push('a:end')
  }, 'a')
  stack.add(async () => {
    events.push('b:start')
    await tick(1)
    events.push('b:end')
  }, 'b')

  await Promise.all([stack.dispose(), stack.dispose()])

  // 修复前两次 dispose 各起一条循环，事件会交错成 b:start, a:start, b:end, a:end
  assert.deepEqual(events, ['b:start', 'b:end', 'a:start', 'a:end'])
  assert.equal(stack.closed, true)
})

test('I2：draining 期间 add() 不得与当前 teardown 并发，而应排队回收', async () => {
  const events: string[] = []
  const stack = new EffectStack()
  stack.add(async () => {
    events.push('a:start')
    stack.add(() => void events.push('late:run'), 'late')
    await tick(5)
    events.push('a:end')
  }, 'a')

  await stack.dispose()

  // 修复前 draining 期间 add 会立即 #run，late:run 会插在 a:end 之前
  assert.deepEqual(events, ['a:start', 'a:end', 'late:run'])
  assert.equal(stack.size, 0)
})

test('I2：draining 期间 handle.dispose() 也不插队，等当前 teardown 结束后执行', async () => {
  const events: string[] = []
  const stack = new EffectStack()
  stack.add(async () => {
    events.push('a:start')
    const late = stack.add(() => void events.push('late:run'), 'late')
    late.dispose()
    await tick(5)
    events.push('a:end')
  }, 'a')

  await stack.dispose()

  assert.deepEqual(events, ['a:start', 'a:end', 'late:run'])
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
  const order: string[] = []
  const stack = new EffectStack({ disposeTimeoutMs: 20, onError: (error) => void failures.push(error) })
  // LIFO：最后登记的 hang 先执行并超时；先登记的 tail 必须仍被回收（哨兵）。
  stack.add(() => void order.push('tail'), 'tail')
  stack.add(() => {
    order.push('hang')
    return new Promise<void>(() => {
      /* 永不 resolve */
    })
  }, 'hang')

  await stack.dispose()

  assert.equal(failures.length, 1)
  assert.match(String(failures[0]), /超时/)
  assert.deepEqual(order, ['hang', 'tail'], '超时项之后的剩余项必须继续执行，不能被静默跳过')
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

test('disposeBudgetMs：预算内多个快 teardown 全部执行，skippedByBudget 为 0', async () => {
  const order: string[] = []
  const failures: unknown[] = []
  const stack = new EffectStack({ disposeBudgetMs: 1_000, onError: (error) => void failures.push(error) })
  stack.add(async () => {
    await tick(5)
    order.push('a')
  }, 'a')
  stack.add(async () => {
    await tick(5)
    order.push('b')
  }, 'b')
  stack.add(async () => {
    await tick(5)
    order.push('c')
  }, 'c')

  await stack.dispose()

  assert.deepEqual(order, ['c', 'b', 'a'])
  assert.deepEqual(failures, [])
  assert.equal(stack.skippedByBudget, 0)
  assert.equal(stack.closed, true)
  assert.equal(stack.size, 0)
})

test('disposeBudgetMs：慢 teardown 吃光预算后，剩余项不得静默丢失', async () => {
  const failures: { error: unknown; label: string | undefined }[] = []
  const executed: string[] = []
  const stack = new EffectStack({
    disposeBudgetMs: 40,
    onError: (error, label) => void failures.push({ error, label }),
  })
  stack.add(() => void executed.push('skipped-1'), 'skipped-1')
  stack.add(() => void executed.push('skipped-2'), 'skipped-2')
  // LIFO：这一项最先执行，挂起把预算吃光（单项超时被压到剩余预算）。
  stack.add(() => new Promise<void>(() => { /* 永不 resolve */ }), 'slow')

  const startedAt = Date.now()
  await stack.dispose()
  const elapsedMs = Date.now() - startedAt

  const timeoutFailures = failures.filter(({ error }) => /超时/.test(String(error)))
  const budgetFailures = failures.filter(({ error }) => /预算耗尽/.test(String(error)))
  assert.equal(timeoutFailures.length, 1)
  assert.equal(timeoutFailures[0]?.label, 'slow')

  // 预算是墙钟时间：慢项超时后若还剩 1ms，边界项会被**合法执行**而不是跳过。
  // 因此不能断言“恰好 2 项被跳过”；真正的不变式是剩余项一个都不能静默丢失。
  assert.equal(
    executed.length + budgetFailures.length,
    2,
    `剩余项必须要么执行要么逐条上报，实际 executed=${JSON.stringify(executed)} budget=${JSON.stringify(budgetFailures.map(({ label }) => label))}`,
  )
  assert.deepEqual(
    [...executed, ...budgetFailures.map(({ label }) => String(label))].sort(),
    ['skipped-1', 'skipped-2'],
    '两项都必须有明确归宿，不能有一项既没执行也没上报',
  )
  for (const { error, label } of budgetFailures) {
    assert.match(String(error), new RegExp(String(label)))
    assert.match(String(error), /预算耗尽/)
  }
  assert.equal(stack.skippedByBudget, budgetFailures.length)
  assert.equal(stack.closed, true)
  assert.equal(stack.size, 0)
  // 总时长预算的意义：若无预算，挂起项会先吃掉默认 5s 单项超时。
  assert.ok(elapsedMs < 2_000, `整栈回收应被预算压到 2s 内，实际 ${elapsedMs}ms`)
})

test('disposeBudgetMs：不传或 <= 0 时不启用，长链全部执行且不跳过', async () => {
  const cases = [{}, { disposeBudgetMs: undefined }, { disposeBudgetMs: 0 }, { disposeBudgetMs: -1 }]
  const expected = Array.from({ length: 12 }, (_, i) => `#${11 - i}`)
  for (const options of cases) {
    const executed: string[] = []
    const stack = new EffectStack({ ...options, disposeTimeoutMs: 60 })
    for (let i = 0; i < 12; i += 1) {
      stack.add(() => void executed.push(`#${i}`), `item-${i}`)
    }
    // 栈顶慢项耗掉 30ms：若预算被错误启用（例如按 <= 0 之外的判断），后续 12 项都会被跳过。
    stack.add(async () => {
      await tick(30)
    }, 'slow')

    await stack.dispose()

    assert.deepEqual(executed, expected, JSON.stringify(options))
    assert.equal(stack.skippedByBudget, 0, JSON.stringify(options))
    assert.equal(stack.closed, true)
    assert.equal(stack.size, 0)
  }
})

test('disposeBudgetMs：单项 disposeTimeoutMs 仍生效，超时记失败但不阻断', async () => {
  const executed: string[] = []
  const failures: unknown[] = []
  const stack = new EffectStack({
    disposeBudgetMs: 1_000,
    disposeTimeoutMs: 20,
    onError: (error) => void failures.push(error),
  })
  stack.add(() => void executed.push('after'), 'after')
  stack.add(() => new Promise<void>(() => { /* 永不 resolve */ }), 'hang')

  await stack.dispose()

  assert.equal(failures.length, 1)
  assert.match(String(failures[0]), /超时/)
  assert.deepEqual(executed, ['after'])
  assert.equal(stack.skippedByBudget, 0)
  assert.equal(stack.size, 0)
})

test('disposeBudgetMs：恰好只够一项时，第二项被剩余预算截断（超时而非跳过）', async () => {
  const events: string[] = []
  const failures: unknown[] = []
  const stack = new EffectStack({ disposeBudgetMs: 400, onError: (error) => void failures.push(error) })
  stack.add(() => {
    events.push('second-start')
    return new Promise<void>(() => { /* 慢 teardown：只能被剩余预算的超时截断 */ })
  }, 'second')
  stack.add(async () => {
    await tick(50)
    events.push('first-done')
  }, 'first')

  await stack.dispose()

  assert.deepEqual(events, ['first-done', 'second-start'])
  assert.equal(failures.length, 1)
  const message = String(failures[0])
  assert.match(message, /超时/)
  const budgeted = /超时（>(\d+)ms）/.exec(message)
  assert.ok(budgeted, `超时信息应带上被剩余预算截断后的毫秒数：${message}`)
  const timeoutMs = Number(budgeted[1])
  assert.ok(timeoutMs >= 1 && timeoutMs <= 400, `单项超时应落在 (0, 400] 内，实际 ${timeoutMs}ms`)
  assert.equal(stack.skippedByBudget, 0)
  assert.equal(stack.closed, true)
  assert.equal(stack.size, 0)
})
