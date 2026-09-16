import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build, stop } from 'esbuild'
import { PluginHost, ServiceRegistry, type HostPort, type PluginEntry } from '@vscordis/kernel'
import type { LogLevel, PluginVscodeApi } from '@vscordis/sdk'
import { IsolatedPluginLoader, type IsolatedHostApi } from '../src/isolation/isolated-loader.ts'
import type { SerializedWorkspaceFolder } from '../src/isolation/protocol.ts'

/**
 * 隔离模式的浸泡测试：反复起停真实子进程，验证**没有泄漏的子进程**。
 *
 * 这是隔离方案最值得证明的一条：`trusted` 插件的"无残留"是尽力而为（清 require.cache
 * 并不能强制回收可达闭包），而隔离插件的"无残留"应当是**进程级**的 ——
 * 子进程要么退出、要么被杀，没有第三种状态。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const scratch = path.join(here, 'scratch')
const fixturesRoot = path.join(scratch, 'soak-fixtures')

const CYCLES = 40

let workerPromise: Promise<string> | undefined
function ensureWorker(): Promise<string> {
  workerPromise ??= (async () => {
    const outfile = path.join(scratch, 'soak-worker.cjs')
    await mkdir(scratch, { recursive: true })
    await build({
      entryPoints: [path.join(here, '..', 'src', 'isolation', 'child-bootstrap.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      tsconfig: path.join(repoRoot, 'tsconfig.base.json'),
      logLevel: 'silent',
    })
    // 不 stop 的话 esbuild 的常驻 service 会让测试进程退不出去（M4b 轮踩过这个坑）
    await stop()
    return outfile
  })()
  return workerPromise
}

class SilentHostApi implements IsolatedHostApi {
  readonly commands = new Map<string, { pluginId: string; invoke: (args: readonly unknown[]) => Promise<unknown> }>()
  #nextHandle = 1

  registerCommand(pluginId: string, command: string, invoke: (args: readonly unknown[]) => Promise<unknown>): { dispose(): void } {
    const existing = this.commands.get(command)
    if (existing !== undefined && existing.pluginId !== pluginId) {
      throw new Error(`命令 ID "${command}" 已被插件 "${existing.pluginId}" 注册`)
    }
    const record = { pluginId, invoke }
    this.commands.set(command, record)
    return {
      dispose: () => {
        if (this.commands.get(command) === record) this.commands.delete(command)
      },
    }
  }

  unregisterCommand(pluginId: string, command: string): void {
    const current = this.commands.get(command)
    if (current?.pluginId === pluginId) this.commands.delete(command)
  }

  async executeCommand(_pluginId: string, command: string, args: readonly unknown[]): Promise<unknown> {
    const record = this.commands.get(command)
    if (record === undefined) throw new Error(`command not found: ${command}`)
    return await record.invoke(args)
  }

  async showMessage(): Promise<string | undefined> {
    return undefined
  }

  createOutputChannel(): number {
    return this.#nextHandle++
  }

  appendOutputLine(): void {}

  disposeOutput(): void {}

  async readConfiguration(): Promise<Readonly<Record<string, unknown>>> {
    return {}
  }

  subscribeSaveEvents(): { dispose(): void } {
    return { dispose: () => undefined }
  }

  subscribeActiveEditorChanges(): { dispose(): void } {
    return { dispose: () => undefined }
  }

  async readDocumentText(): Promise<string> {
    return ''
  }

  onDidChangeConfiguration(): { dispose(): void } {
    return { dispose: () => undefined }
  }

  createStatusBarItem(): number {
    return this.#nextHandle++
  }

  updateStatusBarItem(): void {}

  setStatusBarItemVisible(): void {}

  disposeStatusBarItem(): void {}

  workspaceFolders(): readonly SerializedWorkspaceFolder[] {
    return []
  }

  log(): void {}
}

class IsolationPort implements HostPort {
  readonly platform = 'node' as const
  readonly supportsIsolation = true
  readonly #loader: IsolatedPluginLoader

  constructor(loader: IsolatedPluginLoader) {
    this.#loader = loader
  }

  loadModule(entry: PluginEntry): Promise<Awaited<ReturnType<IsolatedPluginLoader['load']>>> {
    return this.#loader.load(entry)
  }

  createApi(): PluginVscodeApi {
    return {} as PluginVscodeApi
  }

  log(_level: LogLevel): void {}
}

test(`隔离浸泡：${CYCLES} 轮起停子进程后，没有残留的活跃会话`, async () => {
  const workerPath = await ensureWorker()
  const dir = path.join(fixturesRoot, 'soak-plugin')
  await mkdir(path.join(dir, 'dist'), { recursive: true })
  await writeFile(
    path.join(dir, 'dist', 'index.cjs'),
    `module.exports = {
       activate(ctx) {
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('soak.ping', () => 'pong'),
           (disposable) => disposable.dispose(),
           'cmd',
         )
       },
     }\n`,
    'utf8',
  )
  await writeFile(
    path.join(dir, 'plugin.json'),
    `${JSON.stringify(
      {
        id: 'soak',
        name: 'soak',
        version: '1.0.0',
        main: 'dist/index.cjs',
        trust: 'untrusted',
        permissions: ['vscode:commands.register'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  const entry: PluginEntry = {
    root: dir,
    mainPath: path.join(dir, 'dist', 'index.cjs'),
    source: 'workspace',
    manifest: {
      id: 'soak',
      name: 'soak',
      version: '1.0.0',
      main: 'dist/index.cjs',
      description: undefined,
      dependencies: {},
      provides: [],
      permissions: ['vscode:commands.register'],
      trust: 'untrusted',
    },
  }

  const hostApi = new SilentHostApi()
  const registry = new ServiceRegistry()
  const loader = new IsolatedPluginLoader({
    hostApi,
    registry,
    workerPath,
    publicKeyPem: undefined,
    readyTimeoutMs: 15_000,
    disposeTimeoutMs: 3_000,
  })
  const host = new PluginHost({
    port: new IsolationPort(loader),
    registry,
    disposeTimeoutMs: 4_000,
    activationTimeoutMs: 20_000,
  })

  try {
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      await host.load(entry)
      await host.settle()
      assert.equal(host.view('soak')?.state, 'active', `第 ${cycle} 轮应激活成功`)
      assert.equal(hostApi.commands.size, 1, `第 ${cycle} 轮应恰好注册 1 条命令`)

      // 哨兵（补上"只断言最终为 0"的另一半）：每轮都必须真的起了一个**新**子进程。
      // 少了这条，一个"从来没起过进程"的实现也能让最后的 activeSessions === 0 通过。
      assert.equal(loader.activeSessions, 1, `第 ${cycle} 轮应当恰好有 1 个活跃会话`)
      assert.equal(loader.sessionsStarted, cycle + 1, `第 ${cycle} 轮应当已经起过 ${cycle + 1} 个子进程`)

      const result = await hostApi.executeCommand('soak', 'soak.ping', [])
      assert.equal(result, 'pong', `第 ${cycle} 轮反向调用应能拿到子进程 handler 的结果`)

      await host.unload('soak')
      await host.settle()

      assert.equal(hostApi.commands.size, 0, `第 ${cycle} 轮卸载后宿主侧命令必须撤干净`)
      assert.equal(host.queueDepth, 0, `第 ${cycle} 轮卸载后串行队列应当排空`)

      // 每轮都要等到子进程真的退出，而不是攒到最后再看一次：
      // 这样"第 N 轮泄漏了一个进程"会立刻定位到具体轮次。
      for (let attempt = 0; attempt < 60 && loader.activeSessions > 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(loader.activeSessions, 0, `第 ${cycle} 轮卸载后子进程必须退出`)
    }

    // 关键断言：子进程都退出了。给一点时间让 exit 事件落地。
    for (let attempt = 0; attempt < 40 && loader.activeSessions > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(
      loader.activeSessions,
      0,
      `仍有活跃的隔离子进程：${loader.activeSessionIds().join(', ')} —— 说明 kill/exit 路径没走完`,
    )
    assert.equal(hostApi.commands.size, 0)
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.dispose().catch(() => undefined)
  }
})

/**
 * 多会话浸泡：同时跑 **3 个**隔离子进程（提供者 + 消费者 + 独立插件），循环若干轮。
 *
 * 与单会话浸泡互补的地方：
 * - 每轮的会话记账必须走 0 → 3 → 0（`sessionsStarted` 也每轮 +3）；
 * - 每个周期都做一次**跨两个子进程**的服务调用（消费者 → 宿主 → 提供者）；
 * - 每个周期都验证级联：卸载提供者 → 消费者 `paused`、独立插件不受影响。
 */
