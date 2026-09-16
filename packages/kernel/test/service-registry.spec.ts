import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ServiceConflictError, ServiceUnavailableError, ServiceVersionMismatchError } from '../src/errors.ts'
import { ServiceRegistry, type ServiceChangeEvent } from '../src/service-registry.ts'

test('provide / resolve / tryResolve 基本语义', () => {
  const registry = new ServiceRegistry()
  const handle = registry.provide('p', 'clock', { now: () => 42 }, { version: '1.2.3' })

  assert.deepEqual(registry.resolve<{ now(): number }>('clock').now(), 42)
  assert.equal(registry.tryResolve('missing'), undefined)
  assert.equal(registry.canResolve('clock', '^1.0.0'), true)
  assert.equal(registry.canResolve('clock', '^2.0.0'), false)
  assert.deepEqual(registry.providedServices(), ['clock'])

  handle.dispose()
  assert.equal(registry.canResolve('clock'), false)
  assert.throws(() => registry.resolve('clock'), ServiceUnavailableError)
})

test('严格解析在版本不满足时抛 ServiceVersionMismatchError', () => {
  const registry = new ServiceRegistry()
  registry.provide('p', 'clock', 1, { version: '1.0.0' })

  assert.throws(() => registry.resolve('clock', '>=2.0.0'), ServiceVersionMismatchError)
  assert.equal(registry.resolve('clock', '^1.0.0'), 1)
})

test('冲突策略默认 exclusive：第二个提供者直接抛错', () => {
  const registry = new ServiceRegistry()
  registry.provide('a', 'clock', 1, { version: '1.0.0' })

  assert.throws(() => registry.provide('b', 'clock', 2, { version: '1.0.0' }), ServiceConflictError)
})

test('显式 last-wins：新提供者接管，并通知消费者级联', () => {
  const registry = new ServiceRegistry()
  const events: ServiceChangeEvent[] = []
  registry.onDidChange((event) => void events.push(event))

  registry.provide('a', 'clock', 1, { version: '1.0.0' })
  registry.depend('consumer', 'clock', 'hard', '^1.0.0')
  registry.provide('b', 'clock', 2, { version: '1.0.0', conflict: 'last-wins' })

  assert.equal(registry.resolve('clock'), 2)
  const replaced = events.at(-1)
  assert.equal(replaced?.kind, 'replaced')
  assert.equal(replaced?.previous?.owner, 'a')
  assert.equal(replaced?.current?.owner, 'b')
  // 换人提供 → 消费者必须重启（否则会一直持有旧实例）
  assert.deepEqual(replaced?.affected, ['consumer'])
})

test('provide handle 绑定 generation：旧 handle 不能撤销同 owner 的新提供者', () => {
  const registry = new ServiceRegistry()
  const first = registry.provide('p', 'clock', 1, { version: '1.0.0' })
  const second = registry.provide('p', 'clock', 2, { version: '1.0.0' })
  assert.equal(registry.resolve('clock'), 2)

  first.dispose()
  assert.equal(registry.resolve('clock'), 2, '旧 handle 的 dispose 不能撤销新提供者')
  assert.equal(registry.providerInfo('clock')?.owner, 'p')

  second.dispose()
  assert.equal(registry.providerInfo('clock'), undefined)
})

test('last-wins 换人后旧 owner 的 providesOf 必须清理', () => {
  const registry = new ServiceRegistry()
  registry.provide('a', 'clock', 1, { version: '1.0.0' })
  registry.provide('b', 'clock', 2, { version: '1.0.0', conflict: 'last-wins' })

  assert.deepEqual(registry.providesOf('a'), [], '被替换者不能再声称提供 clock')
  assert.deepEqual(registry.providesOf('b'), ['clock'])
})

