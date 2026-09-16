import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build, stop } from 'esbuild'
import { PluginHost, ServiceRegistry, type HostPort, type PluginEntry } from '@vscordis/kernel'
import type { LogLevel, Permission, PluginVscodeApi } from '@vscordis/sdk'
import { IsolatedPluginLoader, type IsolatedHostApi } from '../src/isolation/isolated-loader.ts'
import { buildExecArgv } from '../src/isolation/permissions.ts'
import type { SerializedSaveEvent, SerializedWorkspaceFolder } from '../src/isolation/protocol.ts'

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

  // ————————————————————————————————— M4c：配置与状态栏项

  /** 全限定键（`section.key`）→ 值。 */
  readonly config = new Map<string, unknown>()
  readonly statusBarItems = new Map<
    number,
    { pluginId: string; text: string; tooltip: string; command: string; visible: boolean }
  >()
  readonly disposedStatusBars: number[] = []
  readonly configSubscriptions = { active: 0, disposed: 0 }
  readonly #configListeners = new Set<() => void>()

  /** 测试用：改配置值并触发推送（模拟用户在设置里改了值）。 */
  setConfig(section: string, key: string, value: unknown): void {
    this.config.set(`${section}.${key}`, value)
    for (const listener of [...this.#configListeners]) listener()
  }

  async readConfiguration(
    _pluginId: string,
    section: string,
    keys: readonly string[],
  ): Promise<Readonly<Record<string, unknown>>> {
    const values: Record<string, unknown> = {}
    for (const key of keys) values[`${section}.${key}`] = this.config.get(`${section}.${key}`)
    return values
  }

  onDidChangeConfiguration(
    _pluginId: string,
    section: string,
    keys: readonly string[],
    listener: (values: Readonly<Record<string, unknown>>) => void,
  ): { dispose(): void } {
    this.configSubscriptions.active += 1
    const wrapped = (): void => {
      const values: Record<string, unknown> = {}
      for (const key of keys) values[`${section}.${key}`] = this.config.get(`${section}.${key}`)
      listener(values)
    }
    this.#configListeners.add(wrapped)
    return {
      dispose: () => {
        this.configSubscriptions.active -= 1
        this.configSubscriptions.disposed += 1
        this.#configListeners.delete(wrapped)
      },
    }
  }

  createStatusBarItem(pluginId: string, _alignment: number, _priority: number, initial: { text: string }): number {
    const handle = this.#nextHandle++
    this.statusBarItems.set(handle, { pluginId, text: initial.text, tooltip: '', command: '', visible: false })
    return handle
  }

  updateStatusBarItem(
    handle: number,
    patch: {
      text?: string
      tooltip?: string
      command?: string
      color?: string
      name?: string
      accessibilityInformation?: unknown
    },
  ): void {
    const item = this.statusBarItems.get(handle)
    if (item === undefined) return
    if (patch.text !== undefined) item.text = patch.text
    if (patch.tooltip !== undefined) item.tooltip = patch.tooltip
    if (patch.command !== undefined) item.command = patch.command
  }

  setStatusBarItemVisible(handle: number, visible: boolean): void {
    const item = this.statusBarItems.get(handle)
    if (item !== undefined) item.visible = visible
  }

  disposeStatusBarItem(handle: number): void {
    if (this.statusBarItems.delete(handle)) this.disposedStatusBars.push(handle)
  }

  // ————————————————————————————————— 事件订阅（ADR-0018）

  readonly saveSubscriptions = { active: 0, disposed: 0 }
  readonly #saveForwarders = new Set<(payload: SerializedSaveEvent) => void>()
  readonly documents = new Map<number, string>()
  #nextDocumentHandle = 1

  /** 测试用：模拟一次"文档已保存"。 */
  emitSave(options: { uri?: string; text?: string } = {}): number {
    const handle = this.#nextDocumentHandle++
    const text = options.text ?? 'saved content'
    const uri = options.uri ?? 'file:///fake/doc.ts'
    this.documents.set(handle, text)
    const payload: SerializedSaveEvent = {
      uri,
      // 与真实 Uri 一致：fsPath 由 uri 推导，而不是各写各的（否则测试会拿到自相矛盾的数据）
      fsPath: uri.replace(/^file:\/\//, ''),
      languageId: 'typescript',
      lineCount: text.split('\n').length,
      version: 7,
      documentHandle: handle,
    }
    for (const forward of [...this.#saveForwarders]) forward(payload)
    return handle
  }

  subscribeSaveEvents(_pluginId: string, forward: (payload: SerializedSaveEvent) => void): { dispose(): void } {
    this.saveSubscriptions.active += 1
    this.#saveForwarders.add(forward)
    return {
      dispose: () => {
        this.saveSubscriptions.active -= 1
        this.saveSubscriptions.disposed += 1
        this.#saveForwarders.delete(forward)
      },
    }
  }

  async readDocumentText(_pluginId: string, handle: number): Promise<string> {
    const text = this.documents.get(handle)
    if (text === undefined) throw new Error(`文档句柄 ${handle} 已过期`)
    return text
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
      dependencies: (manifest.dependencies ?? {}) as Readonly<Record<string, string>>,
      provides: [],
      configuration: (manifest.configuration ?? undefined) as
        | { readonly section: string; readonly keys: readonly string[] }
        | undefined,
      permissions: (full.permissions ?? []) as string[],
      trust: 'untrusted',
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
  // 注册表必须由测试显式创建并与 PluginHost **共用**：隔离加载器要往同一张表里
  // 注册远程服务，否则消费者登记的依赖边与提供者的条目就不在同一张图上。
  const registry = new ServiceRegistry()
  const loader = new IsolatedPluginLoader({
    hostApi,
    registry,
    workerPath,
    publicKeyPem: undefined,
    readyTimeoutMs: 15_000,
    disposeTimeoutMs: 3_000,
  })
  const port = new IsolationPort(loader)
  const host = new PluginHost({ port, registry, disposeTimeoutMs: 4_000 })
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
    const text = String(error)
    assert.match(text, /`ctx\.vscode\.workspace\.onDidSaveTextDocument` 在隔离模式下不可用/)
    // 断言里必须包含**替代路径**：只告诉用户"不行"而不告诉"那该怎么办"是半个答案
    assert.match(text, /ctx\.async\.onDidSaveTextDocument/)
    assert.match(text, /同步方法/)
    assert.match(text, /ADR-0018/)
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

// ————————————————————————————————— M4c：配置快照与状态栏项

test('M4c：隔离插件按声明同步读配置，配置变化由宿主推送过来（不是去问）', async () => {
  const hostApi = new FakeHostApi()
  hostApi.config.set('cfg-lab.greeting', 'hello-from-config')

  const entry = await makeFixture(
    'cfg-reader',
    `module.exports = {
       activate(ctx) {
         const api = ctx.vscode
         ctx.effect(
           () => api.commands.registerCommand('cfg.snapshot', () =>
             api.workspace.getConfiguration('cfg-lab').get('greeting', 'none')),
           (d) => d.dispose(),
           'cmd:snapshot',
         )
         ctx.effect(
           () => api.commands.registerCommand('cfg.undeclared', () =>
             api.workspace.getConfiguration('cfg-lab').get('not-declared', 'fallback')),
           (d) => d.dispose(),
           'cmd:undeclared',
         )
       },
     }\n`,
    {
      permissions: ['vscode:commands.register', 'vscode:workspace.config.read'],
      configuration: { section: 'cfg-lab', keys: ['greeting'] },
    },
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(entry)
    await host.settle()

    // get() 是**同步**的：在子进程里直接读本地快照，不需要等 RPC
    assert.equal(await hostApi.executeCommand('cfg-reader', 'cfg.snapshot', []), 'hello-from-config')

    // 改配置 → 宿主推送 → 缓存更新；注意命令是"执行时"才读的，所以这里能验证到推送生效
    hostApi.setConfig('cfg-lab', 'greeting', 'updated-by-push')
    await sleep(200)
    assert.equal(await hostApi.executeCommand('cfg-reader', 'cfg.snapshot', []), 'updated-by-push')

    // 未声明的键拿不到值，只能回落到默认值（并会告警一次）
    assert.equal(await hostApi.executeCommand('cfg-reader', 'cfg.undeclared', []), 'fallback')
    assert.ok(
      hostApi.logs.some((log) => log.message.includes('未声明的配置键')),
      '读未声明的键应当留下一条告警，而不是静默返回默认值',
    )

    assert.equal(hostApi.configSubscriptions.active, 1, '激活时应当建立一条配置订阅')
  } finally {
    await host.unload('cfg-reader')
    await host.settle()
  }

  assert.equal(hostApi.configSubscriptions.active, 0, '卸载后不得残留配置订阅')
  assert.equal(hostApi.configSubscriptions.disposed, 1)
})

test('M4c：隔离插件创建状态栏项——属性读回是同步的，变更会同步到宿主，卸载后 UI 被回收', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'statusbar',
    `module.exports = {
       activate(ctx) {
         const api = ctx.vscode
         const item = api.window.createStatusBarItem(1, 42)
         item.text = '$(sync) ready'
         item.tooltip = 'tooltip-text'
         item.command = 'statusbar.run'
         item.show()
         ctx.effect(
           () => api.commands.registerCommand('statusbar.readText', () => item.text),
           (d) => d.dispose(),
           'cmd:read',
         )
       },
     }\n`,
    { permissions: ['vscode:window.statusbar', 'vscode:commands.register'] },
  )

  const { host } = await makeHost(hostApi)
  await host.load(entry)
  await host.settle()

  // 本地镜像：刚设置的属性必须**立刻**能读回（否则就是"类型同步、实际异步"的假接口）
  assert.equal(await hostApi.executeCommand('statusbar', 'statusbar.readText', []), '$(sync) ready')

  await sleep(200)
  const handles = [...hostApi.statusBarItems.keys()]
  assert.equal(handles.length, 1)
  const item = hostApi.statusBarItems.get(handles[0] as number)
  assert.equal(item?.text, '$(sync) ready', '属性变更应当已经到宿主')
  assert.equal(item?.tooltip, 'tooltip-text')
  assert.equal(item?.command, 'statusbar.run')
  assert.equal(item?.visible, true, 'show() 应当已经生效')

  await host.unload('statusbar')
  await host.settle()
  assert.deepEqual(hostApi.disposedStatusBars, handles, '卸载后状态栏项必须被回收，不能留下点不动的僵尸 UI')
  assert.equal(hostApi.statusBarItems.size, 0)
})

test('M4c：状态栏项设置**未支持的属性**时响亮抛错，而不是静默无效', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'statusbar-unknown-prop',
    `module.exports = {
       activate(ctx) {
         const item = ctx.vscode.window.createStatusBarItem()
         item.backgroundColor = 'red'
       },
     }\n`,
    { permissions: ['vscode:window.statusbar'] },
  )

  const { host } = await makeHost(hostApi)
  await assert.rejects(host.load(entry), (error: unknown) => {
    const text = String(error)
    // 普通对象对未知属性赋值是**静默接受**的（不改 UI 也不报错），Proxy 就是为了堵这个洞
    assert.match(text, /不支持属性 "backgroundColor"/)
    assert.match(text, /支持的属性：text/)
    return true
  })
})

test('M4c/0018：隔离插件通过 ctx.async 订阅保存事件，拿到纯数据 + 可 await 的 getText', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'events-plugin',
    `module.exports = {
       activate: async (ctx) => {
         const api = ctx.vscode
         let last = 'none'
         const subscription = await ctx.async.onDidSaveTextDocument(async (document) => {
           // 正文按需跨进程取：这是**显式异步**的，不是"看起来同步"的代理
           const text = await document.getText()
           last = [document.uri, document.fsPath, document.languageId, document.lineCount, document.version, text].join('|')
         })
         ctx.effect(() => subscription, (d) => d.dispose(), 'async:save')
         ctx.effect(
           () => api.commands.registerCommand('events.last', () => last),
           (d) => d.dispose(),
           'cmd:last',
         )
       },
     }\n`,
    { permissions: ['vscode:commands.register', 'vscode:workspace.read'] },
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(entry)
    await host.settle()
    assert.equal(hostApi.saveSubscriptions.active, 1, '激活时应当在宿主侧建立订阅')

    hostApi.emitSave({ uri: 'file:///w/x.ts', text: 'hello world' })
    await sleep(250)

    assert.equal(
      await hostApi.executeCommand('events-plugin', 'events.last', []),
      'file:///w/x.ts|/w/x.ts|typescript|1|7|hello world',
      '事件应当被转发到子进程，且 getText() 能按句柄取回正文',
    )
  } finally {
    await host.unload('events-plugin')
    await host.settle()
  }

  assert.equal(hostApi.saveSubscriptions.active, 0, '卸载后不得残留宿主侧订阅')
  assert.equal(hostApi.saveSubscriptions.disposed, 1)
})

