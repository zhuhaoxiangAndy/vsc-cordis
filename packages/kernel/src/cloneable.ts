/**
 * structured clone 前置校验（ADR-0019「未覆盖」第 1 条）。
 *
 * 宿主 ↔ 隔离子进程的 IPC 用 `serialization: 'advanced'`（structured clone）。
 * 不可克隆的值会在 IPC 层才抛 `DataCloneError`，错误里既没有参数名也没有路径；
 * 类实例更隐蔽 —— 它不报错，但原型与方法被静默丢掉。
 *
 * 本模块在调用点做一次深度优先校验，返回**第一个**问题（可读路径 + 中文理由），
 * 交给调用方套 `formatCloneProblem()` 拼成「哪个参数、哪条路径、为什么、怎么办」。
 *
 * 判定口径（刻意比 IPC 更严一点）：
 * - 允许：原始值、Date/RegExp/Map/Set/ArrayBuffer/TypedArray/DataView、
 *   Error（只看 name/message/stack）、数组、原型为 Object.prototype 或 null 的普通对象；
 * - 拒绝：函数、Symbol（含包装对象）、Promise、WeakMap/WeakSet，以及任何非普通对象
 *   原型的实例 —— 后者 structured clone 要么直接报错，要么丢掉原型与方法（静默失真），
 *   正是本项目明确拒绝的「看起来能过、实际丢东西」。
 * - 循环引用允许（structured clone 支持）：用 seen 记录已访问对象，重复出现不再深入。
 *
 * 零 Node 内建依赖、零 vscode：可直接进入浏览器构建。
 */

/** 根到当前值最多允许的嵌套边数；再深就直接返回「嵌套过深」，避免病态输入打成栈溢出。 */
const MAX_DEPTH = 64

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const ARRAY_INDEX_PATTERN = /^(0|[1-9]\d*)$/
/** 数组索引的上界（2^32 - 2）；更大的数字键属于普通属性。 */
const MAX_ARRAY_INDEX = 2 ** 32 - 2

const ERROR_FIELDS = ['name', 'message', 'stack'] as const

export interface CloneProblem {
  /** 可读路径：根值本身记作 `$`，属性/元素沿用 `.foo`、`[0]`、`["weird key"]`、`map.get("k")`、`set[2]` 等写法。 */
  readonly path: string
  /** 中文理由：说明「为什么不可克隆」。 */
  readonly reason: string
}

/**
 * 返回第一个不可克隆的问题；全部可克隆（含循环引用）时返回 `undefined`。
 *
 * 本函数保证不抛错：连 getter 抛异常、Proxy trap 抛异常这类情况也会被转换成 `CloneProblem`。
 */
export function inspectCloneable(value: unknown): CloneProblem | undefined {
  return inspect(value, '', 0, new Set<object>())
}

/**
 * 统一文案模板：`${what} 不可 structured clone：${path} ${reason}。请改成纯数据…`
 *
 * `what` 由调用点决定，例如 `参数 "options"` / `返回值 "snapshot"`。
 */
export function formatCloneProblem(what: string, problem: CloneProblem): string {
  return (
    `${what} 不可 structured clone：${problem.path} ${problem.reason}。` +
    '请改成纯数据（Date/Map/Set/数组/普通对象/原始值）；函数留在本进程，不要跨进程传。'
  )
}

// ---------------------------------------------------------------------------
// 内建品牌校验：标签用 Object.prototype.toString（跨 realm），
// 再用内置访问器/方法确认内部槽，避免 Symbol.toStringTag 伪装的普通对象被误判。
// ---------------------------------------------------------------------------

const REGEXP_SOURCE_GETTER = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')?.get
const MAP_SIZE_GETTER = Object.getOwnPropertyDescriptor(Map.prototype, 'size')?.get
const SET_SIZE_GETTER = Object.getOwnPropertyDescriptor(Set.prototype, 'size')?.get
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get
const SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER =
  typeof SharedArrayBuffer === 'undefined'
    ? undefined
    : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get

function hasBrand(value: object, probe: (target: object) => unknown): boolean {
  try {
    probe(value)
    return true
  } catch {
    return false
  }
}

function isRealDate(value: object): boolean {
  return hasBrand(value, (target) => Date.prototype.getTime.call(target as Date))
}

function isRealRegExp(value: object): boolean {
  const getter = REGEXP_SOURCE_GETTER
  return getter !== undefined && hasBrand(value, (target) => getter.call(target))
}

function isRealMap(value: object): boolean {
  const getter = MAP_SIZE_GETTER
  return getter !== undefined && hasBrand(value, (target) => getter.call(target))
}