test('hard 依赖边不会被后来的 soft 边覆盖（range 也不被 soft 改写）', () => {
  const registry = new ServiceRegistry()
  registry.provide('prov', 'clock', 1, { version: '1.0.0' })
  registry.depend('cons', 'clock', 'hard', '^1.0.0')
  registry.depend('cons', 'clock', 'soft')

  assert.deepEqual(registry.snapshot().edges, [
    { consumer: 'cons', service: 'clock', kind: 'hard', range: '^1.0.0' },
  ])
  assert.deepEqual(registry.affectedBy('prov'), ['cons'], 'hard 边必须保留并继续参与级联')
})

test('depend 引用计数：提前 dispose 一个 edge 不能误删另一条', () => {
  const registry = new ServiceRegistry()
  registry.provide('prov', 'clock', 1, { version: '1.0.0' })
  const hard = registry.depend('cons', 'clock', 'hard', '^1.0.0')
  const soft = registry.depend('cons', 'clock', 'soft', '>=1.0.0')

  soft.dispose()
  assert.deepEqual(registry.affectedBy('prov'), ['cons'], 'soft edge 撤销后 hard edge 必须仍在')
  assert.deepEqual(registry.snapshot().edges, [
    { consumer: 'cons', service: 'clock', kind: 'hard', range: '^1.0.0' },
  ])

  hard.dispose()
  assert.deepEqual(registry.affectedBy('prov'), [], '两条 edge 都撤销后才不再级联')
  assert.deepEqual(registry.snapshot().edges, [])
  assert.deepEqual(registry.dependenciesOf('cons'), [])
})

test('depend 引用计数：hard 撤销后仍保留 soft 边，只是不再级联', () => {
  const registry = new ServiceRegistry()
  registry.provide('prov', 'clock', 1, { version: '1.0.0' })
  const hard = registry.depend('cons', 'clock', 'hard', '^1.0.0')
  const soft = registry.depend('cons', 'clock', 'soft', '>=1.0.0')

  hard.dispose()
  assert.deepEqual(registry.affectedBy('prov'), [], '只剩 soft 时不参与硬依赖级联')
  assert.deepEqual(registry.snapshot().edges, [
    { consumer: 'cons', service: 'clock', kind: 'soft', range: '>=1.0.0' },
  ])

  soft.dispose()
  assert.deepEqual(registry.snapshot().edges, [])
})

test('revoke 事件携带受影响的硬依赖消费者', () => {
  const registry = new ServiceRegistry()
  const events: ServiceChangeEvent[] = []
  registry.depend('c1', 'clock', 'hard')
  registry.depend('c2', 'clock', 'soft')
  registry.onDidChange((event) => void events.push(event))

  const handle = registry.provide('p', 'clock', 1, { version: '1.0.0' })
  handle.dispose()

  const revoked = events.find((event) => event.kind === 'revoked')
  assert.equal(revoked?.name, 'clock')
  assert.deepEqual(revoked?.affected, ['c1']) // 软依赖不级联
})

test('affectedBy：硬依赖的传递闭包（A→B→C）', () => {
  const registry = new ServiceRegistry()
  // A 提供 clock；B 消费 clock 并提供 scheduler；C 消费 scheduler
  registry.provide('A', 'clock', 'clock-instance', { version: '1.0.0' })
  registry.depend('B', 'clock', 'hard')
  registry.provide('B', 'scheduler', 'scheduler-instance', { version: '1.0.0' })
  registry.depend('C', 'scheduler', 'hard')

  assert.deepEqual([...registry.affectedBy('A')].sort(), ['B', 'C'])
  assert.deepEqual(registry.affectedBy('B'), ['C'])

  registry.provide('D', 'other', 1, { version: '1.0.0' })
  assert.deepEqual(registry.affectedBy('D'), [])
})

test('affectedBy：软依赖不参与级联', () => {
  const registry = new ServiceRegistry()
  registry.depend('soft-consumer', 'clock', 'soft')
  registry.provide('p', 'clock', 1, { version: '1.0.0' })

  assert.deepEqual(registry.affectedBy('p'), [])
})

