import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import * as path from 'node:path'
import { beforeEach, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EffectStack, PermissionDeniedError, type CreateApiDeps } from '@vscordis/kernel'
import type { Permission, PluginVscodeApi } from '@vscordis/sdk'

/**
 * 桥接层（`bridge.ts`）的**契约测试**：用 `module.registerHooks` 把裸模块 `vscode`
 * 解析到一个测试替身（`vscode-stub.ts`），于是可以在纯 Node 下验证：
 *
 * - 调用时刻鉴权（每个成员在**被调用时**校验权限）；
 * - 命令表记账（注册/注销、QuickPick 数据源、卸载后不留幽灵条目）；
 * - `create*` 返回值自动挂到 EffectStack 上（插件忘写 `ctx.effect` 也不泄漏）；
 * - 只读配置视图（没有 `config.write` 时 `update` 抛 PermissionDeniedError）；
 * - 事件订阅的建立与撤销。
 *
 * ⚠️ **边界（必须说清）**：这里覆盖的是桥接层**自己的逻辑**，不是真实 VSCode/Electron 行为。
 * `--permission` 是否可用、桥接在真实宿主里的表现，仍然只能由 `docs/acceptance-quick.md`
 * 的手动验收回答。这条测试**不允许**被宣传成"桥接层已被完整验证"。
 *
 * `registerHooks` 只影响本测试进程；`node --test` 每个测试文件一个子进程，不会外溢到别的用例。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const stubUrl = pathToFileURL(path.join(here, 'vscode-stub.ts')).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: stubUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

// 必须在 registerHooks 之后动态导入：静态 import 会先求值 bridge.ts（那时 'vscode' 还没被替换）
const stub = (await import(stubUrl)) as typeof import('./vscode-stub.ts')
const { VscodeBridge } = await import('../src/bridge.ts')

type BridgeOptions = ConstructorParameters<typeof VscodeBridge>[0]

const output = {
  trace: (): void => undefined,
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
  appendLine: (): void => undefined,
  dispose: (): void => undefined,
} as unknown as BridgeOptions['output']

const log: CreateApiDeps['log'] = {
  trace: (): void => undefined,
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
}

function makeBridge(): InstanceType<typeof VscodeBridge> {
  return new VscodeBridge({
    platform: 'node',
    supportsIsolation: false,
    output,
    loader: {
      load: () => {
        throw new Error('bridge.spec 不加载插件模块')
      },
    },
  })
}

/** 在**指定** bridge 上创建一个插件的受控 API（命令表是 bridge 实例级的，测试要能共用）。 */
function createApiOn(
  bridge: InstanceType<typeof VscodeBridge>,
  permissions: readonly Permission[],
  id = 'test-plugin',
): { stack: EffectStack; api: PluginVscodeApi } {
  const stack = new EffectStack()
  const api = bridge.createApi({
    id,
    permissions: new Set(permissions),
    effects: stack,
    log,
  })
  return { stack, api }
}

function makeApi(permissions: readonly Permission[] = []): {
  bridge: InstanceType<typeof VscodeBridge>
  stack: EffectStack
  api: PluginVscodeApi
} {
  const bridge = makeBridge()
  const { stack, api } = createApiOn(bridge, permissions)
  return { bridge, stack, api }
}

beforeEach(() => {
  stub.resetStub()
})

// ————————————————————————————————— 命令

test('bridge：registerCommand 进入 livePluginCommands，EffectStack 回收后注销（不留幽灵条目）', async () => {
  const { bridge, stack, api } = makeApi(['vscode:commands.register'])

  const disposable = api.commands.registerCommand('p.run', (value: unknown) => `ok:${String(value)}`)
  assert.deepEqual(bridge.livePluginCommands(), [{ command: 'p.run', owner: 'test-plugin' }])
  assert.equal(await stub.commands.executeCommand('p.run', 7), 'ok:7', 'stub 侧真的注册了 handler')

  // 插件自己提前 dispose：幂等，且从命令表消失
  disposable.dispose()
  disposable.dispose()
  assert.deepEqual(bridge.livePluginCommands(), [])
  assert.equal(stub.state.commands.has('p.run'), false)

  // 再注册一个，用 EffectStack 回收（模拟插件忘写 ctx.effect）
  api.commands.registerCommand('p.lazy', () => 1)
  await stack.dispose()
  assert.deepEqual(bridge.livePluginCommands(), [], 'EffectStack 回收后不得残留命令')
  assert.equal(stub.state.commands.has('p.lazy'), false, 'stub 侧的注册也要撤销（栈上登记了逆操作）')
})

