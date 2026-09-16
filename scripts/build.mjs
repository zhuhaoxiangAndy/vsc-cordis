// 构建脚本：插件 → 单文件 CJS；宿主 → Node CJS + Web ESM。
//
// 三个刻意的设计点：
// 1. `forbid-vscode` 插件把 `import 'vscode'` 变成**构建错误**。扩展宿主会把 vscode 注入给
//    扩展目录下的任何模块（ADR-0003），构建期封堵是唯一可靠的一道防线。
// 2. 插件强制打成**单文件 CJS**：卸载时只需清一条 require.cache，行为可预测（ADR-0009）。
// 3. Web 入口用 `platform: 'browser'` 构建 —— 一旦有 Node 内建模块被误引入，esbuild 直接失败，
//    这道护栏让"kernel 零 Node 依赖"这条纪律可以被机器验证。

import { build } from 'esbuild'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsconfig = path.join(root, 'tsconfig.base.json')
const production = process.argv.includes('--production')

const forbidVscode = {
  name: 'forbid-vscode',
  setup(build) {
    build.onResolve({ filter: /^vscode$/ }, (args) => ({
      errors: [
        {
          text: `禁止直接 import/require "vscode"（来自 ${args.importer}）：请使用 ctx.vscode 受控 API（ADR-0003）`,
        },
      ],
    }))
  },
}

const shared = {
  bundle: true,
  tsconfig,
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'warning',
}

async function buildPlugins() {
  const pluginsDir = path.join(root, 'plugins')
  for (const name of readdirSync(pluginsDir).sort()) {
    const dir = path.join(pluginsDir, name)
    const entry = path.join(dir, 'src', 'index.ts')
    if (!existsSync(entry)) continue
    const outfile = path.join(dir, 'dist', 'index.cjs')
    mkdirSync(path.dirname(outfile), { recursive: true })
    await build({
      ...shared,
      entryPoints: [entry],
      outfile,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      plugins: [forbidVscode],
    })
    console.log(`[plugin] ${path.relative(root, outfile)}`)
  }
}

async function buildHostNode() {
  const outfile = path.join(root, 'packages', 'host', 'dist', 'extension.cjs')
  mkdirSync(path.dirname(outfile), { recursive: true })
  await build({
    ...shared,
    entryPoints: [path.join(root, 'packages', 'host', 'src', 'extension.ts')],
    outfile,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  })
  console.log(`[host]   ${path.relative(root, outfile)}`)
}

async function buildHostWeb() {
  const outfile = path.join(root, 'packages', 'host', 'dist', 'web', 'extension.js')
  mkdirSync(path.dirname(outfile), { recursive: true })
  await build({
    ...shared,
    entryPoints: [path.join(root, 'packages', 'host', 'src', 'browser.ts')],
    outfile,
    // Web 扩展宿主里没有 require（官方文档明确），因此入口必须是 ES module。
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    external: ['vscode'],
  })
  console.log(`[web]    ${path.relative(root, outfile)}`)
}

await buildPlugins()
await buildHostNode()
await buildHostWeb()
console.log(production ? '[build] 完成（production）' : '[build] 完成（development，内联 sourcemap）')