function isRealSet(value: object): boolean {
  const getter = SET_SIZE_GETTER
  return getter !== undefined && hasBrand(value, (target) => getter.call(target))
}

function isRealArrayBuffer(value: object): boolean {
  const getter = ARRAY_BUFFER_BYTE_LENGTH_GETTER
  return getter !== undefined && hasBrand(value, (target) => getter.call(target))
}

function isRealSharedArrayBuffer(value: object): boolean {
  const getter = SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER
  return getter !== undefined && hasBrand(value, (target) => getter.call(target))
}

/**
 * 普通对象：原型为 Object.prototype 或 null。
 *
 * 额外容忍「跨 realm 的普通对象」：它的原型是对方 realm 的 Object.prototype，
 * 形状上是「原型链只有一层且 constructor.name === 'Object'」。类实例的
 * prototype 链会多一层（Foo.prototype → Object.prototype），因此不会混进来。
 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null
  if (proto === null || proto === Object.prototype) return true
  if (Object.getPrototypeOf(proto) !== null) return false
  const ctor = (proto as { constructor?: unknown }).constructor
  return typeof ctor === 'function' && ctor.name === 'Object'
}

// ---------------------------------------------------------------------------
// 路径格式化
// ---------------------------------------------------------------------------

function problem(path: string, reason: string): CloneProblem {
  return { path: path === '' ? '$' : path, reason }
}

function propertyPath(path: string, key: string): string {
  return IDENTIFIER_PATTERN.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
}

function setElementPath(path: string, index: number): string {
  const access = `set[${index}]`
  return path === '' ? access : `${path}.${access}`
}

function mapKeyLabel(key: unknown): string {
  switch (typeof key) {
    case 'string':
      return JSON.stringify(key)
    case 'number':
    case 'boolean':
      return String(key)
    case 'bigint':
      return `${String(key)}n`
    case 'undefined':
      return 'undefined'
    case 'symbol':
      return String(key)
    case 'function':
      return `[function ${key.name === '' ? 'anonymous' : key.name}]`
    default:
      return key === null ? 'null' : '<object>'
  }
}

function mapEntryPath(path: string, key: unknown): string {
  const access = `map.get(${mapKeyLabel(key)})`
  return path === '' ? access : `${path}.${access}`
}

function arrayIndex(key: string): number | undefined {
  if (!ARRAY_INDEX_PATTERN.test(key)) return undefined
  const index = Number(key)
  return Number.isSafeInteger(index) && index <= MAX_ARRAY_INDEX ? index : undefined
}

function describeThrown(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '<无法描述的异常>'
  }
}

// ---------------------------------------------------------------------------
// 校验主体
// ---------------------------------------------------------------------------

function inspect(
  value: unknown,
  path: string,
  depth: number,
  seen: Set<object>,
): CloneProblem | undefined {
  try {
    return inspectUnsafe(value, path, depth, seen)
  } catch (error) {
    // 兜底：getter/Proxy trap/toStringTag 等抛错时也要给调用点一个可读问题，而不是把异常漏出去。
    return problem(path, `校验时抛错（${describeThrown(error)}），无法确认是否可克隆`)
  }
}

function inspectUnsafe(
  value: unknown,
  path: string,
  depth: number,
  seen: Set<object>,
): CloneProblem | undefined {
  if (depth > MAX_DEPTH) {
    return problem(path, `嵌套过深（超过 ${MAX_DEPTH} 层），已停止校验`)
  }

  if (value === null) return undefined
  if (typeof value !== 'object') {
    if (typeof value === 'symbol') {
      return problem(path, '是 Symbol，structured clone 无法复制（Symbol 的身份不能跨进程保留）')
    }
    if (typeof value === 'function') {
      return problem(path, '是函数，structured clone 无法复制（函数只能留在本进程）')
    }
    // string / number / boolean / bigint / undefined 都可克隆。
    return undefined
  }

  // 循环引用与重复对象：只深入检查一次。
  if (seen.has(value)) return undefined
  seen.add(value)

  if (Array.isArray(value)) return inspectArray(value, path, depth, seen)
  if (ArrayBuffer.isView(value)) return undefined

  const tag = Object.prototype.toString.call(value)

  if (tag === '[object Date]' && isRealDate(value)) return undefined
  if (tag === '[object RegExp]' && isRealRegExp(value)) return undefined
  if (tag === '[object ArrayBuffer]' && isRealArrayBuffer(value)) return undefined
  if (tag === '[object SharedArrayBuffer]' && isRealSharedArrayBuffer(value)) return undefined

  if (tag === '[object Map]' && isRealMap(value)) {
    return inspectMap(value as Map<unknown, unknown>, path, depth, seen)
  }
  if (tag === '[object Set]' && isRealSet(value)) {
    return inspectSet(value as Set<unknown>, path, depth, seen)
  }

  if (isPlainObject(value)) {
    return inspectPlainObject(value as Record<string, unknown>, path, depth, seen)
  }
  if (tag === '[object Error]') {
    return inspectError(value as ErrorLike, path, depth, seen)
  }

  if (tag === '[object Promise]') {
    return problem(path, '是 Promise，structured clone 无法复制（异步句柄不能跨进程传递）')
  }
  if (tag === '[object WeakMap]') {
    return problem(path, '是 WeakMap，structured clone 无法复制（弱引用集合没有可序列化形式）')
  }
  if (tag === '[object WeakSet]') {
    return problem(path, '是 WeakSet，structured clone 无法复制（弱引用集合没有可序列化形式）')
  }
  if (tag === '[object Symbol]') {
    return problem(path, '是 Symbol 包装对象，structured clone 无法复制（Symbol 的身份不能跨进程保留）')
  }

  const label = tag === '[object Object]' ? '类实例或自定义原型对象' : tag
  return problem(
    path,
    `不是受支持的可克隆类型（${label}）：structured clone 会直接报错，或丢掉原型与方法（静默失真）`,
  )
}

interface ErrorLike {
  readonly name?: unknown
  readonly message?: unknown
  readonly stack?: unknown
}

function inspectError(
  error: ErrorLike,
  path: string,
  depth: number,
  seen: Set<object>,
): CloneProblem | undefined {
  for (const field of ERROR_FIELDS) {
    const fieldPath = propertyPath(path, field)
    let fieldValue: unknown
    try {
      fieldValue = error[field]
    } catch (cause) {
      return problem(fieldPath, `读取 Error.${field} 时抛错（${describeThrown(cause)}），无法确认是否可克隆`)
    }
    const found = inspect(fieldValue, fieldPath, depth + 1, seen)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 数组：structured clone 会复制**全部自有可枚举字符串键**（索引 + 扩展属性），
 * 所以这里按 Object.keys 逐个检查；非索引键用 `.foo` / `["weird key"]` 形式。
 */
