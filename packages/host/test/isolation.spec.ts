import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build, stop } from 'esbuild'
import { PluginHost, type HostPort, type PluginEntry } from '@vscordis/kernel'
import type { LogLevel, Permission, PluginVscodeApi } from '@vscordis/sdk'
import { IsolatedPluginLoader, type IsolatedHostApi } from '../src/isolation/isolated-loader.ts'
import { buildExecArgv } from '../src/isolation/permissions.ts'
import type { SerializedWorkspaceFolder } from '../src/isolation/protocol.ts'

/**
 * M4b 隔离的端到端测试：**真实子进程 + 真实 IPC + 真实 --permission 标志**。
 *
 * 这里没有 mock 进程边界 —— 下面每一条断言背后都是一个真的 node 子进程。
 * 之所以能做到，是因为隔离层刻意不 import `vscode`，宿主能力由 IsolatedHostApi 注入。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const scratch = path.join(here, 'scratch')
const fixturesRoot = path.join(scratch, 'isolated-fixtures')
const tsconfig = path.join(repoRoot, 'tsconfig.base.json')

let workerPromise: Promise<string> | undefined

/** 用 esbuild 现场构建引导脚本 —— 顺带验证它真的能被打成单文件 CJS。 */
function ensureWorker(): Promise<string> {
  workerPromise ??= (async () => {
    const outfile = path.join(scratch, 'isolated-worker.cjs')
    await mkdir(scratch, { recursive: true })
    await build({
      entryPoints: [path.join(here, '..', 'src', 'isolation', 'child-bootstrap.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      tsconfig,
      logLevel: 'silent',
    })
    // 关键：esbuild 的 JS API 会拉起一个常驻 service 子进程。
    // 不显式停掉它，测试文件进程就不会退出，`node --test` 会一直挂着（表现为"无输出的超时"）。
    await stop()
    return outfile
  })()
  return workerPromise
}

class FakeHostApi implements IsolatedHostApi {
  readonly commands = new Map<string, { pluginId: string; invoke: (args: readonly unknown[]) => Promise<unknown> }>()
  readonly messages: string[] = []
  readonly outputs = new Map<number, string[]>()
  readonly logs: { pluginId: string; level: LogLevel; message: string }[] = []
  #nextHandle = 1

  registerCommand(
    pluginId: string,
    command: string,
    invoke: (args: readonly unknown[]) => Promise<unknown>,
  ): { dispose(): void } {
    const record = { pluginId, invoke }
    this.commands.set(command, record)
    return {
      dispose: () => {
        if (this.commands.get(command) === record) this.commands.delete(command)
      },
    }
  }

  unregisterCommand(command: string): void {
    this.commands.delete(command)
  }

  async executeCommand(_pluginId: string, command: string, args: readonly unknown[]): Promise<unknown> {
    const record = this.commands.get(command)
    if (record === undefined) throw new Error(`command not found: ${command}`)
    return await record.invoke(args)
  }

  async showMessage(kind: string, message: string): Promise<string | undefined> {
    this.messages.push(`${kind}:${message}`)
    return undefined
  }

  createOutputChannel(_pluginId: string, _name: string): number {
    const handle = this.#nextHandle++
    this.outputs.set(handle, [])
    return handle
  }

  appendOutputLine(handle: number, line: string): void {
    this.outputs.get(handle)?.push(line)
  }

  disposeOutput(handle: number): void {
    this.outputs.delete(handle)
  }

  workspaceFolders(): readonly SerializedWorkspaceFolder[] {
    return [{ name: 'fake', index: 0, uri: 'file:///fake', fsPath: '/fake' }]
  }

  log(pluginId: string, level: LogLevel, message: string): void {
    this.logs.push({ pluginId, level, message })
  }
}

class IsolationPort implements HostPort {
  readonly platform = 'node' as const
  readonly supportsIsolation = true
  readonly logs: string[] = []
  readonly #loader: IsolatedPluginLoader

  constructor(loader: IsolatedPluginLoader) {
    this.#loader = loader
  }

  loadModule(entry: PluginEntry): ReturnType<IsolatedPluginLoader['load']> {
    return this.#loader.load(entry)
  }

  /** 隔离插件在子进程里构造自己的 ctx，宿主侧的 vscode 代理它根本用不到。 */
  createApi(): PluginVscodeApi {
    return {} as PluginVscodeApi
  }

  log(_level: LogLevel, message: string): void {
    this.logs.push(message)
  }
}

async function makeFixture(
  name: string,
  source: string,
  manifest: Record<string, unknown> = {},
): Promise<PluginEntry> {
  const dir = path.join(fixturesRoot, name)
  await mkdir(path.join(dir, 'dist'), { recursive: true })
  await writeFile(path.join(dir, 'dist', 'index.cjs'), source, 'utf8')
  const full = {
    id: name,
    name,
    version: '1.0.0',
    main: 'dist/index.cjs',
    trust: 'untrusted',
    permissions: [],
    ...manifest,
  }
  await writeFile(path.join(dir, 'plugin.json'), `${JSON.stringify(full, null, 2)}\n`, 'utf8')
  return {
    root: dir,
    mainPath: path.join(dir, 'dist', 'index.cjs'),
    source: 'workspace',
    manifest: {
      id: name,
      name,
      version: '1.0.0',
      main: 'dist/index.cjs',
      description: undefined,
      dependencies: {},
      provides: [],
      permissions: (full.permissions ?? []) as string[],
      trust: 'untrusted',
    },
  }
}

/** 与生产环境一致地组装：真实 PluginHost + 真实隔离加载器。 */
const createdHosts: PluginHost[] = []

/**
 * 兜底清理。任何一条测试只要漏了卸载插件，子进程就会活着并阻止测试进程退出
 * —— 表现为"所有断言都通过，但 node --test 永不返回"。这个钩子保证不会再现那种情况。
 */
after(async () => {
  for (const host of createdHosts) {
    await host.unloadAll().catch(() => undefined)
    await host.dispose().catch(() => undefined)
  }
  await stop()
})

async function makeHost(hostApi: FakeHostApi): Promise<{ host: PluginHost; loader: IsolatedPluginLoader }> {
  const workerPath = await ensureWorker()
  const loader = new IsolatedPluginLoader({
    hostApi,
    workerPath,
    publicKeyPem: undefined,
    readyTimeoutMs: 15_000,
    disposeTimeoutMs: 3_000,
  })
  const port = new IsolationPort(loader)
  const host = new PluginHost({ port, disposeTimeoutMs: 4_000 })
  createdHosts.push(host)
  return { host, loader }
}

// ————————————————————————————————— 纯单元：execArgv 推导

test('buildExecArgv：最小权限只放开引导脚本与插件目录', () => {
  const plan = buildExecArgv({
    workerPath: '/w/isolated-worker.cjs',
    pluginRoot: '/p/hello',
    permissions: new Set<Permission>(),
  })
  assert.deepEqual(plan.execArgv, [
    '--permission',
    '--allow-fs-read=/w/isolated-worker.cjs',
    '--allow-fs-read=/p/hello',
  ])
  assert.deepEqual(plan.warnings, [])
})

test('buildExecArgv：fs:write 只放开插件自己的目录，process:spawn 带降级警告', () => {
  const plan = buildExecArgv({
    workerPath: '/w/worker.cjs',
    pluginRoot: '/p/hello',
    permissions: new Set<Permission>(['fs:write', 'process:spawn', 'net']),
  })
  assert.ok(plan.execArgv.includes('--allow-fs-write=/p/hello'))
  assert.ok(plan.execArgv.includes('--allow-child-process'))
  // net 没有 Node 开关 —— 必须被显式警告，不能静默吞掉
  assert.equal(plan.warnings.length, 2)
  assert.match(plan.warnings.join('\n'), /没有\*\*网络开关\*\*|没有.*网络开关/)
})

test('buildExecArgv：关闭权限模型时给出明确的降级说明', () => {
  const plan = buildExecArgv({
    workerPath: '/w/worker.cjs',
    pluginRoot: '/p/hello',
    permissions: new Set<Permission>(),
    usePermissionModel: false,
  })
  assert.deepEqual(plan.execArgv, [])
  assert.match(plan.warnings.join('\n'), /隔离强度降级/)
})

// ————————————————————————————————— 端到端：真实子进程

test('隔离插件：注册命令 → 宿主执行 → 子进程 handler 求值 → 结果回传', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'good',
    `module.exports = {
       name: 'good',
       activate(ctx) {
         const channel = ctx.vscode.window.createOutputChannel('Good')
         channel.appendLine('activated')
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('good.echo', (value) => 'pong:' + String(value)),
           (d) => d.dispose(),
           'cmd:good.echo',
         )
         void ctx.vscode.window.showInformationMessage('good 已激活')
         ctx.log.info('hello from child')
       },
     }\n`,
    { permissions: ['vscode:commands.register', 'vscode:window.messages', 'vscode:window.output'] },
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(entry)
    await host.settle()
    assert.equal(host.view('good')?.state, 'active')

    // 关键：命令真的在宿主侧注册了，但 handler 活在子进程里
    assert.deepEqual([...hostApi.commands.keys()], ['good.echo'])

    const result = await hostApi.executeCommand('good', 'good.echo', ['x'])
    assert.equal(result, 'pong:x', '子进程里的 handler 应当被反向调用并把结果回传')

    // 输出通道先排队等句柄，再写入 —— 断言最终落到宿主侧
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.deepEqual([...hostApi.outputs.values()], [['activated']])
    assert.deepEqual(hostApi.messages, ['information:good 已激活'])
    assert.ok(hostApi.logs.some((entry) => entry.message.includes('hello from child')))
  } finally {
    await host.unload('good')
    await host.settle()
  }
})

