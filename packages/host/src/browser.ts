import * as vscode from 'vscode'
import { PluginHost, describe } from '@vscordis/kernel'
import type { CordisPlugin } from '@vscordis/sdk'
import { VscodeBridge } from './bridge.ts'
import { BuiltinModuleLoader, type BuiltinPlugin } from './loader-builtin.ts'
import hello from '../../../plugins/hello/src/index.ts'

/**
 * Web 扩展宿主入口（vscode.dev / github.dev）。
 *
 * 物理边界（ADR-0006，有官方文档佐证）：
 * - 没有 Node API、没有 require/importScripts、**不能实例化 Web Worker**；
 * - 因此**运行期加载磁盘上的插件代码在 Web 上不可能**。
 *
 * 所以 Web 端的"插件"只能是构建期被 esbuild 内联进本 bundle 的模块。
 * 同一套 kernel 在这里提供的仍然是真实的运行时语义：启停、逆序回收、依赖协调 ——
 * 只是"加载"退化为"取内存里的工厂函数"。
 */

const OUTPUT_CHANNEL = 'VSCordis (web)'

/** 内置插件清单：Web 端读不了 plugin.json，因此清单在构建期内联（内容与各插件的 plugin.json 保持一致）。 */
const builtins: readonly BuiltinPlugin[] = [
  {
    entry: {
      root: '<builtin>/hello',
      mainPath: '<builtin>/hello',
      source: 'builtin',
      manifest: {
        id: 'hello',
        name: 'Hello (builtin)',
        version: '1.0.0',
        main: 'index.js',
        description: 'Web 端内置的 M1 PoC 插件',
        dependencies: {},
        permissions: ['vscode:commands.register', 'vscode:window.messages'],
        trust: 'trusted',
      },
    },
    factory: (): CordisPlugin => hello,
  },
]

let host: PluginHost | undefined
let bridge: VscodeBridge | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL, { log: true })
  context.subscriptions.push(output)

  const loader = new BuiltinModuleLoader(builtins)
  bridge = new VscodeBridge({
    platform: 'web',
    // Web 端永远没有隔离后端 → untrusted 插件一律拒绝（fail-closed）。
    supportsIsolation: false,
    output,
    loader,
  })
  host = new PluginHost({ port: bridge, disposeTimeoutMs: 2000 })

  context.subscriptions.push(
    vscode.commands.registerCommand('vscordis.runPluginCommand', async () => {
      const commands = bridge?.livePluginCommands() ?? []
      if (commands.length === 0) {
        void vscode.window.showInformationMessage('VSCordis (web)：当前没有可运行的插件命令')
        return
      }
      const picked = await vscode.window.showQuickPick(
        commands.map((info) => ({ label: info.command, description: `由 ${info.owner} 提供` })),
        { title: 'VSCordis：运行插件命令' },
      )
      if (picked !== undefined) await vscode.commands.executeCommand(picked.label)
    }),
    vscode.commands.registerCommand('vscordis.loadPlugin', async () => {
      for (const builtin of loader.list()) {
        if (host?.view(builtin.entry.manifest.id) !== undefined) continue
        await host?.load(builtin.entry)
      }
      await host?.settle()
    }),
    vscode.commands.registerCommand('vscordis.unloadPlugin', async () => {
      const views = host?.list() ?? []
      const picked = await vscode.window.showQuickPick(
        views.map((view) => ({ label: view.id, description: `[${view.state}]` })),
        { title: 'VSCordis (web)：卸载插件' },
      )
      if (picked === undefined) return
      await host?.unload(picked.label)
      await host?.settle()
    }),
    vscode.commands.registerCommand('vscordis.reloadPlugin', async () => {
      const views = host?.list() ?? []
      const picked = await vscode.window.showQuickPick(
        views.map((view) => ({ label: view.id, description: `[${view.state}]` })),
        { title: 'VSCordis (web)：重载插件' },
      )
      if (picked === undefined) return
      await host?.reload(picked.label)
      await host?.settle()
    }),
    vscode.commands.registerCommand('vscordis.unloadAll', async () => {
      await host?.unloadAll()
      await host?.settle()
    }),
    vscode.commands.registerCommand('vscordis.showStatus', () => {
      const lines = [
        'VSCordis (web) 运行时状态',
        `内置插件：${loader.list().map((builtin) => builtin.entry.manifest.id).join(', ') || '<无>'}`,
        `隔离后端：不可用（Web 宿主的物理限制，untrusted 插件一律拒绝）`,
        '',
        ...(host?.list() ?? []).map((view) => `${view.id} [${view.state}] provides=${view.provides.join(',') || '-'}`),
        '',
        `活命令：${(bridge?.livePluginCommands() ?? []).map((info) => info.command).join(', ') || '<无>'}`,
      ]
      const channel = vscode.window.createOutputChannel('VSCordis 状态')
      for (const line of lines) channel.appendLine(line)
      channel.show(true)
    }),
  )

  for (const builtin of builtins) {
    try {
      await host.load(builtin.entry)
    } catch (error) {
      output.error(`内置插件 ${builtin.entry.manifest.id} 加载失败：${describe(error)}`)
    }
  }
  await host.settle()
  output.info('VSCordis (web) 已激活')
}

export async function deactivate(): Promise<void> {
  const current = host
  host = undefined
  bridge = undefined
  await current?.dispose()
}