test('bridge：没有 vscode:commands.register 权限时注册命令被拒绝（stub 侧不留痕）', () => {
  const { api } = makeApi([])

  assert.throws(() => api.commands.registerCommand('p.run', () => 1), PermissionDeniedError)
  assert.equal(stub.state.commands.has('p.run'), false)
})

test('bridge：executeCommand 的权限矩阵（execute / execute.any / 仅限插件命令）', async () => {
  // 1) 没有任何 execute 权限 → 拒绝
  const denied = makeApi([])
  await assert.rejects(Promise.resolve(denied.api.commands.executeCommand('anything')), PermissionDeniedError)

  // 2) 有 execute、但命令不是 vscordis 插件命令 → 拒绝，并提示 .any
  const restricted = makeApi(['vscode:commands.execute'])
  await assert.rejects(
    Promise.resolve(restricted.api.commands.executeCommand('workbench.action.reloadWindow')),
    (error: unknown) => {
      assert.match(String(error), /vscode:commands\.execute\.any/)
      return true
    },
  )
  assert.equal(stub.state.executed.length, 0, '被拒绝的调用不该到达真实 executeCommand')

  // 3) 有 execute + 命令由 vscordis 插件注册 → 放行
  //    命令表是 bridge 实例级的：注册者与执行者必须共用同一个 bridge（生产里也是同一个宿主）
  const shared = makeBridge()
  const registrar = createApiOn(shared, ['vscode:commands.register'], 'registrar')
  registrar.api.commands.registerCommand('p.run', () => 'ran')
  const executor = createApiOn(shared, ['vscode:commands.execute'], 'executor')
  await executor.api.commands.executeCommand('p.run')
  assert.deepEqual(stub.state.executed, [{ command: 'p.run', args: [] }])

  // 4) execute.any → 任意命令（含内建）放行
  const any = makeApi(['vscode:commands.execute.any'])
  await any.api.commands.executeCommand('workbench.action.reloadWindow', 1)
  assert.deepEqual(stub.state.executed.at(-1), { command: 'workbench.action.reloadWindow', args: [1] })
})

// ————————————————————————————————— 窗口：消息 / 状态栏 / 输出通道

test('bridge：窗口消息需要 vscode:window.messages', async () => {
  const denied = makeApi([])
  assert.throws(() => denied.api.window.showInformationMessage('hi'), PermissionDeniedError)
  assert.deepEqual(stub.state.messages, [])

  const allowed = makeApi(['vscode:window.messages'])
  await allowed.api.window.showInformationMessage('hi')
  await allowed.api.window.showWarningMessage('careful')
  await allowed.api.window.showErrorMessage('boom')
  assert.deepEqual(stub.state.messages, ['info:hi', 'warn:careful', 'error:boom'])
})

test('bridge：状态栏项幂等 dispose，输出通道随 EffectStack 回收', async () => {
  const { stack, api } = makeApi(['vscode:window.statusbar', 'vscode:window.output'])

  const item = api.window.createStatusBarItem()
  item.dispose()
  item.dispose()
  assert.equal(stub.state.statusBarItems[0]?.disposed, 1, '幂等：只真正 dispose 一次')

  api.window.createOutputChannel('X')
  await stack.dispose()
  assert.equal(stub.state.outputChannels[0]?.disposed, 1, '栈回收必须把输出通道一起 dispose')
})

