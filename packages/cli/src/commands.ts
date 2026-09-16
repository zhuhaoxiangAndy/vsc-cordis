import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { PluginEntry } from '@vscordis/kernel'
import { discoverPlugins, sortByDependencies } from '../../host/src/discovery.ts'
import { signPluginDirectory, verifyPluginArtifact } from '../../host/src/integrity.ts'
import { buildGraph, renderMermaid, renderText, type GraphPlugin } from './graph.ts'

/**
 * CLI 命令实现。
 *
 * 复用关系（刻意不复制实现）：
 * - 插件发现用宿主的 `discovery.ts`（同一份 `plugin.json` 校验与路径安全检查）；
 * - 签名用宿主的 `integrity.ts`（脚本与校验器共用同一实现，避免漂移）；
 * - 依赖图用本包的 `graph.ts`（纯函数，可穷举测试）。
 */

export interface CommandContext {
  readonly cwd: string
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

export async function discover(root: string): Promise<{ entries: PluginEntry[]; problems: string[] }> {
  const result = await discoverPlugins([{ dir: path.resolve(root), source: 'workspace' }])
  return { entries: [...sortByDependencies(result.entries)], problems: [...result.problems] }
}

export function toGraphPlugins(entries: readonly PluginEntry[]): GraphPlugin[] {
  return entries.map((entry) => ({
    id: entry.manifest.id,
    dir: entry.root,
    version: entry.manifest.version,
    trust: entry.manifest.trust,
    provides: entry.manifest.provides,
    dependencies: entry.manifest.dependencies,
  }))
}

export async function runTree(ctx: CommandContext, root: string, mermaid: boolean): Promise<number> {
  const { entries, problems } = await discover(root)
  if (entries.length === 0 && problems.length === 0) {
    ctx.err(`在 ${root} 下没有发现任何插件（每个插件目录需要包含 plugin.json）`)
    return 1
  }

  const graph = buildGraph(toGraphPlugins(entries))
  ctx.out(mermaid ? renderMermaid(graph) : renderText(graph))

  if (problems.length > 0) {
    ctx.out('')
    ctx.out(`清单问题（${problems.length}，这些插件未进入依赖图）`)
    for (const problem of problems) ctx.out(`  ✗ ${problem}`)
  }

  const errors = graph.findings.filter((finding) => finding.level === 'error')
  return errors.length > 0 ? 1 : 0
}

export async function runList(ctx: CommandContext, root: string): Promise<number> {
  const { entries, problems } = await discover(root)
  const graph = buildGraph(toGraphPlugins(entries))

  ctx.out(`插件（${entries.length}）目录：${path.resolve(root)}`)
  if (entries.length === 0) ctx.out('  <无>')
  for (const entry of entries) {
    const manifest = entry.manifest
    ctx.out(`  ${manifest.id}@${manifest.version} [${manifest.trust}]`)
    ctx.out(`    dir      ：${path.relative(ctx.cwd, entry.root) || '.'}`)
    ctx.out(`    main     ：${manifest.main}`)
    ctx.out(`    provides ：${manifest.provides.join(', ') || '-'}`)
    ctx.out(
      `    depends  ：${Object.entries(manifest.dependencies).map(([name, range]) => `${name}@${range}`).join(', ') || '-'}`,
    )
    ctx.out(`    permissions：${manifest.permissions.join(', ') || '-'}`)
  }

  if (problems.length > 0) {
    ctx.out('')
    ctx.out(`清单问题（${problems.length}）`)
    for (const problem of problems) ctx.out(`  ✗ ${problem}`)
  }

  ctx.out('')
  ctx.out(`依赖图检查：${graph.findings.length} 条`)
  for (const finding of graph.findings) ctx.out(`  ${finding.level === 'error' ? '✗' : '⚠'} ${finding.message}`)

  return problems.length > 0 || graph.findings.some((finding) => finding.level === 'error') ? 1 : 0
}

export async function runCreate(
  ctx: CommandContext,
  name: string,
  dir: string,
  trust: string,
): Promise<number> {
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/.test(name)) {
    ctx.err(`插件名非法：${name}（要求小写字母/数字/连字符，可带点分隔的段，例如 com.example.hello）`)
    return 2
  }
  if (trust !== 'trusted' && trust !== 'untrusted') {
    ctx.err(`--trust 只能是 trusted / untrusted，实际为 ${trust}`)
    return 2
  }

  const target = path.join(path.resolve(ctx.cwd, dir), name)
  if (existsSync(target)) {
    ctx.err(`目标目录已存在，拒绝覆盖：${target}`)
    return 2
  }

  await mkdir(path.join(target, 'src'), { recursive: true })