test('隔离插件卸载：子进程退出，且宿主侧命令被撤销（M1 验收的隔离版）', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'lifecycle',
    `module.exports = {
       activate(ctx) {
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('lifecycle.ping', () => 'pong'),
           (d) => d.dispose(),
           'cmd',
         )
       },
       async deactivate(ctx) { ctx.log.info('child 正在停用') },
     }\n`,
    { permissions: ['vscode:commands.register'] },
  )

  const { host } = await makeHost(hostApi)
  await host.load(entry)
  await host.settle()
  assert.equal(host.view('lifecycle')?.state, 'active')
  assert.equal(hostApi.commands.size, 1)

  await host.unload('lifecycle')
  await host.settle()

  assert.deepEqual(hostApi.commands.size, 0, '子进程退出后宿主侧命令必须被撤销，否则会留下幽灵命令')
  assert.ok(
    hostApi.logs.some((entry) => entry.message.includes('child 正在停用')),
    '优雅停用应当先执行插件的 deactivate',
  )
})

test('隔离边界：子进程里没有 vscode 模块（这是真边界，不是约定）', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'reaches-vscode',
    `module.exports = {
       activate() {
         const vscode = require('vscode')
         void vscode
       },
     }\n`,
  )

  const { host } = await makeHost(hostApi)
  await assert.rejects(host.load(entry), (error: unknown) => {
    // 实测结果比预期更严：在 --permission 下，连 `require('vscode')` 的**模块解析**
    // 都会被权限模型挡住，于是拿到的是 ERR_ACCESS_DENIED 而不是 MODULE_NOT_FOUND。
    // 两种结局都说明"子进程里没有 vscode 可用"，这正是我们要的边界。
    assert.match(
      String(error),
      /Cannot find module 'vscode'|MODULE_NOT_FOUND|Access to this API has been restricted|ERR_ACCESS_DENIED/,
    )
    return true
  })
  assert.equal(host.view('reaches-vscode')?.state, 'failed')
})

