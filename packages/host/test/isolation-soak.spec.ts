import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build, stop } from 'esbuild'
import { PluginHost, type HostPort, type PluginEntry } from '@vscordis/kernel'
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

const CYCLES = 20

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
  readonly commands = new Map<string, { invoke: (args: readonly unknown[]) => Promise<unknown> }>()
  #nextHandle = 1

  registerCommand(_pluginId: string, command: string, invoke: (args: readonly unknown[]) => Promise<unknown>): { dispose(): void } {
    const record = { invoke }
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
  const loader = new IsolatedPluginLoader({
    hostApi,
    workerPath,
    publicKeyPem: undefined,
    readyTimeoutMs: 15_000,
    disposeTimeoutMs: 3_000,
  })
  const host = new PluginHost({ port: new IsolationPort(loader), disposeTimeoutMs: 4_000, activationTimeoutMs: 20_000 })

  try {
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      await host.load(entry)
      await host.settle()
      assert.equal(host.view('soak')?.state, 'active', `第 ${cycle} 轮应激活成功`)
      assert.equal(hostApi.commands.size, 1, `第 ${cycle} 轮应恰好注册 1 条命令`)

      const result = await hostApi.executeCommand('soak', 'soak.ping', [])
      assert.equal(result, 'pong', `第 ${cycle} 轮反向调用应能拿到子进程 handler 的结果`)

      await host.unload('soak')
      await host.settle()

      assert.equal(hostApi.commands.size, 0, `第 ${cycle} 轮卸载后宿主侧命令必须撤干净`)
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