test('depend 返回的 Disposable 解除依赖边并清理空槽位', () => {
  const registry = new ServiceRegistry()
  const edge = registry.depend('c', 'lonely', 'hard')
  assert.equal(registry.size, 1)

  edge.dispose()
  assert.equal(registry.size, 0)
  assert.deepEqual(registry.snapshot().edges, [])
})

test('snapshot 描述完整的依赖图（用于 CLI 可视化）', () => {
  const registry = new ServiceRegistry()
  registry.provide('p', 'clock', 1, { version: '2.1.0' })
  registry.depend('c', 'clock', 'hard', '^2.0.0')

  const snapshot = registry.snapshot()
  assert.deepEqual(snapshot.edges, [{ consumer: 'c', service: 'clock', kind: 'hard', range: '^2.0.0' }])
  assert.equal(snapshot.services.length, 1)
  assert.equal(snapshot.services[0]?.provider?.owner, 'p')
  assert.deepEqual(snapshot.services[0]?.consumers, [{ owner: 'c', kind: 'hard' }])
})

// ————————————————————————————————— ADR-0019：版本协商

test('tryResolve 同样强制版本范围：版本不符抛错，而不是静默当作缺失', () => {
  const registry = new ServiceRegistry()
  registry.provide('p', 'clock', 1, { version: '1.0.0' })

  // 版本不符是"存在但契约不满足"，返回 undefined 会让插件把软依赖误判成"不存在"
  assert.throws(() => registry.tryResolve('clock', '^2.0.0'), ServiceVersionMismatchError)
  assert.equal(registry.tryResolve('clock', '^1.0.0'), 1)
  assert.equal(registry.tryResolve('clock', '*'), 1)
  assert.equal(registry.tryResolve('clock'), 1)
  // 真正缺失时仍然是 undefined（这是软依赖的本意）
  assert.equal(registry.tryResolve('missing', '^1.0.0'), undefined)
})

test('assertSatisfies：只校验版本、不返回实例；未声明版本时非 * 范围 fail-closed', () => {
  const registry = new ServiceRegistry()
  registry.provide('p', 'clock', { secret: 1 }, { version: '1.0.0' })
  registry.provide('q', 'unversioned', { secret: 2 })

  assert.doesNotThrow(() => registry.assertSatisfies('clock', '^1.0.0'))
  assert.doesNotThrow(() => registry.assertSatisfies('clock', '*'))
  assert.doesNotThrow(() => registry.assertSatisfies('clock', undefined))
  assert.throws(() => registry.assertSatisfies('clock', '^2.0.0'), ServiceVersionMismatchError)
  // 说不清版本就当作不满足：否则一个忘记声明 version 的提供者会绕过所有版本约束
  assert.throws(() => registry.assertSatisfies('unversioned', '^1.0.0'), ServiceVersionMismatchError)
  assert.throws(() => registry.assertSatisfies('missing', '^1.0.0'), ServiceUnavailableError)
})

test('版本不匹配的错误信息给出替代路径（换提供者版本或放宽范围）', () => {
  const registry = new ServiceRegistry()
  registry.provide('p', 'clock', 1, { version: '1.0.0' })

  assert.throws(
    () => registry.resolve('clock', '^2.0.0'),
    (error: unknown) => {
      const text = String(error)
      assert.match(text, /升级\/降级/)
      assert.match(text, /放宽依赖方 plugin\.json#dependencies/)
      return true
    },
  )
})

test('未知冲突策略 fail-closed，而不是静默当作 exclusive', () => {
  const registry = new ServiceRegistry()

  assert.throws(
    () => registry.provide('a', 'clock', 1, { conflict: 'first-wins' as never }),
    /未知的服务冲突策略/,
  )
  // 合法的两种策略不应受影响
  assert.doesNotThrow(() => registry.provide('a', 'clock', 1, { conflict: 'exclusive' }))
  assert.doesNotThrow(() => registry.provide('b', 'clock', 2, { conflict: 'last-wins' }))
})