test('M4c/0018：隔离插件订阅保存事件需要 vscode:workspace.read 权限', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'events-no-perm',
    `module.exports = {
       activate: async (ctx) => {
         await ctx.async.onDidSaveTextDocument(() => undefined)
       },
     }\n`,
    { permissions: [] },
  )

  const { host } = await makeHost(hostApi)
  await assert.rejects(host.load(entry), (error: unknown) => {
    // 注意权限名外面有引号（PermissionDeniedError 的格式），正则要跟着它
    assert.match(String(error), /未获得权限 "vscode:workspace\.read"/)
    return true
  })
  assert.equal(hostApi.saveSubscriptions.active, 0, '被拒绝的订阅不该在宿主侧留下监听器')
})

test('M4c/0018：点号版本（ctx.vscode 上的同步 API）与 ctx.async 是两回事，不会互相污染', async () => {
  const hostApi = new FakeHostApi()
  // 同时用两种入口：同步那个应当抛错（并给出替代路径），异步那个应当正常工作
  const entry = await makeFixture(
    'both-apis',
    `module.exports = {
       activate: async (ctx) => {
         let syncError = 'none'
         try {
           ctx.vscode.workspace.onDidSaveTextDocument(() => undefined)
         } catch (error) {
           syncError = String(error && error.message ? error.message : error)
         }
         const subscription = await ctx.async.onDidSaveTextDocument(() => undefined)
         ctx.effect(() => subscription, (d) => d.dispose(), 'async:save')
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('both.syncError', () => syncError),
           (d) => d.dispose(),
           'cmd',
         )
       },
     }\n`,
    { permissions: ['vscode:commands.register', 'vscode:workspace.read'] },
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(entry)
    await host.settle()
    assert.equal(host.view('both-apis')?.state, 'active')
    const message = String(await hostApi.executeCommand('both-apis', 'both.syncError', []))
    assert.match(message, /ctx\.async\.onDidSaveTextDocument/)
  } finally {
    await host.unload('both-apis')
    await host.settle()
  }
})

