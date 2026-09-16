import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CordisPlugin } from '@vscordis/sdk'
import { PluginHost } from '../src/plugin-host.ts'
import { FakeHostPort, makeEntry } from './support.ts'

/**
 * `ctx.async`（ADR-0018）：**显式异步面**，两种执行模式签名一致。
 *
 * 这里测的是**同进程实现**；隔离模式的实现在 `packages/host/test/isolation.spec.ts` 里，
 * 跑的是真实子进程 + 真实 IPC。两边签名相同，因此插件代码不需要按模式分支 ——
 * 这正是引入这个面的理由：与其给隔离模式伪造一套"看起来同步"的 API，
 * 不如把跨进程无法同步的能力单独放出来，并让同进程也实现同一份。
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function hostFor(port: FakeHostPort): PluginHost {
  return new PluginHost({ port, disposeTimeoutMs: 200, activationTimeoutMs: 2_000 })
}

test('ctx.async.onDidSaveTextDocument：把真实文档适配成纯数据 + 异步 getText', async () => {
  const port = new FakeHostPort()
  const seen: string[] = []

  port.define('watcher', (): CordisPlugin => ({
    async activate(ctx) {
      const subscription = await ctx.async.onDidSaveTextDocument(async (document) => {
        // 注意 `await`：这是类型上就写着异步的 API，不是假装同步的代理
        seen.push(
          `${document.uri}|${document.fsPath}|${document.languageId}|${document.lineCount}|${document.version}|${await document.getText()}`,
        )
      })
      // 用 ctx.effect 登记：插件即使忘了 dispose，卸载时也会被回收
      ctx.effect(() => subscription, (disposable) => disposable.dispose(), 'async:save')
    },
  }))

  const host = hostFor(port)
  await host.load(makeEntry('watcher'))
  await host.settle()

  port.emitSave({
    uri: 'file:///workspace/a.ts',
    languageId: 'typescript',
    lineCount: 3,
    version: 9,
    text: 'body text',
  })
  await sleep(20)

  assert.deepEqual(seen, ['file:///workspace/a.ts|/workspace/a.ts|typescript|3|9|body text'])

  // 卸载后监听器必须已经被移除（否则就是残留）
  await host.unload('watcher')
  await host.settle()
  assert.equal(port.saveListeners.size, 0, '卸载后不应残留文档保存监听器')

  port.emitSave({ text: 'after unload' })
  await sleep(20)
  assert.equal(seen.length, 1, '卸载之后不该再收到事件')
  await host.dispose()
})

test('ctx.async：没有事件时 activate 也正常完成（订阅是异步建立的）', async () => {
  const port = new FakeHostPort()
  let subscriptionResolved = false

  port.define('quiet', (): CordisPlugin => ({
    async activate(ctx) {
      const subscription = await ctx.async.onDidSaveTextDocument(() => undefined)
      subscriptionResolved = true
      ctx.effect(() => subscription, (disposable) => disposable.dispose(), 'async:save')
    },
  }))

  const host = hostFor(port)
  await host.load(makeEntry('quiet'))
  await host.settle()
  assert.equal(host.view('quiet')?.state, 'active')
  assert.equal(subscriptionResolved, true)
  assert.equal(port.saveListeners.size, 1)
  await host.dispose()
})

test('ctx.async：订阅建立的失败会让 activate 失败（不吞异常）', async () => {
  const port = new FakeHostPort()
  // 让 onDidSaveTextDocument 抛错：模拟宿主侧拒绝（例如缺少 workspace.read 权限）
  const original = port.createApi.bind(port)
  port.createApi = (deps): ReturnType<FakeHostPort['createApi']> => {
    const api = original(deps)
    const broken = { ...api, workspace: { ...api.workspace, onDidSaveTextDocument: () => { throw new Error('宿主拒绝了订阅') } } }
    return broken as unknown as ReturnType<FakeHostPort['createApi']>
  }

  port.define('denied', (): CordisPlugin => ({
    async activate(ctx) {
      await ctx.async.onDidSaveTextDocument(() => undefined)
    },
  }))

  const host = hostFor(port)
  await assert.rejects(host.load(makeEntry('denied')), /宿主拒绝了订阅/)
  assert.equal(host.view('denied')?.state, 'failed')
  await host.dispose()
})

test('ctx.async.onDidChangeActiveTextEditor：适配成纯数据 + 异步 getText，无编辑器时回调 undefined', async () => {
  const port = new FakeHostPort()
  const seen: string[] = []

  port.define('editor-watcher', (): CordisPlugin => ({
    async activate(ctx) {
      const subscription = await ctx.async.onDidChangeActiveTextEditor(async (document) => {
        seen.push(
          document === undefined
            ? '<none>'
            : `${document.fsPath}|${document.languageId}|${document.lineCount}|${await document.getText()}`,
        )
      })
      ctx.effect(() => subscription, (disposable) => disposable.dispose(), 'async:activeEditor')
    },
  }))

  const host = hostFor(port)
  await host.load(makeEntry('editor-watcher'))
  await host.settle()

  // 事件之间留出间隔：监听器是异步的（要 await getText()），同步连发不保证回调顺序，
  // 而真实事件本来就是先后发生的。
  port.emitActiveEditor({ uri: 'file:///w/a.ts', languageId: 'typescript', lineCount: 2, text: 'current file' })
  await sleep(20)
  // "没有活动编辑器"必须原样回调 undefined，而不是被静默跳过
  port.emitActiveEditor(null)
  await sleep(20)

  assert.deepEqual(seen, ['/w/a.ts|typescript|2|current file', '<none>'])

  await host.unload('editor-watcher')
  await host.settle()
  assert.equal(port.activeEditorListeners.size, 0, '卸载后不应残留活动编辑器监听器')

  port.emitActiveEditor({ text: 'after unload' })
  await sleep(20)
  assert.equal(seen.length, 2, '卸载之后不该再收到事件')
  await host.dispose()
})
