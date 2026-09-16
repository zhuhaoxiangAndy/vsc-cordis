/**
 * 版本范围的最小实现（ADR-0007 决策 2）。
 *
 * 故意**不引入 `semver` 依赖**：覆盖插件间协作实际需要的 4 种写法，
 * 超出子集的写法在 manifest 校验期**报错**（fail-closed），不静默当作 `*`。
 */

const RANGE_PATTERN = /^(\*|\d+\.\d+\.\d+|\^\d+\.\d+\.\d+|>=\d+\.\d+\.\d+)$/

export function isValidRange(range: string): boolean {
  return RANGE_PATTERN.test(range)
}

type Triple = readonly [number, number, number]

export function parseVersion(version: string): Triple | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

export function satisfies(version: string, range: string): boolean {
  const actual = parseVersion(version)
  if (actual === undefined) return false
  if (range === '*') return true

  if (range.startsWith('>=')) {
    const bound = parseVersion(range.slice(2))
    return bound !== undefined && compare(actual, bound) >= 0
  }

  if (range.startsWith('^')) {
    const base = parseVersion(range.slice(1))
    if (base === undefined) return false
    if (compare(actual, base) < 0) return false
    const [major, minor] = base
    // 与 npm 的 caret 语义对齐：^0.x.y 收紧到次版本，^0.0.z 收紧到补丁版本。
    if (major > 0) return actual[0] === major
    if (minor > 0) return actual[0] === 0 && actual[1] === minor
    return actual[0] === 0 && actual[1] === 0 && actual[2] === base[2]
  }

  const exact = parseVersion(range)
  return exact !== undefined && compare(actual, exact) === 0
}
