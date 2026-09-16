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

  assert.deepEqual(registry.affectedBy('A').sort(), ['B', 'C'])
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