  const manifest = {
    id: name,
    name,
    version: '0.1.0',
    description: `${name} —— 由 vscordis create 生成`,
    main: 'dist/index.cjs',
    trust,
    // provides / dependencies 留空但写出来：它们是静态依赖图的依据（ADR-0014）。
    provides: [],
    dependencies: {},
    permissions: ['vscode:commands.register', 'vscode:window.messages'],
  }
  await writeFile(path.join(target, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  await writeFile(
    path.join(target, 'package.json'),
    `${JSON.stringify(
      {
        name: `vscordis-plugin-${name}`,
        version: '0.1.0',
        private: true,
        type: 'module',
        description: manifest.description,
        dependencies: { '@vscordis/sdk': 'workspace:*' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  await writeFile(
    path.join(target, 'src', 'index.ts'),
    [
      "import type { CordisPlugin } from '@vscordis/sdk'",
      '',
      'export default {',
      `  name: '${name}',`,
      '',
      '  activate(ctx) {',
      '    // 所有副作用都必须经 ctx.effect 登记，卸载时由 EffectStack LIFO 逆序回收。',
      '    ctx.effect(',
      `      () => ctx.vscode.commands.registerCommand('${name}.hello', () => {`,
      `        void ctx.vscode.window.showInformationMessage('Hello from ${name}')`,
      '      }),',
      '      (disposable) => disposable.dispose(),',
      `      'command:${name}.hello',`,
      '    )',
      '',
      `    ctx.log.info('${name} 已激活')`,
      '  },',
      '',
      '  async deactivate(ctx) {',
      `    ctx.log.info('${name} 正在卸载')`,
      '  },',
      "} satisfies CordisPlugin",
      '',
    ].join('\n'),
    'utf8',
  )

  ctx.out(`已创建插件：${path.relative(ctx.cwd, target) || '.'}`)
  ctx.out('  plugin.json / package.json / src/index.ts')
  ctx.out('')
  ctx.out('下一步：')
  ctx.out('  1. 在仓库根目录运行 pnpm install（把新包接入 workspace）')
  ctx.out('  2. 运行 pnpm run build（或 pnpm run watch）')
  ctx.out(`  3. 在 VSCode 里 F5，然后 ctrl+shift+p → VSCordis: 运行插件命令… → ${name}.hello`)
  if (trust === 'untrusted') {
    ctx.out('')
    ctx.out('注意：该插件声明为 untrusted，会运行在**独立子进程**里。')
    ctx.out('      隔离模式下不能用 ctx.use / ctx.provide，也不支持 createStatusBarItem /')
    ctx.out('      getConfiguration / onDidSaveTextDocument（见 docs/acceptance-m4b.md）。')
  }
  return 0
}

export async function runSign(
  ctx: CommandContext,
  target: string,
  keyPath: string | undefined,
  shouldVerify: boolean,
): Promise<number> {
  const pluginDir = path.resolve(ctx.cwd, target)
  if (!existsSync(path.join(pluginDir, 'plugin.json'))) {
    ctx.err(`找不到插件：${pluginDir}（需要 plugin.json）`)
    return 1
  }

  const resolvedKey = keyPath ?? defaultPrivateKeyPath()
  if (!existsSync(resolvedKey)) {
    ctx.err(`找不到私钥：${resolvedKey}`)
    ctx.err('先运行 pnpm run keygen（见 docs/signing.md）')
    return 1
  }

  const { readFileSync } = await import('node:fs')
  const result = signPluginDirectory(pluginDir, readFileSync(resolvedKey, 'utf8'))
  ctx.out(`已签名：${path.relative(ctx.cwd, pluginDir) || '.'}`)
  ctx.out(`  产物  ：${result.integrity.file}`)
  ctx.out(`  sha256：${result.integrity.hash}`)

  if (!shouldVerify) return 0

  const publicPath = path.join(ctx.cwd, 'packages', 'host', 'keys', 'vscordis-ed25519.pub.pem')
  if (!existsSync(publicPath)) {
    ctx.err(`找不到公钥：${publicPath}`)
    return 1
  }
  const outcome = verifyPluginArtifact({
    root: pluginDir,
    publicKeyPem: readFileSync(publicPath, 'utf8'),
    requireSignature: true,
  })
  if (!outcome.ok) {
    ctx.err(`回验不通过：${outcome.reason}`)
    return 1
  }
  ctx.out(`  回验  ：通过（模式 ${outcome.mode}）`)
  return 0
}

function defaultPrivateKeyPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '.'
  return path.join(home, '.dsh', 'keys', 'vscordis-ed25519.pem')
}

/**
 * 开发模式：用 esbuild 的 watch 增量重建插件产物。
 *
 * esbuild 是**动态导入**的：它只在 `dev` 命令里需要，不该拖累其它命令的启动时间，
 * 也不该被打进 CLI 产物（构建时标记为 external）。
 */
export async function runDev(ctx: CommandContext, root: string): Promise<number> {
  let esbuild: typeof import('esbuild')
  try {
    esbuild = await import('esbuild')
  } catch {
    ctx.err('dev 命令需要 esbuild，请先运行 pnpm install')
    return 1
  }

  const { entries, problems } = await discover(root)
  for (const problem of problems) ctx.err(`✗ ${problem}`)

  const targets = entries.filter((entry) => existsSync(path.join(entry.root, 'src', 'index.ts')))
  if (targets.length === 0) {
    ctx.err(`在 ${root} 下没有找到可构建的插件（需要 <插件>/src/index.ts）`)
    return 1
  }

  const tsconfig = path.join(ctx.cwd, 'tsconfig.base.json')
  const forbidVscode = {
    name: 'forbid-vscode',
    setup(build: { onResolve: (options: { filter: RegExp }, callback: () => { errors: { text: string }[] }) => void }): void {
      build.onResolve({ filter: /^vscode$/ }, () => ({
        errors: [{ text: '禁止直接 import/require "vscode"：请使用 ctx.vscode 受控 API（ADR-0003）' }],
      }))
    },
  }

  const contexts: { dispose(): Promise<void> }[] = []
  for (const entry of targets) {
    const context = await esbuild.context({
      entryPoints: [path.join(entry.root, 'src', 'index.ts')],
      outfile: path.join(entry.root, entry.manifest.main),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      tsconfig,
      sourcemap: 'inline',
      logLevel: 'info',
      plugins: [forbidVscode],
    })
    await context.watch()
    contexts.push(context)
    ctx.out(`[watch] ${entry.manifest.id}`)
  }

  ctx.out('')
  ctx.out('已开始监听；改动会在 <1s 内被宿主热重载（需 vscordis.hotReload 打开）。')
  ctx.out('停止：Ctrl+C')

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void Promise.all(contexts.map((context) => context.dispose())).then(() => resolve())
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })
  return 0
}