test('M4c：状态栏项需要权限，未授权时激活失败', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'statusbar-no-perm',
    `module.exports = {
       activate(ctx) {
         ctx.vscode.window.createStatusBarItem()
       },
     }\n`,
    { permissions: [] },
  )

  const { host } = await makeHost(hostApi)
  await assert.rejects(host.load(entry), (error: unknown) => {
    assert.match(String(error), /未获得权限 vscode:window\.statusbar/)
    return true
  })
})

test('M4c/0019：隔离模式下 ctx.use 被拒绝，且错误信息给出 ctx.async.useService 这条替代路径', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'wants-service',
    `module.exports = {
       activate(ctx) {
         ctx.use('clock')
       },
     }\n`,
  )

  const { host } = await makeHost(hostApi)
  await assert.rejects(host.load(entry), (error: unknown) => {
    const text = String(error)
    assert.match(text, /不能用 `ctx\.use`/)
    // 关键：必须告诉用户"那该怎么办"。只说不行的错误是半个答案。
    assert.match(text, /ctx\.async\.useService/)
    assert.match(text, /trust: trusted/)
    return true
  })
})

// ————————————————————————————————— ADR-0019：跨进程服务

const CLOCK_PROVIDER = `module.exports = {
  activate(ctx) {
    ctx.provide('clock', {
      label: 'remote-clock',
      now: () => 'now-from-provider-child',
    }, { version: '1.0.0' })
  },
}\n`