const MULTI_CYCLES = 8

async function writeSoakFixture(
  id: string,
  source: string,
  manifest: { provides?: readonly string[]; dependencies?: Record<string, string>; permissions?: readonly string[] },
): Promise<PluginEntry> {
  const dir = path.join(fixturesRoot, `multi-${id}`)
  await mkdir(path.join(dir, 'dist'), { recursive: true })
  await writeFile(path.join(dir, 'dist', 'index.cjs'), source, 'utf8')
  await writeFile(
    path.join(dir, 'plugin.json'),
    `${JSON.stringify(
      {
        id,
        name: id,
        version: '1.0.0',
        main: 'dist/index.cjs',
        trust: 'untrusted',
        permissions: manifest.permissions ?? [],
        provides: manifest.provides ?? [],
        dependencies: manifest.dependencies ?? {},
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return {
    root: dir,
    mainPath: path.join(dir, 'dist', 'index.cjs'),
    source: 'workspace',
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      main: 'dist/index.cjs',
      description: undefined,
      dependencies: manifest.dependencies ?? {},
      provides: [...(manifest.provides ?? [])],
      permissions: [...(manifest.permissions ?? [])],
      trust: 'untrusted',
    },
  }
}

test(`隔离浸泡（多会话）：${MULTI_CYCLES} 轮 × 3 个子进程，含跨进程调用与级联`, async () => {
  const workerPath = await ensureWorker()
  const provider = await writeSoakFixture(
    'provider',
    `module.exports = {
       activate(ctx) {
         ctx.provide('soak-clock', { now: () => 'tick' }, { version: '1.0.0' })
       },
     }\n`,
    { provides: ['soak-clock'] },
  )
  const consumer = await writeSoakFixture(
    'consumer',
    `module.exports = {
       activate: async (ctx) => {
         const clock = await ctx.async.useService('soak-clock')
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('soak.consumer.now', async () => await clock.now()),
           (d) => d.dispose(),
           'cmd',
         )
       },
     }\n`,
    { dependencies: { 'soak-clock': '^1.0.0' }, permissions: ['vscode:commands.register'] },
  )
  const solo = await writeSoakFixture(
    'solo',
    `module.exports = {
       activate(ctx) {
         ctx.effect(
           () => ctx.vscode.commands.registerCommand('soak.solo.ping', () => 'pong'),
           (d) => d.dispose(),
           'cmd',
         )
       },
     }\n`,
    { permissions: ['vscode:commands.register'] },
  )

  const hostApi = new SilentHostApi()
  const registry = new ServiceRegistry()
  const loader = new IsolatedPluginLoader({
    hostApi,
    registry,
    workerPath,
    publicKeyPem: undefined,
    readyTimeoutMs: 15_000,
    disposeTimeoutMs: 3_000,
  })
  const host = new PluginHost({
    port: new IsolationPort(loader),
    registry,
    disposeTimeoutMs: 4_000,
    activationTimeoutMs: 20_000,
  })

  try {
    for (let cycle = 0; cycle < MULTI_CYCLES; cycle += 1) {
      await host.load(provider)
      await host.load(consumer)
      await host.load(solo)
      await host.settle()

      assert.equal(loader.activeSessions, 3, `第 ${cycle} 轮应有 3 个活跃会话`)
      assert.equal(loader.sessionsStarted, (cycle + 1) * 3, `第 ${cycle} 轮应累计起过 ${(cycle + 1) * 3} 个子进程`)
      assert.equal(hostApi.commands.size, 2, '消费者与 solo 各注册一条命令')

      // 跨两个子进程的服务调用：消费者 child → 宿主 → 提供者 child
      assert.equal(await hostApi.executeCommand('consumer', 'soak.consumer.now', []), 'tick')
      assert.equal(await hostApi.executeCommand('solo', 'soak.solo.ping', []), 'pong')

      // 卸载提供者：消费者被级联暂停，独立插件不受影响
      await host.unload('provider')
      await host.settle()
      assert.equal(host.view('consumer')?.state, 'paused', `第 ${cycle} 轮消费者应被级联暂停`)
      assert.equal(host.view('solo')?.state, 'active', `第 ${cycle} 轮独立插件不应受影响`)

      await host.unloadAll()
      await host.settle()
      assert.equal(host.queueDepth, 0, `第 ${cycle} 轮队列应排空`)

      for (let attempt = 0; attempt < 80 && loader.activeSessions > 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(loader.activeSessions, 0, `第 ${cycle} 轮结束后不得残留子进程`)
      assert.equal(hostApi.commands.size, 0)
    }

    assert.equal(loader.sessionsStarted, MULTI_CYCLES * 3, '每个周期都应当恰好起过 3 个子进程')
  } finally {
    await host.unloadAll().catch(() => undefined)
    await host.dispose().catch(() => undefined)
  }
})
