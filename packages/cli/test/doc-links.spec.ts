import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * `scripts/check-doc-links.mjs` 的测试。
 *
 * 第一条用例是**反向验证**：一个坏的 Markdown 链接必须让检查器退出 1 ——
 * 否则"文档链接检查通过"就只是一句永远为真的话（本仓库在 ADR-0019 里吃过一次
 * "永远为真的断言"的亏，见 handoff 复盘）。
 * 第二条覆盖行内代码引用（本仓库的主要引用形态）与"通配/产物跳过"的边界。
 * 最后一条是真正的门禁：跑在**本仓库自己身上**。
 *
 * 每条用例用独立的 scratch 目录，不删除任何文件（scratch 已被 gitignore）。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const script = path.join(repoRoot, 'scripts', 'check-doc-links.mjs')
const scratch = path.join(here, 'scratch')
const runId = `${process.pid}-${Date.now()}`

function runChecker(root: string): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [script, root], { encoding: 'utf8' })
    return { code: 0, output }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

test('check-doc-links：坏链接必须让检查失败（反向验证）', async () => {
  const root = path.join(scratch, `doclinks-bad-${runId}`)
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, 'README.md'), '# 测试\n\n[坏链接](./missing-doc.md)\n', 'utf8')

  const result = runChecker(root)
  assert.equal(result.code, 1, `坏链接必须导致退出码 1，实际 ${result.code}\n${result.output}`)
  assert.match(result.output, /missing-doc\.md/)
})

test('check-doc-links：行内代码引用（含 docs/adr/NNNN 短引用）同样会失败', async () => {
  const root = path.join(scratch, `doclinks-inline-${runId}`)
  await mkdir(root, { recursive: true })
  await writeFile(
    path.join(root, 'README.md'),
    '# 测试\n\n见 `docs/adr/9999` 与 `packages/nope/gone.md`。\n',
    'utf8',
  )

  const result = runChecker(root)
  assert.equal(result.code, 1)
  assert.match(result.output, /docs\/adr\/9999/)
  assert.match(result.output, /packages\/nope\/gone\.md/)
})

test('check-doc-links：好链接放行，通配与构建产物按边界跳过', async () => {
  const root = path.join(scratch, `doclinks-good-${runId}`)
  await mkdir(path.join(root, 'docs', 'nested'), { recursive: true })
  await writeFile(path.join(root, 'docs', 'nested', 'ok.md'), '# ok\n', 'utf8')
  await writeFile(
    path.join(root, 'README.md'),
    [
      '# 测试',
      '',
      '[好链接](./docs/nested/ok.md)',
      '',
      '行内：`docs/nested/ok.md`、`docs/nested`、`packages/*/test/*.spec.ts`（通配，跳过）、`dist/cli.mjs`（产物，跳过）',
      '',
      '外链：https://example.com/whatever',
      '',
    ].join('\n'),
    'utf8',
  )

  const result = runChecker(root)
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /检查通过/)
})

test('check-doc-links：本仓库文档必须全绿（真正的门禁）', () => {
  const result = runChecker(repoRoot)
  assert.equal(result.code, 0, result.output)
})