const CLOCK_CONSUMER = `module.exports = {
  activate: async (ctx) => {
    const clock = await ctx.async.useService('clock')
    ctx.effect(
      () => ctx.vscode.commands.registerCommand('svc.now', async () => await clock.now()),
      (d) => d.dispose(),
      'cmd:now',
    )
  },
}\n`

test('ADR-0019：隔离插件提供服务 → 另一个隔离插件通过 ctx.async.useService 调用它的方法', async () => {
  const hostApi = new FakeHostApi()
  const provider = await makeFixture('svc-provider', CLOCK_PROVIDER)
  const consumer = await makeFixture('svc-consumer', CLOCK_CONSUMER, {
    permissions: ['vscode:commands.register'],
    dependencies: { clock: '^1.0.0' },
    provides: [],
  })

  const { host } = await makeHost(hostApi)
  try {
    await host.load(provider)
    await host.load(consumer)
    await host.settle()

    assert.equal(host.view('svc-provider')?.state, 'active')
    assert.equal(host.view('svc-consumer')?.state, 'active')

    assert.equal(
      await hostApi.executeCommand('svc-consumer', 'svc.now', []),
      'now-from-provider-child',
      '方法调用应当跨两个子进程完成：消费者 → 宿主 → 提供者',
    )

    // 服务进了宿主的注册表，并标记为远程
    const slot = host.registry.snapshot().services.find((service) => service.name === 'clock')
    assert.equal(slot?.provider?.owner, 'svc-provider')
    assert.equal(slot?.provider?.remote, true, '注册表必须知道它是远程服务，否则 ctx.use 会放行')

    // 提供者卸载 → 消费者应当被级联暂停（依赖边登记在宿主的注册表上）
    await host.unload('svc-provider')
    await host.settle()
    assert.equal(
      host.view('svc-consumer')?.state,
      'paused',
      `诊断：error=${host.view('svc-consumer')?.error ?? '-'} | ` +
        `logs=${hostApi.logs.map((entry) => entry.message).join(' ｜ ')}`,
    )
    assert.deepEqual(host.view('svc-consumer')?.missing, ['clock'])
    assert.equal(host.registry.size, 0, '提供者退出后注册表不该留下远程服务条目')
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('ADR-0019：同进程消费者用 ctx.use 取远程服务 → 明确拒绝（并指向异步面）', async () => {
  const hostApi = new FakeHostApi()
  const provider = await makeFixture('svc-provider2', CLOCK_PROVIDER)

  const { host, loader } = await makeHost(hostApi)
  // 让 port 按 trust 路由：同进程插件走 fake 的工厂表，隔离插件走真实子进程
  try {
    await host.load(provider)
    await host.settle()

    const fake = loader as unknown as { fake?: never }
    void fake
    // 直接在注册表上验证同步解析被拒绝（等价于同进程插件调用 ctx.use 时的结果）
    assert.throws(() => host.registry.resolve('clock'), (error: unknown) => {
      assert.match(String(error), /由隔离插件/)
      assert.match(String(error), /ctx\.async\.useService/)
      return true
    })
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('ADR-0019：远程服务的方法表让**不存在的方法**立刻报错，而不是跨进程往返', async () => {
  const hostApi = new FakeHostApi()
  const provider = await makeFixture('svc-provider3', CLOCK_PROVIDER)
  const consumer = await makeFixture(
    'svc-typo',
    `module.exports = {
       activate: async (ctx) => {
         const clock = await ctx.async.useService('clock')
         await clock.nwo()
       },
     }\n`,
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(provider)
    await host.settle()
    await assert.rejects(host.load(consumer), (error: unknown) => {
      const text = String(error)
      assert.match(text, /没有方法 "nwo"/)
      assert.match(text, /现在声明的方法|声明的方法：now/)
      return true
    })
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('ADR-0019：用同进程消费者取用远程服务时也必须走异步面（注册表层面拒绝同步解析）', async () => {
  const hostApi = new FakeHostApi()
  const provider = await makeFixture('svc-provider4', CLOCK_PROVIDER)
  const { host } = await makeHost(hostApi)
  try {
    await host.load(provider)
    await host.settle()

    // tryResolve 也必须拒绝：把远程服务当作"软依赖缺失"会静默走错分支
    assert.throws(() => host.registry.tryResolve('clock'), /由隔离插件/)
    // resolveForAsync 是给 ctx.async.useService 用的，它接受远程服务
    const instance = host.registry.resolveForAsync<{ now(): Promise<string> }>('clock')
    assert.equal(await instance.now(), 'now-from-provider-child')
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('M4c：未声明 configuration 的隔离插件读配置只拿默认值（并说明要声明）', async () => {
  const hostApi = new FakeHostApi()
  hostApi.config.set('cfg-lab.greeting', 'should-not-be-visible')

  const entry = await makeFixture(
    'cfg-undeclared-plugin',
    `module.exports = {
       activate(ctx) {
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('cfg.read', () =>
             ctx.vscode.workspace.getConfiguration('cfg-lab').get('greeting', 'default-value')),
           (d) => d.dispose(),
           'cmd',
         )
       },
     }\n`,
    { permissions: ['vscode:commands.register', 'vscode:workspace.config.read'] },
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(entry)
    await host.settle()
    assert.equal(
      await hostApi.executeCommand('cfg-undeclared-plugin', 'cfg.read', []),
      'default-value',
      '没有声明 configuration 时宿主不会预取，子进程只能给默认值',
    )
    assert.ok(
      hostApi.logs.some((log) => log.message.includes('未声明的配置键')),
      '应当告警提示作者去 plugin.json 里声明',
    )
  } finally {
    await host.unload('cfg-undeclared-plugin')
    await host.settle()
  }
})