test('隔离边界：Node 权限模型真的拦住了越界读（不是"靠约定"）', async () => {
  const hostApi = new FakeHostApi()
  // 仓库根的 package.json 在插件目录之外，必须读不到
  const outside = path.join(repoRoot, 'package.json')
  const entry = await makeFixture(
    'escapes-fs',
    `module.exports = {
       activate() {
         const fs = require('node:fs')
         const text = fs.readFileSync(${JSON.stringify(outside)}, 'utf8')
         void text
       },
     }\n`,
  )

  const { host } = await makeHost(hostApi)
  await assert.rejects(host.load(entry), (error: unknown) => {
    assert.match(String(error), /ERR_ACCESS_DENIED|Access to this API has been restricted/)
    return true
  })
})

test('隔离边界：未授权能力在宿主侧被拒绝（宿主的判定是权威的）', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'no-permission',
    `module.exports = {
       activate(ctx) {
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('no-permission.run', () => 1),
           (d) => d.dispose(),
           'cmd',
         )
       },
     }\n`,
    { permissions: [] },
  )

  const { host } = await makeHost(hostApi)
  await assert.rejects(host.load(entry), (error: unknown) => {
    assert.match(String(error), /未获得权限/)
    return true
  })
  assert.equal(hostApi.commands.size, 0, '被拒绝的注册不得留下任何痕迹')
})

test('隔离模式明确不支持的能力：响亮失败并说明原因，而不是给假接口', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'unsupported',
    `module.exports = {
       activate(ctx) {
         ctx.vscode.workspace.onDidSaveTextDocument(() => undefined)
       },
     }\n`,
  )

  const { host } = await makeHost(hostApi)
  await assert.rejects(host.load(entry), (error: unknown) => {
    assert.match(String(error), /M4c/)
    assert.match(String(error), /事件订阅/)
    return true
  })
})

test('隔离插件：越权访问网络被 require 拦截（防误用，非强制封禁）', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'net-blocked',
    `module.exports = {
       activate() {
         require('node:net')
       },
     }\n`,
  )

  const { host } = await makeHost(hostApi)
  await assert.rejects(host.load(entry), (error: unknown) => {
    assert.match(String(error), /网络访问被拒绝/)
    assert.match(String(error), /防误用/)
    return true
  })
})
