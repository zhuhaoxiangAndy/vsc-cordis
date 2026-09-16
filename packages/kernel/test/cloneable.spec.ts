import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { formatCloneProblem, inspectCloneable } from '../src/cloneable.ts'

/** 生成 levels 层 `{ next: ... }` 的嵌套结构。 */
function nest(levels: number, leaf: unknown): unknown {
  let value = leaf
  for (let i = 0; i < levels; i += 1) value = { next: value }
  return value
}

test('允许清单：原始值与可克隆内建对象', () => {
  const allowed: unknown[] = [
    null,
    undefined,
    'text',
    42,
    -0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
    10n,
    new Date(0),
    /pattern/gi,
    new ArrayBuffer(4),
    new Uint8Array([1, 2, 3]),
    new BigInt64Array([1n]),
    new DataView(new ArrayBuffer(4)),
    new Error('boom'),
    new TypeError('bad'),
    [],
    [1, 'two', null, undefined],
    {},
    { a: 1, b: 'two', c: true, d: 3n },
    Object.create(null),
    Object.assign(Object.create(null), { nested: [1, { deep: new Date(0) }] }),
  ]

  allowed.forEach((value, index) => {
    assert.equal(inspectCloneable(value), undefined, `第 ${index} 项应被视为可克隆`)
  })
})

test('允许清单：嵌套组合、重复对象与循环引用', () => {
  const shared = { value: 1 }
  const graph: Record<string, unknown> = {
    shared,
    again: shared, // 同一对象重复出现，不再深入
    map: new Map<unknown, unknown>([['k', [new Set([new Date(0), /x/])]]]),
    set: new Set<unknown>([1, 'two', { three: 3 }]),
    typed: new Float64Array([1.5]),
  }
  graph.self = graph // 循环引用允许
  assert.equal(inspectCloneable(graph), undefined)

  const mapCycle = new Map<string, unknown>()
  mapCycle.set('self', mapCycle) // Map 自引用
  assert.equal(inspectCloneable(mapCycle), undefined)

  const setCycle = new Set<unknown>()
  setCycle.add(setCycle) // Set 自引用
  assert.equal(inspectCloneable(setCycle), undefined)
})

test('嵌套函数被定位到正确路径（哨兵：检查器确实在遍历）', () => {
  const withCallback = inspectCloneable({ list: [1, { cb: () => {} }], other: () => {} })
  assert.equal(withCallback?.path, '.list[1].cb')

  const onlyOther = inspectCloneable({ list: [1, 2], other: () => {} })
  assert.equal(onlyOther?.path, '.other')

  assert.notEqual(withCallback?.path, onlyOther?.path)
  // 对照组：同构但不含函数时必须放行，避免"永远返回问题"的假阳性检查器
  assert.equal(inspectCloneable({ list: [1, 2], other: 3 }), undefined)
})

test('路径格式：数组/对象/怪异键/Map/Set/嵌套组合', () => {
  assert.equal(inspectCloneable([() => {}])?.path, '[0]')
  assert.equal(inspectCloneable({ foo: () => {} })?.path, '.foo')
  assert.equal(inspectCloneable({ 'weird key': () => {} })?.path, '["weird key"]')
  assert.equal(inspectCloneable({ 'a.b': () => {} })?.path, '["a.b"]')
  assert.equal(inspectCloneable(new Map([['k', () => {}]]))?.path, 'map.get("k")')
  assert.equal(inspectCloneable(new Set([0, () => {}]))?.path, 'set[1]')
  assert.equal(inspectCloneable([[() => {}]])?.path, '[0][0]')
  assert.equal(
    inspectCloneable({ cfg: new Map([['k', { deep: () => {} }]]) })?.path,
    '.cfg.map.get("k").deep',
  )
  assert.equal(inspectCloneable({ s: new Set([1, () => {}]) })?.path, '.s.set[1]')
})

