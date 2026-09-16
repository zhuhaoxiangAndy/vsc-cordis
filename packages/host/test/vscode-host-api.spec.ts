import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import * as path from 'node:path'
import { beforeEach, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * `VscodeHostApi` 的释放路径契约测试。
 *
 * 为什么值得单独测：它是隔离子进程唯一能触达的**真实** VSCode 能力层，
 * 之前 `dispose()` 没有调用点，而且只清 Map 不真正注销命令/不回收文档句柄。
 * 这里用与 bridge.spec.ts 同一套 vscode stub，断言兜底释放确实生效。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const stubUrl = pathToFileURL(path.join(here, 'vscode-stub.ts')).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: stubUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const stub = (await import(stubUrl)) as typeof import('./vscode-stub.ts')
const { VscodeHostApi } = await import('../src/isolation/vscode-host-api.ts')

function makeApi(): InstanceType<typeof VscodeHostApi> {
  return new VscodeHostApi({
    isPluginCommand: () => false,
    permissionsOf: () => new Set(),
    log: () => undefined,
  })
}

beforeEach(() => {
  stub.resetStub()
})

test('VscodeHostApi.dispose：注销命令、释放输出/状态栏、清空文档句柄', async () => {
  const api = makeApi()
  api.registerCommand('p', 'p.cmd', async () => 1)
  assert.equal(stub.state.commands.has('p.cmd'), true)

  api.createOutputChannel('p', 'out')
  api.createStatusBarItem('p', 0, 0, { text: 'x' })

  let handle = 0
  const subscription = api.subscribeSaveEvents('p', (payload) => {
    handle = payload.documentHandle
  })
  stub.emitSave('file:///p/doc.ts', 'secret')
  subscription.dispose()
  assert.equal(await api.readDocumentText('p', handle), 'secret')

  api.dispose()

  assert.equal(stub.state.commands.has('p.cmd'), false, 'dispose 必须真正注销命令')
  assert.equal(stub.state.outputChannels[0]?.disposed, 1, '输出通道必须被释放')
  assert.equal(stub.state.statusBarItems[0]?.disposed, 1, '状态栏项必须被释放')
  await assert.rejects(api.readDocumentText('p', handle), /已过期/, '文档句柄必须随 dispose 清空')
})
