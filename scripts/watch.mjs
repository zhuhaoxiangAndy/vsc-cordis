// 插件源码的 esbuild watch：源码变化 → 重建 dist/index.cjs → 宿主的文件监听看到 dist 变化 → 热重载。
//
// 为什么不把 esbuild 放进扩展进程：编译属于开发期动作，把它变成宿主的运行时依赖
// 会平白增加发布体积与启动开销。终端里开一个 `npm run watch` 就够了。
//
// 注意：宿主扩展自身的改动（packages/host/**）不在监听范围内 —— 那需要重载窗口，
// 这是 VSCode 的既有约束（官方不支持运行期卸载扩展，见 ADR-0003）。

import { context } from 'esbuild'
import { existsSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsconfig = path.join(root, 'tsconfig.base.json')

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

const pluginsDir = path.join(root, 'plugins')
const contexts = []

for (const name of readdirSync(pluginsDir).sort()) {
  const dir = path.join(pluginsDir, name)
  const entry = path.join(dir, 'src', 'index.ts')
  if (!existsSync(entry)) continue

  const ctx = await context({
    entryPoints: [entry],
    outfile: path.join(dir, 'dist', 'index.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    tsconfig,
    sourcemap: 'inline',
    logLevel: 'info',
    plugins: [forbidVscode],
  })
  await ctx.watch()
  contexts.push(ctx)
  console.log(`[watch] plugins/${name}`)
}

console.log('[watch] 已开始监听插件源码；改动会在 <1s 内被宿主热重载')
console.log('[watch] 停止：Ctrl+C')

const shutdown = async () => {
  await Promise.all(contexts.map((ctx) => ctx.dispose()))
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
