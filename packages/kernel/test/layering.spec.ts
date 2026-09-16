import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'

/**
 * 分层不变量（比构建更早、更清楚地失败）。
 *
 * - `kernel/src` 不得 import `vscode`，也不得 import Node 内建（`node:*`）——
 *   这是三件事的前提：kernel 能被纯 Node 单测、能进浏览器构建、能跑在隔离子进程里（ADR-0001 / 0009）。
 * - `sdk/src` 对 `vscode` 的引用必须**全部是 `import type`**：编译后消失，
 *   插件产物里不会出现 `require('vscode')`（ADR-0010）。
 *
 * 真正的护栏是 esbuild 的 browser 目标（kernel 一旦引 Node 内建，构建会直接失败）；
 * 这两条测试的价值是**指出具体是哪个文件、哪一行**破了规矩，而不是等构建报一堆解析错误。
 */

const KERNEL_SRC = new URL('../src/', import.meta.url)
const SDK_SRC = new URL('../../sdk/src/', import.meta.url)

async function sourceFiles(dir: URL): Promise<{ name: string; text: string }[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.ts')).sort()
  return await Promise.all(
    names.map(async (name) => ({ name, text: await readFile(new URL(name, dir), 'utf8') })),
  )
}

test('分层：kernel/src 不得 import vscode 或 Node 内建（node:*）', async () => {
  const files = await sourceFiles(KERNEL_SRC)
  assert.ok(files.length >= 10, `只扫到 ${files.length} 个文件，断言可能空转`)

  for (const file of files) {
    // 用 exec + 自定义消息，而不是 doesNotMatch：后者会把整个文件内容打进失败输出
    const staticImport = /from\s+['"](?:vscode|node:)/.exec(file.text)
    if (staticImport !== null) {
      assert.fail(
        `kernel/src/${file.name} 不能从 vscode / node:* 导入（ADR-0001：kernel 零 vscode、零 Node 依赖）` +
          `：命中「${staticImport[0]}」`,
      )
    }
    const dynamicImport = /\b(?:require|import)\(\s*['"](?:vscode|node:)/.exec(file.text)
    if (dynamicImport !== null) {
      assert.fail(`kernel/src/${file.name} 不能 require / 动态 import vscode 或 Node 内建：命中「${dynamicImport[0]}」`)
    }
  }
})

test('分层：sdk/src 对 vscode 的引用必须全部是 import type', async () => {
  const files = await sourceFiles(SDK_SRC)
  assert.ok(files.length >= 5, `只扫到 ${files.length} 个文件，断言可能空转`)

  let references = 0
  for (const file of files) {
    for (const line of file.text.split('\n')) {
      if (!/from\s+['"]vscode['"]/.test(line)) continue
      references += 1
      assert.match(
        line,
        /^\s*import\s+type\b/,
        `sdk/src/${file.name} 对 vscode 的引用必须是 import type：${line.trim()}`,
      )
    }
  }
  // 哨兵：`vscode-api.ts` 必然有一处；扫不到说明测试在空转
  assert.ok(references >= 1, '没有扫到任何 vscode 引用，断言可能空转')
})
