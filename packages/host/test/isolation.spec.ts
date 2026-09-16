import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build, stop } from 'esbuild'
import { PluginHost, ServiceRegistry, type HostPort, type PluginEntry } from '@vscordis/kernel'
import type { LogLevel, Permission, PluginVscodeApi } from '@vscordis/sdk'
import { IsolatedPluginLoader, type IsolatedHostApi } from '../src/isolation/isolated-loader.ts'
import { buildIsolatedChildEnv } from '../src/isolation/environment.ts'
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
  readonly activeEditorSubscriptions = { active: 0, disposed: 0 }
  readonly #activeEditorForwarders = new Set<(payload: SerializedSaveEvent | undefined) => void>()
  readonly documents = new Map<number, string>()
  #nextDocumentHandle = 1

  /** 两种文档事件的载荷同形，这里共用构造，避免它们漂移。 */
  #makePayload(options: { uri?: string; text?: string }): SerializedSaveEvent {
    const handle = this.#nextDocumentHandle++
    const text = options.text ?? 'saved content'
    const uri = options.uri ?? 'file:///fake/doc.ts'
    this.documents.set(handle, text)
    return {
      uri,
      // 与真实 Uri 一致：fsPath 由 uri 推导，而不是各写各的（否则测试会拿到自相矛盾的数据）
      fsPath: uri.replace(/^file:\/\//, ''),
      languageId: 'typescript',
      lineCount: text.split('\n').length,
      version: 7,
      documentHandle: handle,
    }
  }

  /** 测试用：模拟一次"文档已保存"。 */
  emitSave(options: { uri?: string; text?: string } = {}): number {
    const payload = this.#makePayload(options)
    for (const forward of [...this.#saveForwarders]) forward(payload)
    return payload.documentHandle
  }

  /** 测试用：模拟一次"活动编辑器变化"；`null` 表示当前没有活动编辑器。 */
  emitActiveEditorChange(options: { uri?: string; text?: string } | null = {}): void {
    const payload = options === null ? undefined : this.#makePayload(options)
    for (const forward of [...this.#activeEditorForwarders]) forward(payload)
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

  subscribeActiveEditorChanges(
    _pluginId: string,
    forward: (payload: SerializedSaveEvent | undefined) => void,
  ): { dispose(): void } {
    this.activeEditorSubscriptions.active += 1
    this.#activeEditorForwarders.add(forward)
    return {
      dispose: () => {
        this.activeEditorSubscriptions.active -= 1
        this.activeEditorSubscriptions.disposed += 1
        this.#activeEditorForwarders.delete(forward)
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

async function makeHost(
  hostApi: FakeHostApi,
  overrides: { readonly disposeBudgetMs?: number; readonly inheritEnv?: boolean } = {},
): Promise<{ host: PluginHost; loader: IsolatedPluginLoader }> {
  const workerPath = await ensureWorker()
  // 注册表必须由测试显式创建并与 PluginHost **共用**：隔离加载器要往同一张表里
  // 注册远程服务，否则消费者登记的依赖边与提供者的条目就不在同一张图上。
  const registry = new ServiceRegistry()
  // 生产装配里 loader 的 onUnexpectedExit 回调要在 host 创建后才能拿到引用；
  // 测试用同一个延迟绑定，保证覆盖的是真实接线（而不是测试专用旁路）。
  let hostRef: PluginHost | undefined
  const loader = new IsolatedPluginLoader({
    hostApi,
    registry,
    workerPath,
    publicKeyPem: undefined,
    readyTimeoutMs: 15_000,
    disposeTimeoutMs: 3_000,
    disposeBudgetMs: overrides.disposeBudgetMs ?? 0,
    inheritEnv: overrides.inheritEnv ?? false,
    onUnexpectedExit: (pluginId, error) => {
      void hostRef?.reportExternalFailure(pluginId, error.message).catch(() => undefined)
    },
  })
  const port = new IsolationPort(loader)
  const host = new PluginHost({
    port,
    registry,
    disposeTimeoutMs: 4_000,
    disposeBudgetMs: overrides.disposeBudgetMs ?? 0,
  })
  hostRef = host
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

test('环境变量：默认只传白名单，inheritEnv=true 才完整继承（ADR-0021）', () => {
  const previous = process.env.VSCORDIS_ENV_PROBE
  process.env.VSCORDIS_ENV_PROBE = 'HOST_SECRET_VALUE'
  try {
    const filtered = buildIsolatedChildEnv(false)
    assert.equal(filtered.VSCORDIS_ENV_PROBE, undefined)
    assert.equal(filtered.ELECTRON_RUN_AS_NODE, '1')
    if (typeof process.env.PATH === 'string') assert.equal(filtered.PATH, process.env.PATH)

    const inherited = buildIsolatedChildEnv(true)
    assert.equal(inherited.VSCORDIS_ENV_PROBE, 'HOST_SECRET_VALUE')
    assert.equal(inherited.ELECTRON_RUN_AS_NODE, '1')
  } finally {
    if (previous === undefined) delete process.env.VSCORDIS_ENV_PROBE
    else process.env.VSCORDIS_ENV_PROBE = previous
  }
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

test('隔离边界：插件目录内指向目录外的 junction/symlink 在 fork 前被拒绝（ADR-0020）', async () => {
  const hostApi = new FakeHostApi()
  const outsideDir = path.join(scratch, 'junction-escape-outside')
  await mkdir(outsideDir, { recursive: true })
  await writeFile(path.join(outsideDir, 'secret.txt'), 'OUTSIDE_SECRET\n', 'utf8')

  const entry = await makeFixture('junction-escape', `module.exports = { activate() {} }\n`)
  const link = path.join(entry.root, 'leak')
  try {
    await symlink(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  const { host, loader } = await makeHost(hostApi)
  await assert.rejects(host.load(entry), (error: unknown) => {
    assert.match(String(error), /指向目录外的链接/)
    return true
  })
  assert.equal(
    loader.sessionsStarted,
    0,
    '必须在 fork 前拒绝：一个隔离会话都不能创建，否则恶意插件已经在子进程里跑过了',
  )
})

test('隔离边界：指向插件目录内部的链接不误伤（ADR-0020）', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'junction-inside',
    `module.exports = {
       activate(ctx) {
         const fs = require('node:fs')
         const path = require('node:path')
         ctx.log.info(fs.readFileSync(path.join(__dirname, '..', 'alias', 'inside.txt'), 'utf8').trim())
       },
     }\n`,
  )
  const realDir = path.join(entry.root, 'real')
  await mkdir(realDir, { recursive: true })
  await writeFile(path.join(realDir, 'inside.txt'), 'INSIDE_OK\n', 'utf8')
  const link = path.join(entry.root, 'alias')
  try {
    await symlink(realDir, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  const { host } = await makeHost(hostApi)
  try {
    await host.load(entry)
    await host.settle()
    assert.equal(host.view('junction-inside')?.state, 'active')
    assert.ok(
      hostApi.logs.some((log) => log.message.includes('INSIDE_OK')),
      'root 内链接指向的文件应当可读，扫描不能因“看见链接”就拒绝整个插件',
    )
  } finally {
    await host.unload('junction-inside')
    await host.settle()
  }
})

test('环境变量：实际 fork 默认不继承宿主敏感变量，inheritEnv=true 才继承（ADR-0021）', async () => {
  const previous = process.env.VSCORDIS_ENV_PROBE
  process.env.VSCORDIS_ENV_PROBE = 'HOST_SECRET_VALUE'
  try {
    const source = `module.exports = {
      activate(ctx) {
        ctx.log.info('env-probe:' + String(process.env.VSCORDIS_ENV_PROBE ?? '<missing>'))
      },
    }\n`

    const offApi = new FakeHostApi()
    const offEntry = await makeFixture('env-inherit-off', source)
    const { host: offHost } = await makeHost(offApi)
    try {
      await offHost.load(offEntry)
      await offHost.settle()
      await sleep(100)
      assert.ok(
        offApi.logs.some((log) => log.message.includes('env-probe:<missing>')),
        '默认白名单不得把 VSCORDIS_ENV_PROBE 传给子进程',
      )
    } finally {
      await offHost.unload('env-inherit-off')
      await offHost.settle()
    }

    const onApi = new FakeHostApi()
    const onEntry = await makeFixture('env-inherit-on', source)
    const { host: onHost } = await makeHost(onApi, { inheritEnv: true })
    try {
      await onHost.load(onEntry)
      await onHost.settle()
      await sleep(100)
      assert.ok(
        onApi.logs.some((log) => log.message.includes('env-probe:HOST_SECRET_VALUE')),
        'inheritEnv=true 时必须完整继承（逃生开关）',
      )
    } finally {
      await onHost.unload('env-inherit-on')
      await onHost.settle()
    }
  } finally {
    if (previous === undefined) delete process.env.VSCORDIS_ENV_PROBE
    else process.env.VSCORDIS_ENV_PROBE = previous
  }
})

test('隔离边界：畸形 IPC 消息只失败该会话，不能让宿主进程崩溃', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'bad-ipc',
    `module.exports = {
       activate() {
         process.send(null)
       },
     }\n`,
  )
  const { host, loader } = await makeHost(hostApi)
  await assert.rejects(host.load(entry), (error: unknown) => {
    assert.match(String(error), /违反隔离 IPC 协议|非法/)
    return true
  })
  assert.equal(loader.sessionsStarted, 1, '会话确实启动过（避免"从未启动"假绿）')
  await sleep(100)
  assert.equal(loader.activeSessions, 0, '畸形消息后子进程必须被终止')
})

test('隔离边界：激活后子进程异常退出，PluginHost 必须从 active 变 failed', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'crash-after-active',
    `module.exports = {
       activate(ctx) {
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('crash.now', () => process.exit(7)),
           (d) => d.dispose(),
           'cmd:crash.now',
         )
       },
     }\n`,
    { permissions: ['vscode:commands.register'] },
  )
  const { host, loader } = await makeHost(hostApi)
  try {
    await host.load(entry)
    await host.settle()
    assert.equal(host.view('crash-after-active')?.state, 'active', '哨兵：先确实激活成功')

    // 命令 handler 在子进程里执行 process.exit(7)：宿主侧在途调用必须失败，且状态转 failed
    await hostApi.executeCommand('crash-after-active', 'crash.now', []).catch(() => undefined)

    const deadline = Date.now() + 3_000
    while (Date.now() < deadline && host.view('crash-after-active')?.state !== 'failed') {
      await sleep(25)
    }
    assert.equal(host.view('crash-after-active')?.state, 'failed', '子进程崩溃后状态必须可见')
    assert.match(host.view('crash-after-active')?.error ?? '', /异常退出/)
    assert.equal(loader.activeSessions, 0, '崩溃后活跃会话必须归零')
  } finally {
    await host.unload('crash-after-active').catch(() => undefined)
    await host.settle()
  }
})

test('隔离边界：workspaceFolders 需要 vscode:workspace.read（隔离路径也要生效）', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'workspace-read-gate',
    `module.exports = {
       activate(ctx) {
         const folders = ctx.vscode.workspace.workspaceFolders
         ctx.log.info('folders:' + JSON.stringify(folders))
       },
     }\n`,
  )
  const { host } = await makeHost(hostApi)
  await assert.rejects(host.load(entry), (error: unknown) => {
    assert.match(String(error), /vscode:workspace\.read/)
    return true
  })
  assert.equal(host.view('workspace-read-gate')?.state, 'failed')
})

test('隔离边界：有 workspace.read 时 workspaceFolders 正常同步返回', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'workspace-read-ok',
    `module.exports = {
       activate(ctx) {
         const names = (ctx.vscode.workspace.workspaceFolders ?? []).map((folder) => folder.name)
         ctx.log.info('workspace-names:' + names.join(','))
       },
     }\n`,
    { permissions: ['vscode:workspace.read'] },
  )
  const { host } = await makeHost(hostApi)
  try {
    await host.load(entry)
    await host.settle()
    await sleep(100)
    assert.equal(host.view('workspace-read-ok')?.state, 'active')
    assert.ok(hostApi.logs.some((log) => log.message.includes('workspace-names:fake')))
  } finally {
    await host.unload('workspace-read-ok')
    await host.settle()
  }
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

test('ADR-0019：远程服务在同步 resolve 入口被拒绝（同进程 ctx.use 的底层路径）', async () => {
  const hostApi = new FakeHostApi()
  const provider = await makeFixture('svc-provider2', CLOCK_PROVIDER)

  const { host } = await makeHost(hostApi)
  try {
    await host.load(provider)
    await host.settle()

    // 真实 Runtime 会把同进程插件路由到 NodeModuleLoader；makeHost 里所有 fixture 都走隔离加载器，
    // 无法在同一个 host 里构造"同进程消费者"。但同进程插件 ctx.use 最终落到 registry.resolve，
    // 所以这里钉住权威拒绝点：远程服务不能被同步解析。
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

test('ADR-0019：隔离消费者的声明版本范围会落到宿主依赖边，并在取用点强制', async () => {
  const hostApi = new FakeHostApi()
  const provider = await makeFixture('svc-range-provider', CLOCK_PROVIDER)
  const consumer = await makeFixture('svc-range-consumer', CLOCK_CONSUMER, {
    permissions: ['vscode:commands.register'],
    dependencies: { clock: '^1.0.0' },
  })

  const { host } = await makeHost(hostApi)
  try {
    await host.load(provider)
    await host.load(consumer)
    await host.settle()
    assert.equal(host.view('svc-range-consumer')?.state, 'active')

    const edge = host.registry
      .snapshot()
      .edges.find((item) => item.consumer === 'svc-range-consumer' && item.service === 'clock')
    assert.equal(edge?.range, '^1.0.0', 'services.use 必须把消费者声明的范围登记到宿主的依赖边上')

    // 强制原语对远程服务同样生效（取用点复查的就是它）
    assert.doesNotThrow(() => host.registry.assertSatisfies('clock', '^1.0.0'))
    assert.throws(() => host.registry.assertSatisfies('clock', '^2.0.0'), (error: unknown) => {
      assert.match(String(error), /不满足范围/)
      assert.match(String(error), /放宽依赖方 plugin\.json#dependencies/)
      return true
    })
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('ADR-0019：声明范围不满足时隔离消费者停在 paused，且不为它启动子进程', async () => {
  const hostApi = new FakeHostApi()
  const provider = await makeFixture('svc-gate-provider', CLOCK_PROVIDER)
  const consumer = await makeFixture('svc-gate-consumer', CLOCK_CONSUMER, {
    permissions: ['vscode:commands.register'],
    dependencies: { clock: '^2.0.0' }, // 提供者是 1.0.0
  })

  const { host, loader } = await makeHost(hostApi)
  try {
    await host.load(provider)
    await host.load(consumer)
    await host.settle()

    assert.equal(host.view('svc-gate-consumer')?.state, 'paused')
    assert.deepEqual(host.view('svc-gate-consumer')?.missing, ['clock'])
    assert.equal(loader.activeSessions, 1, '范围不满足的消费者连子进程都不该起（只有提供者一个会话）')
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('ADR-0019：隔离提供者之间显式 last-wins 生效（冲突策略必须跨进程传递）', async () => {
  const hostApi = new FakeHostApi()
  const providerSource = (value: string, conflict?: boolean): string =>
    `module.exports = {
       activate(ctx) {
         ctx.provide('greeting', { hello: () => '${value}' }, { version: '1.0.0'${
           conflict === true ? ", conflict: 'last-wins'" : ''
         } })
       },
     }\n`
  const first = await makeFixture('svc-lw-a', providerSource('from-a'))
  const second = await makeFixture('svc-lw-b', providerSource('from-b', true))
  const consumer = await makeFixture(
    'svc-lw-consumer',
    `module.exports = {
       activate: async (ctx) => {
         const greeting = await ctx.async.useService('greeting')
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('greet.call', async () => await greeting.hello()),
           (d) => d.dispose(),
           'cmd',
         )
       },
     }\n`,
    { permissions: ['vscode:commands.register'] },
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(first)
    await host.load(consumer)
    await host.settle()
    assert.equal(await hostApi.executeCommand('svc-lw-consumer', 'greet.call', []), 'from-a')

    // B 显式 last-wins 接管：注册表换人，消费者被级联重启后拿到 B
    await host.load(second)
    await host.settle()
    const service = host.registry.snapshot().services.find((item) => item.name === 'greeting')
    assert.equal(service?.provider?.owner, 'svc-lw-b')
    assert.equal(service?.provider?.remote, true)
    assert.equal(await hostApi.executeCommand('svc-lw-consumer', 'greet.call', []), 'from-b')

    // 缺省仍是 exclusive：第三个提供者必须响亮失败，而不是悄悄覆盖
    const third = await makeFixture('svc-lw-c', providerSource('from-c'))
    await assert.rejects(host.load(third), (error: unknown) => {
      assert.match(String(error), /不得重复提供/)
      assert.match(String(error), /conflict: 'last-wins'/)
      return true
    })
    await host.settle()
    assert.equal(host.view('svc-lw-c')?.state, 'failed')
    assert.equal(host.registry.snapshot().services.find((item) => item.name === 'greeting')?.provider?.owner, 'svc-lw-b')
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('ADR-0019：被 last-wins 替换者卸载，不能删掉接管者的远程路由', async () => {
  const hostApi = new FakeHostApi()
  const providerSource = (value: string, conflict?: boolean): string =>
    `module.exports = {
       activate(ctx) {
         ctx.provide('greeting', { hello: () => '${value}' }, { version: '1.0.0'${
           conflict === true ? ", conflict: 'last-wins'" : ''
         } })
       },
     }\n`
  const replaced = await makeFixture('svc-lw-keep-a', providerSource('from-a'))
  const taker = await makeFixture('svc-lw-keep-b', providerSource('from-b', true))
  const consumer = await makeFixture(
    'svc-lw-keep-consumer',
    `module.exports = {
       activate: async (ctx) => {
         const greeting = await ctx.async.useService('greeting')
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('greet.keep', async () => await greeting.hello()),
           (d) => d.dispose(),
           'cmd',
         )
       },
     }\n`,
    { permissions: ['vscode:commands.register'] },
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(replaced)
    await host.load(taker)
    await host.load(consumer)
    await host.settle()
    assert.equal(await hostApi.executeCommand('svc-lw-keep-consumer', 'greet.keep', []), 'from-b')

    // 卸载被替换者 A：注册表与路由器都必须仍然指向接管者 B
    await host.unload('svc-lw-keep-a')
    await host.settle()
    const service = host.registry.snapshot().services.find((item) => item.name === 'greeting')
    assert.equal(service?.provider?.owner, 'svc-lw-keep-b')
    assert.equal(await hostApi.executeCommand('svc-lw-keep-consumer', 'greet.keep', []), 'from-b')
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('ADR-0019：隔离插件也不能自设 provide 的 remote 标记（响亮失败）', async () => {
  const hostApi = new FakeHostApi()
  const liar = await makeFixture(
    'svc-remote-liar',
    `module.exports = {
       activate(ctx) {
         ctx.provide('fake-remote', { ping: () => 'pong' }, { remote: true })
       },
     }\n`,
  )

  const { host } = await makeHost(hostApi)
  try {
    await assert.rejects(host.load(liar), (error: unknown) => {
      assert.match(String(error), /remote 标记由运行时写入/)
      return true
    })
    await host.settle()
    assert.equal(host.view('svc-remote-liar')?.state, 'failed')
    assert.equal(host.registry.size, 0, '失败后不能留下服务槽位')
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('ADR-0019：提供者子进程异常退出时，宿主持有的在途调用必须被拒绝（不能永远等待）', async () => {
  const hostApi = new FakeHostApi()
  const provider = await makeFixture(
    'svc-die-provider',
    `module.exports = {
       activate(ctx) {
         ctx.provide('dying', { hang: () => process.exit(7) }, { version: '1.0.0' })
       },
     }\n`,
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(provider)
    await host.settle()

    // 刻意**绕过插件依赖边**：直接拿宿主侧的远程代理。否则提供者退出会先级联暂停消费者、
    // 由"消费者会话被终止"来 reject —— 那样即使 exit 处理器漏了 #failAll，用例也照样通过（假绿）。
    const proxy = host.registry.resolveForAsync<{ hang(): Promise<unknown> }>('dying')

    // 用 race 而不是裸 await：没有 #failAll 时这个 Promise 永远不会 settle，
    // 裸 await 会让整轮测试挂死（"超时"而不是"失败"）。这里把它变成一条可读的断言。
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), 3_000)
    })
    try {
      const settled = await Promise.race([
        proxy.hang().then(
          () => ({ kind: 'resolved' as const }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        ),
        timeout,
      ])
      if (settled.kind === 'timeout') assert.fail('在途调用在提供者子进程崩溃后必须被拒绝，而不是永远挂起')
      if (settled.kind === 'resolved') assert.fail('调用不该成功：方法在应答前就带走了整个进程')
      assert.match(String(settled.error), /已退出/)
      assert.match(String(settled.error), /退出码 7/)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('ADR-0019：参数不可 structured clone 时，错误出现在调用点并给出路径', async () => {
  const hostApi = new FakeHostApi()
  const provider = await makeFixture(
    'svc-clone-provider',
    `module.exports = {
       activate(ctx) {
         ctx.provide('clock', { setHandler: (handler) => typeof handler }, { version: '1.0.0' })
       },
     }\n`,
  )
  const consumer = await makeFixture(
    'svc-clone-consumer',
    `module.exports = {
       activate: async (ctx) => {
         const clock = await ctx.async.useService('clock')
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('clone.call', async () =>
             await clock.setHandler({ onTick: () => 1 })),
           (d) => d.dispose(),
           'cmd',
         )
       },
     }\n`,
    { permissions: ['vscode:commands.register'], dependencies: { clock: '^1.0.0' } },
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(provider)
    await host.load(consumer)
    await host.settle()

    // 子进程侧的代理：错误必须说清"哪个方法、第几个参数、哪条路径、为什么"
    await assert.rejects(
      hostApi.executeCommand('svc-clone-consumer', 'clone.call', []),
      (error: unknown) => {
        const text = String(error)
        assert.match(text, /方法 "setHandler" 的第 0 个参数/)
        assert.match(text, /\.onTick/)
        assert.match(text, /是函数/)
        return true
      },
    )

    // 宿主侧的代理（同进程消费者走的就是它）：同样的前置校验，而不是把 DataCloneError 甩出去
    const proxy = host.registry.resolveForAsync<{ setHandler(handler: unknown): Promise<unknown> }>('clock')
    await assert.rejects(proxy.setHandler({ onTick: () => 1 }), /第 0 个参数/)
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('ADR-0019：返回值不可 structured clone 时，错误指出服务、方法与"返回值"', async () => {
  const hostApi = new FakeHostApi()
  const provider = await makeFixture(
    'svc-clone-ret-provider',
    `module.exports = {
       activate(ctx) {
         ctx.provide('clock', { makeHandler: () => ({ onTick: () => 1 }) }, { version: '1.0.0' })
       },
     }\n`,
  )
  const consumer = await makeFixture(
    'svc-clone-ret-consumer',
    `module.exports = {
       activate: async (ctx) => {
         const clock = await ctx.async.useService('clock')
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('clone.ret', async () => await clock.makeHandler()),
           (d) => d.dispose(),
           'cmd',
         )
       },
     }\n`,
    { permissions: ['vscode:commands.register'], dependencies: { clock: '^1.0.0' } },
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(provider)
    await host.load(consumer)
    await host.settle()

    await assert.rejects(
      hostApi.executeCommand('svc-clone-ret-consumer', 'clone.ret', []),
      (error: unknown) => {
        const text = String(error)
        assert.match(text, /方法 "makeHandler" 的返回值/)
        assert.match(text, /\.onTick/)
        assert.match(text, /是函数/)
        return true
      },
    )
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

// ————————————————————————————————— ADR-0015：整栈回收预算

test('ADR-0015：隔离插件的回收预算随 activate 下发给子进程（超预算后跳过并留下记录）', async () => {
  const hostApi = new FakeHostApi()
  const fixture = await makeFixture(
    'budget-child',
    `module.exports = {
       activate(ctx) {
         // LIFO：后登记的先回收。fast 排在挂死项后面，预算被吃光后它应当被**跳过**。
         ctx.onDispose(() => undefined, 'fast')
         ctx.onDispose(() => new Promise(() => {}), 'hang')
       },
     }\n`,
  )

  const { host } = await makeHost(hostApi, { disposeBudgetMs: 60 })
  try {
    await host.load(fixture)
    await host.settle()

    const started = Date.now()
    await host.unload('budget-child')
    await host.settle()
    const elapsed = Date.now() - started

    // 没有预算时这里会等满单项超时（3s）才轮到 fast；有预算必须远快于它。
    assert.ok(elapsed < 2_000, `隔离插件卸载必须受预算约束，实际 ${elapsed}ms`)
    const logs = hostApi.logs.map((entry) => entry.message).join('\n')
    assert.match(logs, /预算耗尽/)
    assert.match(logs, /fast/, '被跳过的项必须留下可检索的记录（不能静默 break）')
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

// ————————————————————————————————— ADR-0018 扩展：活动编辑器事件

test('ADR-0018：隔离插件订阅活动编辑器变化（含"没有活动编辑器"），且与保存事件互不污染', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'editor-plugin',
    `module.exports = {
       activate: async (ctx) => {
         let lastSave = 'none'
         let lastEditor = 'none'
         const save = await ctx.async.onDidSaveTextDocument(async (d) => {
           lastSave = await d.getText()
         })
         const editor = await ctx.async.onDidChangeActiveTextEditor(async (d) => {
           // undefined 是"没有活动编辑器"这个事实本身，必须原样传到这里
           lastEditor = d === undefined ? '<none>' : [d.fsPath, d.languageId, await d.getText()].join('|')
         })
         ctx.effect(() => save, (d) => d.dispose(), 'async:save')
         ctx.effect(() => editor, (d) => d.dispose(), 'async:editor')
         ctx.effect(() => ctx.vscode.commands.registerCommand('ev.save', () => lastSave), (d) => d.dispose(), 'cmd:save')
         ctx.effect(() => ctx.vscode.commands.registerCommand('ev.editor', () => lastEditor), (d) => d.dispose(), 'cmd:editor')
       },
     }\n`,
    { permissions: ['vscode:commands.register', 'vscode:workspace.read'] },
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(entry)
    await host.settle()
    assert.equal(hostApi.saveSubscriptions.active, 1)
    assert.equal(hostApi.activeEditorSubscriptions.active, 1)

    // 保存事件只喂给保存监听器
    hostApi.emitSave({ uri: 'file:///w/saved.ts', text: 'saved text' })
    await sleep(250)
    assert.equal(await hostApi.executeCommand('editor-plugin', 'ev.save', []), 'saved text')
    assert.equal(await hostApi.executeCommand('editor-plugin', 'ev.editor', []), 'none', '保存事件不该污染活动编辑器监听器')

    // 活动编辑器事件只喂给编辑器监听器
    hostApi.emitActiveEditorChange({ uri: 'file:///w/current.ts', text: 'current text' })
    await sleep(250)
    assert.equal(await hostApi.executeCommand('editor-plugin', 'ev.editor', []), '/w/current.ts|typescript|current text')
    assert.equal(await hostApi.executeCommand('editor-plugin', 'ev.save', []), 'saved text', '活动编辑器事件不该污染保存监听器')

    // 没有活动编辑器：回调收到 undefined，而不是"事件没发生"
    hostApi.emitActiveEditorChange(null)
    await sleep(250)
    assert.equal(await hostApi.executeCommand('editor-plugin', 'ev.editor', []), '<none>')
  } finally {
    await host.unload('editor-plugin')
    await host.settle()
  }

  assert.equal(hostApi.saveSubscriptions.active, 0, '卸载后不得残留保存事件订阅')
  assert.equal(hostApi.activeEditorSubscriptions.active, 0, '卸载后不得残留活动编辑器订阅')
  assert.equal(hostApi.saveSubscriptions.disposed, 1)
  assert.equal(hostApi.activeEditorSubscriptions.disposed, 1)
})

test('ADR-0018：隔离插件订阅活动编辑器变化需要 vscode:workspace.read 权限', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'editor-no-perm',
    `module.exports = {
       activate: async (ctx) => {
         await ctx.async.onDidChangeActiveTextEditor(() => undefined)
       },
     }\n`,
    { permissions: [] },
  )

  const { host } = await makeHost(hostApi)
  await assert.rejects(host.load(entry), (error: unknown) => {
    assert.match(String(error), /未获得权限 "vscode:workspace\.read"/)
    return true
  })
  assert.equal(hostApi.activeEditorSubscriptions.active, 0, '被拒绝的订阅不该在宿主侧留下监听器')
})

test('ADR-0018：活动编辑器的同步入口在隔离模式下抛错并指向 ctx.async 替代路径', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'editor-sync-entry',
    `module.exports = {
       activate(ctx) {
         let message = 'none'
         try {
           ctx.vscode.window.onDidChangeActiveTextEditor(() => undefined)
         } catch (error) {
           message = String(error && error.message ? error.message : error)
         }
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('editor.syncError', () => message),
           (d) => d.dispose(),
           'cmd',
         )
       },
     }\n`,
    { permissions: ['vscode:commands.register'] },
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(entry)
    await host.settle()
    const message = String(await hostApi.executeCommand('editor-sync-entry', 'editor.syncError', []))
    assert.match(message, /`ctx\.vscode\.window\.onDidChangeActiveTextEditor` 在隔离模式下不可用/)
    // 只告诉用户"不行"而不告诉"那该怎么办"是半个答案
    assert.match(message, /ctx\.async\.onDidChangeActiveTextEditor/)
    assert.match(message, /undefined/)
    assert.match(message, /ADR-0018/)
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

// ————————————————————————————————— ADR-0019 补齐：命令方向 + 代际锚定

test('ADR-0019：命令参数不可 structured clone 时，错误出现在调用点并给出路径', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'cmd-clone-args',
    `module.exports = {
       activate(ctx) {
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('clone.cmd', (arg) => typeof arg),
           (d) => d.dispose(),
           'cmd',
         )
       },
     }\n`,
    { permissions: ['vscode:commands.register'] },
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(entry)
    await host.settle()

    await assert.rejects(
      hostApi.executeCommand('cmd-clone-args', 'clone.cmd', [{ onTick: () => 1 }]),
      (error: unknown) => {
        const text = String(error)
        assert.match(text, /命令 "clone\.cmd" 的第 0 个参数/)
        assert.match(text, /\.onTick/)
        assert.match(text, /是函数/)
        return true
      },
    )
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('ADR-0019：命令返回值不可 structured clone 时，错误指出命令与返回值路径', async () => {
  const hostApi = new FakeHostApi()
  const entry = await makeFixture(
    'cmd-clone-result',
    `module.exports = {
       activate(ctx) {
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('clone.badret', () => ({ onTick: () => 1 })),
           (d) => d.dispose(),
           'cmd',
         )
       },
     }\n`,
    { permissions: ['vscode:commands.register'] },
  )

  const { host } = await makeHost(hostApi)
  try {
    await host.load(entry)
    await host.settle()

    await assert.rejects(
      hostApi.executeCommand('cmd-clone-result', 'clone.badret', []),
      (error: unknown) => {
        const text = String(error)
        assert.match(text, /命令 "clone\.badret" 的返回值/)
        assert.match(text, /\.onTick/)
        assert.match(text, /是函数/)
        return true
      },
    )
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('ADR-0019：last-wins 换人后，旧代理必须响亮失败而不是静默调用新提供者', async () => {
  const hostApi = new FakeHostApi()
  const providerSource = (value: string, conflict?: boolean): string =>
    `module.exports = {
       activate(ctx) {
         ctx.provide('greeting', { hello: () => '${value}' }, { version: '1.0.0'${
           conflict === true ? ", conflict: 'last-wins'" : ''
         } })
       },
     }\n`
  const first = await makeFixture('svc-anchor-a', providerSource('from-a'))
  const second = await makeFixture('svc-anchor-b', providerSource('from-b', true))

  const { host } = await makeHost(hostApi)
  try {
    await host.load(first)
    await host.settle()

    // 旧代理：在 A 这一代取用（宿主侧代理，锚定了代际 token）
    const stale = host.registry.resolveForAsync<{ hello(): Promise<string> }>('greeting')
    assert.equal(await stale.hello(), 'from-a')

    await host.load(second)
    await host.settle()

    // 新取用拿到 B
    assert.equal(
      await host.registry.resolveForAsync<{ hello(): Promise<string> }>('greeting').hello(),
      'from-b',
    )

    // 旧代理必须明确失败：它锚定的是 A 那一代，不能悄悄把调用路由到 B
    await assert.rejects(stale.hello(), (error: unknown) => {
      const text = String(error)
      assert.match(text, /已被替换（last-wins）/)
      assert.match(text, /ctx\.async\.useService/)
      return true
    })
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

// ————————————————————————————————— ADR-0019 能力矩阵：跨模式后果

test('ADR-0019：同进程提供者无法被隔离消费者取用 —— 响亮失败并给出两条出路', async () => {
  const hostApi = new FakeHostApi()
  const consumer = await makeFixture(
    'inproc-target-consumer',
    `module.exports = {
       activate: async (ctx) => {
         await ctx.async.useService('clock')
       },
     }\n`,
    { dependencies: { clock: '^1.0.0' } },
  )

  const { host, loader } = await makeHost(hostApi)
  try {
    // 直接在注册表里放一个 remote=false 的提供者：等价于同进程（trusted）插件提供的服务
    host.registry.provide('trusted-inproc-provider', 'clock', { now: () => 'live' }, { version: '1.0.0' })

    await assert.rejects(host.load(consumer), (error: unknown) => {
      const text = String(error)
      assert.match(text, /同进程/)
      // 两条出路都要写清楚：只告诉用户"不行"是半个答案
      assert.match(text, /把提供者也改成 trust: untrusted/)
      assert.match(text, /让消费者改用 trust: trusted/)
      return true
    })
    await host.settle()
    assert.equal(host.view('inproc-target-consumer')?.state, 'failed')

    // 终态是 failed（不是 paused）：paused 意味着"等提供者回来"，
    // 而同进程提供者永远不会变成可跨进程取用的形态。
    for (let attempt = 0; attempt < 40 && loader.activeSessions > 0; attempt += 1) {
      await sleep(25)
    }
    assert.equal(loader.activeSessions, 0, '取用被拒绝后子进程必须退出，不能挂着')
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('ADR-0019：同进程提供者以 last-wins 接管远程服务后，隔离消费者恢复时响亮失败', async () => {
  const hostApi = new FakeHostApi()
  const provider = await makeFixture('cross-remote-provider', CLOCK_PROVIDER)
  const consumer = await makeFixture('cross-mode-consumer', CLOCK_CONSUMER, {
    permissions: ['vscode:commands.register'],
    dependencies: { clock: '^1.0.0' },
  })

  const { host } = await makeHost(hostApi)
  try {
    await host.load(provider)
    await host.load(consumer)
    await host.settle()
    assert.equal(
      await hostApi.executeCommand('cross-mode-consumer', 'svc.now', []),
      'now-from-provider-child',
    )

    // 同进程提供者以 last-wins 接管：注册表里换成 remote=false 的活对象
    const takeover = host.registry.provide(
      'trusted-takeover',
      'clock',
      { now: async () => 'from-trusted' },
      { version: '1.0.0', conflict: 'last-wins' },
    )
    await host.settle()

    // 消费者被级联暂停后尝试恢复 → 在取用点再次撞上"同进程提供者"的拒绝 → failed
    const view = host.view('cross-mode-consumer')
    assert.equal(view?.state, 'failed', `诊断：state=${view?.state} error=${view?.error ?? '-'}`)
    assert.match(view?.error ?? '', /同进程/)
    assert.match(view?.error ?? '', /trust: trusted/)

    const info = host.registry.providerInfo('clock')
    assert.equal(info?.owner, 'trusted-takeover')
    assert.equal(info?.remote, false, '接管者是同进程的，注册表必须如实标记')

    // 撤销接管者：被替换的远程提供者**不会**自动复位（与同进程 last-wins 的语义一致）
    takeover.dispose()
    await host.settle()
    assert.equal(host.registry.canResolve('clock'), false)
    assert.equal(host.view('cross-remote-provider')?.state, 'active', '被替换者仍活着，但不会自动复位')
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.settle()
  }
})

test('ADR-0019：隔离提供者可以 last-wins 接管同进程提供者（消费者走异步面可用）', async () => {
  const hostApi = new FakeHostApi()
  const provider = await makeFixture(
    'cross-reverse-provider',
    `module.exports = {
       activate(ctx) {
         ctx.provide('clock', { now: () => 'from-isolated' }, { version: '1.0.0', conflict: 'last-wins' })
       },
     }\n`,
  )
  const consumer = await makeFixture('cross-reverse-consumer', CLOCK_CONSUMER, {
    permissions: ['vscode:commands.register'],
    dependencies: { clock: '^1.0.0' },
  })

  const { host } = await makeHost(hostApi)
  try {
    // 先放一个同进程提供者（remote=false），再由隔离提供者显式接管
    host.registry.provide('trusted-original', 'clock', { now: () => 'from-trusted' }, { version: '1.0.0' })
    await host.load(provider)
    await host.settle()

    const info = host.registry.providerInfo('clock')
    assert.equal(info?.owner, 'cross-reverse-provider')
    assert.equal(info?.remote, true, '隔离提供者接管后必须标记为远程')

    await host.load(consumer)
    await host.settle()
    assert.equal(
      await hostApi.executeCommand('cross-reverse-consumer', 'svc.now', []),
      'from-isolated',
    )
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
