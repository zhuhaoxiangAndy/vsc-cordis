import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build, stop } from 'esbuild'
import { PluginHost, validateManifest, type HostPort, type LoadedPluginModule, type PluginEntry } from '@vscordis/kernel'
import type { LogLevel, PluginVscodeApi } from '@vscordis/sdk'
import { NodeModuleLoader } from '../../host/src/loader-node.ts'
import { FakeHostPort } from '../../kernel/test/support.ts'
import { main } from '../src/main.ts'

const nodeRequire = createRequire(import.meta.url)

/**
 * 是否还在 `require.cache` 里 —— 这是"模块真的被释放了"的**真实效果**断言。
 * 刻意不去查测试替身的记账数组：那些数组只反映替身自己的行为，
 * 而这里跑的是真实 `NodeModuleLoader`（它清的就是这张缓存表）。
 */
function isCached(file: string): boolean {
  const target = path.resolve(file)
  return Object.keys(nodeRequire.cache).some((key) => path.resolve(key) === target)
}

/**
 * CLI 端到端：**生成的骨架必须真的能被构建并加载运行**。
 *
 * 为什么值得单独写：`create` 是一个"看起来成功了"就够了的命令 —— 文件写出来了、退出码 0，
 * 但生成的代码能不能编译、能不能激活、命令能不能注册，只有跑一遍才知道。
 * 这里把 create → esbuild 构建 → 真实 NodeModuleLoader 加载 → 真实 PluginHost 激活 → 执行命令
 * 串成一条链，任何一环断了都会失败。
 *
 * 注意：用**真实的** HostPort 组合（真加载器 + 假 vscode API）。
 * 假 vscode 是必要的（真实 vscode 模块只在扩展宿主里存在），但模块加载、清单校验、
 * 生命周期与 EffectStack 全是生产代码。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const scratch = path.join(here, 'scratch')
const runId = `${Date.now().toString(36)}`

after(async () => {
  // esbuild 的 JS API 会拉起常驻 service 子进程；不显式停掉，测试进程就退不出去
  await stop().catch(() => undefined)
})

/** 真加载器 + 假 vscode API。加载路径是生产代码，API 面是测试替身。 */
class RealLoaderPort implements HostPort {
  readonly platform = 'node' as const
  readonly supportsIsolation = false
  readonly fake = new FakeHostPort()
  readonly #loader = new NodeModuleLoader()

  async loadModule(entry: PluginEntry): Promise<LoadedPluginModule> {
    return this.#loader.load(entry)
  }

  createApi(deps: Parameters<FakeHostPort['createApi']>[0]): PluginVscodeApi {
    return this.fake.createApi(deps)
  }

  log(level: LogLevel, message: string, meta?: Readonly<Record<string, unknown>>): void {
    this.fake.log(level, message, meta)
  }
}

/**
 * 读**生成的** plugin.json 并用**真实校验器**解析。
 *
 * 不手工拼 PluginEntry：那样就绕过了"create 产出的清单是否合法"这一环，
 * 而它恰恰是最容易出错的地方（字段名、版本格式、权限词表）。
 */