function inspectArray(
  array: readonly unknown[],
  path: string,
  depth: number,
  seen: Set<object>,
): CloneProblem | undefined {
  let keys: string[]
  try {
    keys = Object.keys(array)
  } catch (cause) {
    return problem(path, `枚举数组元素时抛错（${describeThrown(cause)}），无法确认是否可克隆`)
  }

  for (const key of keys) {
    const index = arrayIndex(key)
    const elementPath = index === undefined ? propertyPath(path, key) : `${path}[${index}]`
    let element: unknown
    try {
      element = index === undefined
        ? (array as unknown as Record<string, unknown>)[key]
        : array[index]
    } catch (cause) {
      return problem(elementPath, `读取数组元素时抛错（${describeThrown(cause)}），无法确认是否可克隆`)
    }
    const found = inspect(element, elementPath, depth + 1, seen)
    if (found !== undefined) return found
  }
  return undefined
}

function inspectMap(
  map: Map<unknown, unknown>,
  path: string,
  depth: number,
  seen: Set<object>,
): CloneProblem | undefined {
  for (const [key, value] of map) {
    const entryPath = mapEntryPath(path, key)
    const keyProblem = inspect(key, entryPath, depth + 1, seen)
    if (keyProblem !== undefined) return keyProblem
    const valueProblem = inspect(value, entryPath, depth + 1, seen)
    if (valueProblem !== undefined) return valueProblem
  }
  return undefined
}

function inspectSet(
  set: Set<unknown>,
  path: string,
  depth: number,
  seen: Set<object>,
): CloneProblem | undefined {
  let index = 0
  for (const value of set) {
    const found = inspect(value, setElementPath(path, index), depth + 1, seen)
    if (found !== undefined) return found
    index += 1
  }
  return undefined
}

function inspectPlainObject(
  object: Record<string, unknown>,
  path: string,
  depth: number,
  seen: Set<object>,
): CloneProblem | undefined {
  let keys: string[]
  try {
    keys = Object.keys(object)
  } catch (cause) {
    return problem(path, `枚举对象属性时抛错（${describeThrown(cause)}），无法确认是否可克隆`)
  }

  for (const key of keys) {
    const keyPath = propertyPath(path, key)
    let child: unknown
    try {
      child = object[key]
    } catch (cause) {
      return problem(keyPath, `读取属性时抛错（${describeThrown(cause)}），无法确认是否可克隆`)
    }
    const found = inspect(child, keyPath, depth + 1, seen)
    if (found !== undefined) return found
  }
  return undefined
}