test('bridge：状态栏/输出通道同样受权限约束', () => {
  const denied = makeApi([])
  assert.throws(() => denied.api.window.createStatusBarItem(), PermissionDeniedError)
  assert.throws(() => denied.api.window.createOutputChannel('X'), PermissionDeniedError)
  assert.equal(stub.state.statusBarItems.length, 0)
  assert.equal(stub.state.outputChannels.length, 0)
})

// ————————————————————————————————— 配置

test('bridge：只读配置视图 —— 无 config.write 时 update 抛 PermissionDeniedError', async () => {
  const read = makeApi(['vscode:workspace.config.read'])
  const config = read.api.workspace.getConfiguration('demo')
  assert.equal(config.get('missing', 'fallback'), 'fallback')
  assert.throws(() => config.update('k', 1), PermissionDeniedError)
  assert.deepEqual(stub.state.configUpdates, [], '被拒绝的写入不该到达真实配置')

  const write = makeApi(['vscode:workspace.config.read', 'vscode:workspace.config.write'])
  await write.api.workspace.getConfiguration('demo').update('k', 1)
  assert.deepEqual(stub.state.configUpdates, [{ section: 'demo', key: 'k', value: 1 }])
})

// ————————————————————————————————— 事件订阅

test('bridge：onDidSaveTextDocument 需要 workspace.read，且随 EffectStack 撤销', async () => {
  const denied = makeApi([])
  assert.throws(() => denied.api.workspace.onDidSaveTextDocument(() => undefined), PermissionDeniedError)
  assert.equal(stub.state.saveListeners.size, 0, '被拒绝的订阅不该建立监听')

  const { stack, api } = makeApi(['vscode:workspace.read'])
  const seen: string[] = []
  api.workspace.onDidSaveTextDocument((document) => {
    seen.push(document.uri.toString())
  })

  stub.emitSave('file:///a.ts')
  assert.deepEqual(seen, ['file:///a.ts'])

  await stack.dispose()
  stub.emitSave('file:///b.ts')
  assert.deepEqual(seen, ['file:///a.ts'], '栈回收后不得再收到事件')
  assert.equal(stub.state.saveListeners.size, 0)
})

test('bridge：onDidChangeActiveTextEditor 挂在 window 下（类型约定），需要 workspace.read，undefined 原样转发', async () => {
  const denied = makeApi([])
  assert.throws(() => denied.api.window.onDidChangeActiveTextEditor(() => undefined), PermissionDeniedError)

  const { stack, api } = makeApi(['vscode:workspace.read'])
  // 这条断言同时钉住一个真实缺陷：它曾被错放在 workspace 下，真实宿主里
  // kernel 的同进程适配器（vscode.window.onDidChangeActiveTextEditor）会拿到 undefined。
  assert.equal(typeof api.window.onDidChangeActiveTextEditor, 'function')
  assert.equal(
    (api.workspace as unknown as Record<string, unknown>).onDidChangeActiveTextEditor,
    undefined,
    '它不属于 workspace',
  )

  const seen: (string | undefined)[] = []
  api.window.onDidChangeActiveTextEditor((editor) => {
    seen.push(editor === undefined ? undefined : 'editor')
  })

  stub.emitActiveEditor(undefined)
  stub.emitActiveEditor({ document: { uri: { toString: () => 'file:///a.ts' } } })
  assert.deepEqual(seen, [undefined, 'editor'], '"没有活动编辑器"必须原样转发')

  await stack.dispose()
  assert.equal(stub.state.activeEditorListeners.size, 0, '栈回收后不得残留监听')
})

test('bridge：workspaceFolders 需要 workspace.read（同步 getter 在拒绝时抛错）', () => {
  const denied = makeApi([])
  assert.throws(() => denied.api.workspace.workspaceFolders, PermissionDeniedError)

  const allowed = makeApi(['vscode:workspace.read'])
  assert.equal(allowed.api.workspace.workspaceFolders, undefined, 'stub 没有工作区，返回 undefined')
})