test('拒绝：函数、Symbol、Promise、WeakMap、WeakSet', () => {
  const cases: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['纯函数', () => {}, /函数/],
    ['Symbol', Symbol('token'), /Symbol/],
    ['Symbol 包装对象', Object(Symbol('token')), /Symbol/],
    ['Promise', Promise.resolve(1), /Promise/],
    ['WeakMap', new WeakMap(), /WeakMap/],
    ['WeakSet', new WeakSet(), /WeakSet/],
  ]

  for (const [name, value, reasonPattern] of cases) {
    const problem = inspectCloneable(value)
    assert.notEqual(problem, undefined, `${name} 应被拒绝`)
    assert.equal(problem?.path, '$', `${name} 的根路径应为 $`)
    assert.match(problem!.reason, reasonPattern, `${name} 的理由应可读`)
  }
})

test('拒绝类实例：structured clone 会丢原型与方法（静默失真）', () => {
  class Clock {
    readonly label = 'clock'

    now(): number {
      return 0
    }
  }

  const root = inspectCloneable(new Clock())
  assert.notEqual(root, undefined)
  assert.equal(root?.path, '$')
  assert.match(root!.reason, /原型|静默失真/)

  const nested = inspectCloneable({ deps: { clock: new Clock() } })
  assert.equal(nested?.path, '.deps.clock')
  assert.match(nested!.reason, /原型|静默失真/)
})

test('数组的额外可枚举属性同样检查（structured clone 会复制它们）', () => {
  const array: unknown[] = [1]
  ;(array as { cb?: unknown }).cb = () => {}
  const problem = inspectCloneable(array)
  assert.equal(problem?.path, '.cb')
  assert.match(problem!.reason, /函数/)

  const okay: unknown[] = [1]
  ;(okay as { note?: unknown }).note = 'kept'
  assert.equal(inspectCloneable(okay), undefined)
})

test('Error 只看 name/message/stack，与 structured clone 一致', () => {
  assert.equal(inspectCloneable(new Error('boom')), undefined)
  assert.equal(inspectCloneable(new RangeError('bad')), undefined)

  const weird = new Error('boom')
  Object.defineProperty(weird, 'stack', { value: () => {}, configurable: true })
  const problem = inspectCloneable(weird)
  assert.equal(problem?.path, '.stack')
  assert.match(problem!.reason, /函数/)
})

test('深度上限：超限返回"嵌套过深"而不是栈溢出', () => {
  assert.equal(inspectCloneable(nest(64, 1)), undefined, '64 条边以内应放行')
  assert.equal(inspectCloneable(nest(32, { leaf: new Date(0) })), undefined)

  const boundary = inspectCloneable(nest(65, 1))
  assert.notEqual(boundary, undefined, '超过 64 条边应停止校验')
  assert.match(boundary!.reason, /嵌套过深/)

  const tooDeep = inspectCloneable(nest(200, 1))
  assert.notEqual(tooDeep, undefined)
  assert.match(tooDeep!.reason, /嵌套过深/)
  assert.match(tooDeep!.reason, /64/)

  // 循环引用不受深度上限误伤
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  assert.equal(inspectCloneable(nest(30, cycle)), undefined)
})

test('跨 realm 的 Date/RegExp/Map/Set/TypedArray 仍放行（不依赖 instanceof）', () => {
  const foreign = [
    runInNewContext('new Date(0)'),
    runInNewContext('/x/gi'),
    runInNewContext('new Map([["k", 1]])'),
    runInNewContext('new Set([1, 2])'),
    runInNewContext('new Uint8Array([1, 2])'),
  ]

  for (const value of foreign) {
    assert.equal(inspectCloneable(value), undefined)
  }
})

test('formatCloneProblem 统一文案模板', () => {
  const formatted = formatCloneProblem('参数 "options"', {
    path: '.cb',
    reason: '是函数，structured clone 无法复制',
  })
  assert.equal(
    formatted,
    '参数 "options" 不可 structured clone：.cb 是函数，structured clone 无法复制。' +
      '请改成纯数据（Date/Map/Set/数组/普通对象/原始值）；函数留在本进程，不要跨进程传。',
  )
})
