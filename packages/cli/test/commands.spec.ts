import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { main } from '../src/main.ts'

/**
 * 命令级测试：**真的跑字节**（读输出、看文件），而不是调用内部函数。
 *
 * 用 `main(argv, cwd)` 而不是 spawn 子进程：这样不必先构建 CLI 产物，
 * 测试结果也不受构建顺序影响。唯一的代价是拿不到真实的 exit code，
 * 于是用 `main` 的返回值来断言。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const scratch = path.join(here, 'scratch')
/** 每次运行用不同目录名，避免测试之间互相干扰（也不删除任何东西）。 */
const runId = `${Date.now().toString(36)}`

interface Captured {
  readonly code: number
  readonly out: string
  readonly err: string
}

async function run(argv: readonly string[], cwd = repoRoot): Promise<Captured> {
  const out: string[] = []
  const err: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args: unknown[]) => void out.push(args.join(' '))
  console.error = (...args: unknown[]) => void err.push(args.join(' '))
  try {
    const code = await main(argv, cwd)
    return { code, out: out.join('\n'), err: err.join('\n') }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

async function writePlugin(root: string, id: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(root, id)
  await mkdir(path.join(dir, 'dist'), { recursive: true })
  await writeFile(path.join(dir, 'dist', 'index.cjs'), 'module.exports = { activate() {} }\n', 'utf8')
  await writeFile(
    path.join(dir, 'plugin.json'),
    `${JSON.stringify(
      { id, name: id, version: '1.0.0', main: 'dist/index.cjs', trust: 'trusted', permissions: [], ...manifest },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

test('create：生成插件骨架', async () => {
  const root = path.join(scratch, `create-${runId}`)
  const result = await run(['create', 'demo-plugin', '--dir', root])

  assert.equal(result.code, 0)
  assert.match(result.out, /已创建插件/)
  assert.equal(existsSync(path.join(root, 'demo-plugin', 'plugin.json')), true)
  assert.equal(existsSync(path.join(root, 'demo-plugin', 'src', 'index.ts')), true)

  const manifest = JSON.parse(readFileSync(path.join(root, 'demo-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>
  assert.equal(manifest.id, 'demo-plugin')
  assert.equal(manifest.trust, 'trusted')
  // provides / dependencies 即使是空的也要写出来：它们是静态依赖图的依据
  assert.deepEqual(manifest.provides, [])
  assert.deepEqual(manifest.dependencies, {})
})

test('create：目标目录已存在时拒绝覆盖（退出码 2）', async () => {
  const root = path.join(scratch, `create-dup-${runId}`)
  assert.equal((await run(['create', 'dup', '--dir', root])).code, 0)

  const second = await run(['create', 'dup', '--dir', root])
  assert.equal(second.code, 2)
  assert.match(second.err, /拒绝覆盖/)
})

test('create：非法插件名被拒绝', async () => {
  const root = path.join(scratch, `create-bad-${runId}`)
  const result = await run(['create', 'Bad_Name', '--dir', root])
  assert.equal(result.code, 2)
  assert.match(result.err, /插件名非法/)
})

test('create：--trust untrusted 会附上隔离限制说明', async () => {
  const root = path.join(scratch, `create-untrusted-${runId}`)
  const result = await run(['create', 'iso-demo', '--dir', root, '--trust', 'untrusted'])
  assert.equal(result.code, 0)
  assert.match(result.out, /独立子进程/)
  assert.match(result.out, /不能用 ctx\.use/)
})

test('create：--trust 非法值被拒绝', async () => {
  const root = path.join(scratch, `create-trust-${runId}`)
  const result = await run(['create', 'x', '--dir', root, '--trust', 'root'])
  assert.equal(result.code, 2)
  assert.match(result.err, /只能是 trusted \/ untrusted/)
})

test('list：健康插件返回 0 并打印声明', async () => {
  const root = path.join(scratch, `list-ok-${runId}`)
  await writePlugin(root, 'provider', { provides: ['clock'] })
  await writePlugin(root, 'consumer', { dependencies: { clock: '^1.0.0' } })

  const result = await run(['list', '--root', root])
  assert.equal(result.code, 0)
  assert.match(result.out, /provides ：clock/)
  assert.match(result.out, /depends  ：clock@\^1\.0\.0/)
  assert.match(result.out, /依赖图检查：0 条/)
})

test('list：坏清单被报告，退出码 1（不影响其它插件）', async () => {
  const root = path.join(scratch, `list-bad-${runId}`)
  await writePlugin(root, 'good', {})
  await mkdir(path.join(root, 'broken'), { recursive: true })
  await writeFile(path.join(root, 'broken', 'plugin.json'), '{ "id": "broken" }\n', 'utf8')

  const result = await run(['list', '--root', root])
  assert.equal(result.code, 1)
  assert.match(result.out, /清单问题（1）/)
  assert.match(result.out, /good/)
})

test('tree：打印加载顺序与服务；缺提供者时退出码 1', async () => {
  const root = path.join(scratch, `tree-${runId}`)
  await writePlugin(root, 'provider', { provides: ['clock'] })
  await writePlugin(root, 'consumer', { dependencies: { clock: '^1.0.0' } })

  const ok = await run(['tree', '--root', root])
  assert.equal(ok.code, 0)
  assert.match(ok.out, /加载顺序：provider → consumer/)

  await writePlugin(root, 'orphan', { dependencies: { nothing: '*' } })
  const bad = await run(['tree', '--root', root])
  assert.equal(bad.code, 1)
  assert.match(bad.out, /没有任何插件声明提供它/)
})

test('tree --mermaid：输出 flowchart', async () => {
  const root = path.join(scratch, `tree-mermaid-${runId}`)
  await writePlugin(root, 'provider', { provides: ['clock'] })
  await writePlugin(root, 'consumer', { dependencies: { clock: '^1.0.0' } })

  const result = await run(['tree', '--root', root, '--mermaid'])
  assert.equal(result.code, 0)
  assert.match(result.out, /^flowchart LR/m)
})

test('未知命令与空命令都返回用法错误', async () => {
  assert.equal((await run(['frobnicate'])).code, 2)
  assert.equal((await run([])).code, 2)
  assert.equal((await run(['help'])).code, 0)
})

test('tree：空目录给出可操作提示', async () => {
  const root = path.join(scratch, `tree-empty-${runId}`)
  await mkdir(root, { recursive: true })
  const result = await run(['tree', '--root', root])
  assert.equal(result.code, 1)
  assert.match(result.err, /没有发现任何插件/)
})

test('sign：缺少私钥时给出可操作提示（不抛栈）', async () => {
  const root = path.join(scratch, `sign-${runId}`)
  await writePlugin(root, 'to-sign', {})
  const result = await run(['sign', path.join(root, 'to-sign'), '--key', path.join(root, 'nonexistent.pem')])
  assert.equal(result.code, 1)
  assert.match(result.err, /找不到私钥/)
  assert.match(result.err, /keygen/)
})

test('sign：目标不是插件目录时报错', async () => {
  const result = await run(['sign', path.join(scratch, 'definitely-not-a-plugin')])
  assert.equal(result.code, 1)
  assert.match(result.err, /找不到插件/)
})

// ————————————————————————————————— dev：只测前置检查

/**
 * `dev` 是长驻进程（esbuild watch），完整端到端需要 spawn + 信号，
 * 收益不抵复杂度。但它**在启动监听之前**的前置检查是纯逻辑且必须准确 ——
 * 一个"什么也没构建就静静挂在那里"的 watch 是最难排查的形态。
 */
test('dev：目录下没有可构建的插件 → 退出码 1 且说明需要什么', async () => {
  const root = path.join(scratch, `dev-empty-${runId}`)
  await mkdir(root, { recursive: true })
  const result = await run(['dev', '--root', root])

  assert.equal(result.code, 1)
  assert.match(result.err, /没有找到可构建的插件/)
  assert.match(result.err, /src\/index\.ts/, '必须说清它到底在找什么，而不是只说"没找到"')
})

test('dev：只有 dist 没有 src 的插件同样被判为不可构建', async () => {
  const root = path.join(scratch, `dev-no-src-${runId}`)
  // writePlugin 只写 plugin.json 与 dist/index.cjs，不写 src/ —— 正是"已构建但没源码"的形态
  await writePlugin(root, 'built-only', {})

  const result = await run(['dev', '--root', root])
  assert.equal(result.code, 1)
  assert.match(result.err, /没有找到可构建的插件/)
})

test('list：engines.vscordis 与仓库内宿主版本不匹配 → warning 并指向 ADR-0017', async () => {
  const root = path.join(scratch, `engines-${runId}`)
  await writePlugin(root, 'needs-new-host', { engines: { vscordis: '^9.0.0' } })

  const result = await run(['list', '--root', root])

  // CLI 的 engines 检查只是**提前提示**：不匹配不是 error（强制点在加载期）
  assert.equal(result.code, 0)
  assert.match(result.out, /engines\.vscordis = \^9\.0\.0/)
  assert.match(result.out, /ADR-0017/)
})

test('readHostVersion：与 packages/host/package.json 的 version 一致（src/dist 相对深度相同）', async () => {
  const { readHostVersion } = await import('../src/commands.ts')
  const pkg = JSON.parse(
    readFileSync(path.join(repoRoot, 'packages', 'host', 'package.json'), 'utf8'),
  ) as { version: string }
  assert.equal(readHostVersion(), pkg.version)
})

test('tree --json：输出可解析的依赖图 JSON（机器可读，供 CI/编辑器工具）', async () => {
  const root = path.join(scratch, `tree-json-${runId}`)
  await writePlugin(root, 'provider', { provides: ['clock'] })
  await writePlugin(root, 'consumer', { dependencies: { clock: '^1.0.0' } })

  const result = await run(['tree', '--json', '--root', root])
  assert.equal(result.code, 0, result.err)

  const graph = JSON.parse(result.out) as {
    plugins: { id: string }[]
    services: { name: string; providers: string[] }[]
    findings: unknown[]
    loadOrder: string[]
    consumers: Record<string, string[]>
  }
  assert.deepEqual(graph.plugins.map((candidate) => candidate.id).sort(), ['consumer', 'provider'])
  assert.deepEqual(graph.services, [{ name: 'clock', providers: ['provider'] }])
  assert.deepEqual(graph.findings, [])
  assert.deepEqual(graph.loadOrder, ['provider', 'consumer'])
  assert.deepEqual(graph.consumers.clock, ['consumer'])
})

test('tree：--mermaid 与 --json 同时给 → 用法错误（退出码 2，而不是猜一个输出）', async () => {
  const root = path.join(scratch, `tree-both-${runId}`)
  await writePlugin(root, 'solo', {})

  const result = await run(['tree', '--json', '--mermaid', '--root', root])
  assert.equal(result.code, 2)
  assert.match(result.err, /不能同时使用/)
})
