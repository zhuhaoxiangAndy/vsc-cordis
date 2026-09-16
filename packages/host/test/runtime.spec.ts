import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import * as path from 'node:path'
import { beforeEach, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 运行时装配层（`runtime.ts`）的契约测试 —— 用与 `bridge.spec.ts` 同一套 vscode stub
 * （`module.registerHooks` 把裸模块 `vscode` 解析到 `vscode-stub.ts`）。
 *
 * 覆盖的是**装配逻辑**：
 * - `initialize()`：发现（空根/带插件两种）→ 自动加载 → 启动日志；
 * - `statusLines()`：关键诊断行（隔离、公钥、队列深度、热重载、插件/服务/命令/问题计数）；
 * - `registerCommands()`：6 个宿主入口命令确实注册，且 `runPluginCommand` / `showStatus` /
 *   `unloadAll` 的真实行为（空列表提示、状态通道、卸载后回到干净状态）。
 *
 * ⚠️ 边界：它不覆盖 Node 权限模型、真实 Electron、真实文件监听（本测试刻意关掉热重载），
 * 这些仍由 `docs/acceptance-quick.md` 的手动验收负责。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const stubUrl = pathToFileURL(path.join(here, 'vscode-stub.ts')).href
/** 指向真实的 packages/host：里面有入库的验签公钥（用于断言状态面板的那一行）。 */
const hostPackageDir = path.resolve(here, '..')
const scratch = path.join(here, 'scratch')
const runId = `${process.pid}-${Date.now()}`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: stubUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const stub = (await import(stubUrl)) as typeof import('./vscode-stub.ts')
const { Runtime } = await import('../src/runtime.ts')

const output = {
  trace: (): void => undefined,
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
  appendLine: (): void => undefined,
  dispose: (): void => undefined,
}

function makeRuntime(globalStorage: string): InstanceType<typeof Runtime> {
  return new Runtime({
    output: output as never,
    extensionUri: { fsPath: hostPackageDir } as never,
    globalStorageUri: { fsPath: globalStorage } as never,
    hostVersion: '0.1.0',
    // 显式关闭隔离后端：不依赖 dist/isolated-worker.cjs 是否存在
    supportsIsolation: false,
  })
}

async function writePlugin(
  root: string,
  id: string,
  manifest: Record<string, unknown>,
  source: string,
): Promise<void> {
  const dir = path.join(root, id)
  await mkdir(path.join(dir, 'dist'), { recursive: true })
  await writeFile(path.join(dir, 'dist', 'index.cjs'), source, 'utf8')
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

beforeEach(() => {
  stub.resetStub()
  // 默认：不扫真实目录、不自动加载、不开热重载；各用例按需覆盖
  stub.setConfig('vscordis', 'pluginRoots', [])
  stub.setConfig('vscordis', 'autoLoad', false)
  stub.setConfig('vscordis', 'hotReload', false)
})

test('runtime：initialize 在空插件根下完成；状态面板给出关键诊断行', async () => {
  const runtime = makeRuntime(path.join(scratch, `runtime-empty-${runId}`))
  await runtime.initialize()
  try {
    const lines = runtime.statusLines().join('\n')
    assert.match(lines, /隔离子进程：不可用/)
    assert.match(lines, /完整性校验：已配置验签公钥/, 'extensionUri 指向 packages/host，公钥在库里')
    assert.match(lines, /任务队列：深度 0（空闲）/)
    assert.match(lines, /热重载：关闭/)
    assert.match(lines, /插件（0）：/)
    assert.match(lines, /服务（0）：/)
    assert.match(lines, /活命令（0）：/)
    assert.match(lines, /发现的问题（0）：/)
  } finally {
    await runtime.dispose()
  }
})

test('runtime：注册 6 个入口命令；没有活命令时给出可操作提示；showStatus 打开状态通道', async () => {
  const runtime = makeRuntime(path.join(scratch, `runtime-cmds-${runId}`))
  await runtime.initialize()
  const disposables = runtime.registerCommands()
  try {
    const ids = [...stub.state.commands.keys()].filter((id) => id.startsWith('vscordis.')).sort()
    assert.deepEqual(ids, [
      'vscordis.loadPlugin',
      'vscordis.reloadPlugin',
      'vscordis.runPluginCommand',
      'vscordis.showStatus',
      'vscordis.unloadAll',
      'vscordis.unloadPlugin',
    ])

    await stub.commands.executeCommand('vscordis.runPluginCommand')
    assert.ok(
      stub.state.messages.some((message) => message.includes('当前没有可运行的插件命令')),
      `应当给出可操作提示，实际消息：${stub.state.messages.join(' | ')}`,
    )

    await stub.commands.executeCommand('vscordis.showStatus')
    const statusChannel = stub.state.outputChannels.find((channel) => channel.name === 'VSCordis 状态')
    assert.ok(statusChannel !== undefined, 'showStatus 应当创建状态输出通道')
    assert.equal(statusChannel.shown, true, '状态通道应当被显示')
    assert.ok(statusChannel.lines.some((line) => line.includes('VSCordis 运行时状态')))
  } finally {
    for (const disposable of disposables) disposable.dispose()
    await runtime.dispose()
  }
})

test('runtime：从磁盘发现 → 自动加载 → 状态面板 → unloadAll，全链路装配正确', async () => {
  const pluginRoot = path.join(scratch, `runtime-plugins-${runId}`)
  await writePlugin(
    pluginRoot,
    'assemble',
    { permissions: ['vscode:commands.register'] },
    `module.exports = {
       activate(ctx) {
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('assemble.run', () => 'ok'),
           (d) => d.dispose(),
           'cmd',
         )
       },
     }\n`,
  )
  stub.setConfig('vscordis', 'pluginRoots', [pluginRoot])
  stub.setConfig('vscordis', 'autoLoad', true)

  const runtime = makeRuntime(path.join(scratch, `runtime-storage-${runId}`))
  runtime.registerCommands()
  await runtime.initialize()
  try {
    assert.equal(runtime.host.view('assemble')?.state, 'active')
    assert.deepEqual(
      runtime.bridge.livePluginCommands().map((info) => info.command),
      ['assemble.run'],
    )
    const lines = runtime.statusLines().join('\n')
    assert.match(lines, /插件（1）：/)
    assert.match(lines, /active/)
    assert.match(lines, /effects=\d+/)

    await stub.commands.executeCommand('vscordis.unloadAll')
    assert.deepEqual(runtime.host.list(), [])
    assert.deepEqual(runtime.bridge.livePluginCommands(), [])
  } finally {
    await runtime.dispose()
  }
})

test('runtime：同进程 ctx.async 事件全链路（bridge 订阅 → stub 发射 → kernel 适配器 → 插件）', async () => {
  const pluginRoot = path.join(scratch, `runtime-async-${runId}`)
  await writePlugin(
    pluginRoot,
    'async-events',
    { permissions: ['vscode:commands.register', 'vscode:workspace.read'] },
    `module.exports = {
       activate: async (ctx) => {
         let lastEditor = 'none'
         let lastSave = 'none'
         const editorSub = await ctx.async.onDidChangeActiveTextEditor((document) => {
           lastEditor = document === undefined ? '<none>' : document.fsPath
         })
         const saveSub = await ctx.async.onDidSaveTextDocument(async (document) => {
           lastSave = await document.getText()
         })
         ctx.effect(() => editorSub, (d) => d.dispose(), 'sub:editor')
         ctx.effect(() => saveSub, (d) => d.dispose(), 'sub:save')
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('ctxasync.editor', () => lastEditor),
           (d) => d.dispose(),
           'cmd:editor',
         )
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('ctxasync.save', () => lastSave),
           (d) => d.dispose(),
           'cmd:save',
         )
       },
     }\n`,
  )
  stub.setConfig('vscordis', 'pluginRoots', [pluginRoot])
  stub.setConfig('vscordis', 'autoLoad', true)

  const runtime = makeRuntime(path.join(scratch, `runtime-async-storage-${runId}`))
  await runtime.initialize()
  try {
    // 这条断言本身就是回归：曾把 onDidChangeActiveTextEditor 错放在 workspace 下，
    // 于是 ctx.async.onDidChangeActiveTextEditor 在 activate 里抛 TypeError → 插件 failed。
    assert.equal(runtime.host.view('async-events')?.state, 'active', '事件订阅失败时插件会进入 failed')
    assert.equal(stub.state.activeEditorListeners.size, 1, 'bridge 应当订阅活动编辑器事件')
    assert.equal(stub.state.saveListeners.size, 1, 'bridge 应当订阅保存事件')

    stub.emitActiveEditor({
      document: {
        uri: { toString: () => 'file:///w/cur.ts', fsPath: '/w/cur.ts' },
        languageId: 'typescript',
        lineCount: 1,
        version: 1,
        getText: () => 'cur',
      },
    })
    stub.emitSave('file:///w/saved.ts', 'saved text')
    await new Promise((resolve) => setTimeout(resolve, 10))

    assert.equal(await stub.commands.executeCommand('ctxasync.editor'), '/w/cur.ts')
    assert.equal(await stub.commands.executeCommand('ctxasync.save'), 'saved text')

    // "没有活动编辑器"必须原样传到插件，而不是被静默跳过
    stub.emitActiveEditor(undefined)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(await stub.commands.executeCommand('ctxasync.editor'), '<none>')

    await runtime.host.unloadAll()
    await runtime.host.settle()
    assert.equal(stub.state.activeEditorListeners.size, 0, '卸载后不得残留活动编辑器监听')
    assert.equal(stub.state.saveListeners.size, 0, '卸载后不得残留保存监听')
  } finally {
    await runtime.dispose()
  }
})