function readGeneratedEntry(pluginDir: string, outfile: string): PluginEntry {
  const raw: unknown = JSON.parse(readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'))
  const validated = validateManifest(raw)
  assert.equal(
    validated.ok,
    true,
    `create 生成的 plugin.json 必须能通过内核校验：${validated.ok ? '' : validated.errors.join('; ')}`,
  )
  if (!validated.ok) throw new Error('unreachable')
  return { root: pluginDir, mainPath: outfile, source: 'workspace', manifest: validated.manifest }
}

async function runCli(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args: unknown[]) => void out.push(args.join(' '))
  console.error = (...args: unknown[]) => void err.push(args.join(' '))
  try {
    const code = await main(argv, repoRoot)
    return { code, out: out.join('\n'), err: err.join('\n') }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

test('端到端：create 生成的插件能被构建、加载、激活并执行命令', async () => {
  const pluginsRoot = path.join(scratch, `e2e-${runId}`)
  const name = 'e2e-generated'

  // ① create
  const created = await runCli(['create', name, '--dir', pluginsRoot])
  assert.equal(created.code, 0, `create 应当成功：${created.err}`)
  const pluginDir = path.join(pluginsRoot, name)
  assert.equal(existsSync(path.join(pluginDir, 'src', 'index.ts')), true)

  // ② 用生产同款方式构建（单文件 CJS）
  await mkdir(path.join(pluginDir, 'dist'), { recursive: true })
  const outfile = path.join(pluginDir, 'dist', 'index.cjs')
  await build({
    entryPoints: [path.join(pluginDir, 'src', 'index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    tsconfig: path.join(repoRoot, 'tsconfig.base.json'),
    logLevel: 'silent',
  })
  assert.equal(existsSync(outfile), true, '生成的源码必须能被 esbuild 打成单文件 CJS')
  assert.equal(isCached(outfile), false, '构建产物在加载前不应出现在 require.cache 里')

  // ③ 加载 + 激活（真实 PluginHost + 真实加载器）
  const port = new RealLoaderPort()
  const host = new PluginHost({ port, disposeTimeoutMs: 200, activationTimeoutMs: 5_000 })
  const entry = readGeneratedEntry(pluginDir, outfile)

  try {
    await host.load(entry)
    await host.settle()

    assert.equal(host.view(name)?.state, 'active', '生成的插件应当能激活')
    assert.equal(isCached(outfile), true, '激活后产物应当在 require.cache 里')
    assert.deepEqual(
      [...port.fake.commands.keys()],
      [`${name}.hello`],
      '生成的插件应当注册出骨架里那条命令',
    )
    assert.ok(
      port.fake.logsFor(name).some((message) => message.includes('已激活')),
      '插件自己的日志应当能通过 ctx.log 传出来',
    )

    // ④ 执行命令（走假 vscode 的注册表 → 真实 handler）
    const record = port.fake.commands.get(`${name}.hello`)
    assert.ok(record !== undefined)
    await record.handler()
    assert.equal(record.disposed, false)

    // ⑤ 卸载：命令必须撤销，副作用栈归零
    await host.unload(name)
    await host.settle()
    assert.deepEqual(host.list(), [])
    assert.equal(port.fake.commands.size, 0, '卸载后命令必须从注册表消失')
    assert.equal(host.registry.size, 0)
    assert.equal(isCached(outfile), false, '卸载后构建产物必须被清出 require.cache（这是"无残留"的真实效果）')
  } finally {
    await host.dispose().catch(() => undefined)
  }
})

test('端到端：untrusted 骨架能被构建并识别为不可信（无隔离后端时拒绝加载）', async () => {
  const pluginsRoot = path.join(scratch, `e2e-untrusted-${runId}`)
  const name = 'e2e-untrusted'

  const created = await runCli(['create', name, '--dir', pluginsRoot, '--trust', 'untrusted'])
  assert.equal(created.code, 0)
  assert.match(created.out, /独立子进程/, 'create 应当提示该插件会跑在子进程里')

  const pluginDir = path.join(pluginsRoot, name)
  await mkdir(path.join(pluginDir, 'dist'), { recursive: true })
  await build({
    entryPoints: [path.join(pluginDir, 'src', 'index.ts')],
    outfile: path.join(pluginDir, 'dist', 'index.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    tsconfig: path.join(repoRoot, 'tsconfig.base.json'),
    logLevel: 'silent',
  })

  const port = new RealLoaderPort()   // supportsIsolation = false
  const host = new PluginHost({ port, disposeTimeoutMs: 200, activationTimeoutMs: 5_000 })
  const entry = readGeneratedEntry(pluginDir, path.join(pluginDir, 'dist', 'index.cjs'))
  assert.equal(entry.manifest.trust, 'untrusted', 'create --trust untrusted 应当写进清单')

  try {
    await assert.rejects(host.load(entry), (error: unknown) => {
      assert.match(String(error), /没有可用的隔离后端|隔离后端/)
      return true
    })
    assert.deepEqual(port.fake.commands.size, 0, '被拒绝的不可信插件不该留下任何宿主侧注册')
    assert.equal(
      isCached(path.join(pluginDir, 'dist', 'index.cjs')),
      false,
      '被拒绝的不可信插件绝不能被加载（产物存在但不在缓存里，说明从未 require 过）',
    )
  } finally {
    await host.dispose().catch(() => undefined)
  }
})

test('端到端：生成骨架的 plugin.json 能通过 CLI 自己的 list 检查', async () => {
  const pluginsRoot = path.join(scratch, `e2e-list-${runId}`)
  const name = 'e2e-listed'
  assert.equal((await runCli(['create', name, '--dir', pluginsRoot])).code, 0)

  const listed = await runCli(['list', '--root', pluginsRoot])
  assert.equal(listed.code, 0, `生成的清单应当通过 list：${listed.err}`)
  assert.match(listed.out, new RegExp(name))
  assert.match(listed.out, /依赖图检查：0 条/)
})
