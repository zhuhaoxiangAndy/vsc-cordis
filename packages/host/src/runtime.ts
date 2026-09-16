import * as path from 'node:path'
import * as vscode from 'vscode'
import { PluginHost, describe, type PluginEntry, type PluginView } from '@vscordis/kernel'
import { VscodeBridge } from './bridge.ts'
import { discoverPlugins, expandRootVariables, sortByDependencies, type PluginRoot } from './discovery.ts'
import { NodeModuleLoader } from './loader-node.ts'

export interface RuntimeOptions {
  readonly output: vscode.LogOutputChannel
  /** 用于解析 `${workspaceFolder}` 与默认插件根目录。 */
  readonly globalStorageUri: vscode.Uri
  readonly supportsIsolation?: boolean
}

/**
 * 运行时装配：把 kernel（纯逻辑）与 VSCode 适配层接起来，并提供 6 个宿主入口命令。
 *
 * 装配顺序有意固定：先发现插件 → 注册宿主入口命令 → 再自动加载插件。
 * 这样即便某个插件把宿主搞崩，用户手里也已经有了"卸载/显示状态"的命令可用。
 */
export class Runtime {
  readonly bridge: VscodeBridge
  readonly host: PluginHost
  readonly #globalStorageUri: vscode.Uri
  #entries: readonly PluginEntry[] = []
  #problems: readonly string[] = []

  constructor(options: RuntimeOptions) {
    this.#globalStorageUri = options.globalStorageUri
    const loader = new NodeModuleLoader({
      onLog: (message) => this.bridge.log('trace', message),
    })
    this.bridge = new VscodeBridge({
      platform: 'node',
      // Node 宿主具备子进程能力 → 允许加载 untrusted（M4 之前实际上还没有进程后端，
      // 因此这里保持 false，让 untrusted 插件被明确拒绝而不是悄悄降级到同进程，见 ADR-0003）。
      supportsIsolation: options.supportsIsolation ?? false,
      output: options.output,
      loader,
    })
    this.host = new PluginHost({
      port: this.bridge,
      disposeTimeoutMs: readDisposeTimeoutMs(),
      onTransition: (event) => {
        this.bridge.log('debug', `[状态] ${event.id}: ${event.from} → ${event.to}（${event.reason}）`)
      },
    })
  }

  // ————————————————————————————————— 发现

  #pluginRoots(): readonly PluginRoot[] {
    const config = vscode.workspace.getConfiguration('vscordis')
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
    const configured = expandRootVariables(config.get<string[]>('pluginRoots', []), folders)

    const roots: PluginRoot[] = []
    for (const dir of configured) roots.push({ dir: path.resolve(dir), source: 'workspace' })
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      roots.push({ dir: path.join(folder.uri.fsPath, '.vscordis', 'plugins'), source: 'workspace' })
    }
    roots.push({ dir: path.join(this.#globalStorageUri.fsPath, 'plugins'), source: 'global' })

    // 去重（同一个目录既被配置又被默认规则命中时不要重复扫描）
    const seen = new Set<string>()
    return roots.filter((root) => {
      const key = process.platform === 'win32' ? root.dir.toLowerCase() : root.dir
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  async #refreshEntries(): Promise<void> {
    const result = await discoverPlugins(this.#pluginRoots())
    this.#entries = sortByDependencies(result.entries)
    this.#problems = result.problems
    for (const problem of result.problems) this.bridge.log('warn', `[发现] ${problem}`)
  }

  entries(): readonly PluginEntry[] {
    return this.#entries
  }

  problems(): readonly string[] {
    return this.#problems
  }

  async initialize(): Promise<void> {
    await this.#refreshEntries()
    if (!vscode.workspace.getConfiguration('vscordis').get<boolean>('autoLoad', true)) {
      this.bridge.log('info', `自动加载已关闭；已发现 ${this.#entries.length} 个插件，等待手动加载`)
      return
    }
    for (const entry of this.#entries) {
      try {
        await this.host.load(entry)
      } catch (error) {
        // 单个插件加载失败绝不能影响其它插件，也不能中断宿主启动。
        this.bridge.log('error', `插件 ${entry.manifest.id} 加载失败：${describe(error)}`)
      }
    }
    await this.host.settle()
    this.bridge.log('info', `启动完成：${this.host.list().length} 个插件，${this.bridge.livePluginCommands().length} 个命令`)
  }

  // ————————————————————————————————— 宿主入口命令

  registerCommands(): readonly vscode.Disposable[] {
    const runtime = this
    return [
      vscode.commands.registerCommand('vscordis.runPluginCommand', () => runtime.runPluginCommand()),
      vscode.commands.registerCommand('vscordis.loadPlugin', () => runtime.loadPlugin()),
      vscode.commands.registerCommand('vscordis.unloadPlugin', () => runtime.unloadPlugin()),
      vscode.commands.registerCommand('vscordis.reloadPlugin', () => runtime.reloadPlugin()),
      vscode.commands.registerCommand('vscordis.unloadAll', () => runtime.unloadAll()),
      vscode.commands.registerCommand('vscordis.showStatus', () => runtime.showStatus()),
    ]
  }

  /**
   * ADR-0002 的核心：运行时注册的命令不在命令面板里，所以由宿主提供一个静态入口，
   * 用 QuickPick 枚举**当前活的**插件命令。卸载插件后它立刻从列表消失 —— 这才是可演示、可断言的"命令消失"。
   */
  async runPluginCommand(): Promise<void> {
    const commands = this.bridge.livePluginCommands()
    if (commands.length === 0) {
      void vscode.window.showInformationMessage('VSCordis：当前没有可运行的插件命令（没有插件处于 active 状态？）')
      return
    }
    const picked = await vscode.window.showQuickPick(
      commands.map((info) => ({ label: info.command, description: `由 ${info.owner} 提供` })),
      { title: 'VSCordis：运行插件命令', placeHolder: '选择一个由 vscordis 插件注册的命令' },
    )
    if (picked === undefined) return
    try {
      await vscode.commands.executeCommand(picked.label)
    } catch (error) {
      void vscode.window.showErrorMessage(`执行 ${picked.label} 失败：${describe(error)}`)
    }
  }

  async loadPlugin(): Promise<void> {
    await this.#refreshEntries()
    const loaded = new Set(this.host.list().map((view) => view.id))
    const candidates = this.#entries.filter((entry) => !loaded.has(entry.manifest.id))
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('VSCordis：没有可加载的插件（全部已加载，或没有发现任何插件）')
      return
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map((entry) => ({
        label: entry.manifest.id,
        description: `v${entry.manifest.version} · ${entry.source}`,
        detail: `${entry.manifest.name} · ${Object.keys(entry.manifest.dependencies).join(', ') || '无依赖'} · trust=${entry.manifest.trust}`,
        entry,
      })),
      { title: 'VSCordis：加载插件' },
    )
    if (picked === undefined) return
    try {
      const view = await this.host.load(picked.entry)
      await this.host.settle()
      void vscode.window.showInformationMessage(`已加载 ${view.id}（状态 ${this.host.view(view.id)?.state ?? view.state}）`)
    } catch (error) {
      void vscode.window.showErrorMessage(`加载 ${picked.entry.manifest.id} 失败：${describe(error)}`)
    }
  }

  async unloadPlugin(): Promise<void> {
    const view = await this.#pickLoaded('VSCordis：卸载插件')
    if (view === undefined) return
    await this.host.unload(view.id)
    await this.host.settle()
    this.#reportCascade(`已卸载 ${view.id}`)
  }

  async reloadPlugin(): Promise<void> {
    const view = await this.#pickLoaded('VSCordis：重载插件')
    if (view === undefined) return
    try {
      await this.host.reload(view.id)
      await this.host.settle()
      this.#reportCascade(`已重载 ${view.id}`)
    } catch (error) {
      void vscode.window.showErrorMessage(`重载 ${view.id} 失败：${describe(error)}`)
    }
  }

  async unloadAll(): Promise<void> {
    await this.host.unloadAll()
    await this.host.settle()
    this.#reportCascade('已卸载全部插件')
  }

  async showStatus(): Promise<void> {
    const output = vscode.window.createOutputChannel('VSCordis 状态')
    for (const line of this.statusLines()) output.appendLine(line)
    output.show(true)
  }

  /** 状态报告：插件状态 + 服务图 + 发现阶段的问题。 */
  statusLines(): readonly string[] {
    const lines: string[] = []
    lines.push(`VSCordis 运行时状态（${new Date().toISOString()}）`)
    lines.push(`平台：node · 隔离后端：${this.bridge.supportsIsolation ? '可用' : '不可用（untrusted 插件会被拒绝）'}`)

    const views = this.host.list()
    lines.push('')
    lines.push(`插件（${views.length}）：`)
    if (views.length === 0) lines.push('  <无>')
    for (const view of views) {
      lines.push(`  ${statusIcon(view)} ${view.id}@${view.version} [${view.state}] (${view.source})`)
      lines.push(`      provides=${view.provides.join(',') || '-'} depends=${Object.entries(view.dependencies).map(([n, r]) => `${n}${r}`).join(',') || '-'}`)
      if (view.missing.length > 0) lines.push(`      等待依赖：${view.missing.join(', ')}`)
      if (view.error !== undefined) lines.push(`      错误：${view.error}`)
    }

    const snapshot = this.host.registry.snapshot()
    lines.push('')
    lines.push(`服务（${snapshot.services.length}）：`)
    if (snapshot.services.length === 0) lines.push('  <无>')
    for (const service of snapshot.services) {
      const provider = service.provider === undefined ? '<无提供者>' : `${service.provider.owner}@${service.provider.version ?? '-'}#${service.provider.generation}`
      const consumers = service.consumers.map((consumer) => `${consumer.owner}(${consumer.kind})`).join(', ') || '-'
      lines.push(`  ${service.name} ← ${provider} ← 消费者: ${consumers}`)
    }

    lines.push('')
    lines.push(`活命令（${this.bridge.livePluginCommands().length}）：`)
    for (const info of this.bridge.livePluginCommands()) lines.push(`  ${info.command}  (${info.owner})`)

    lines.push('')
    lines.push(`发现的问题（${this.#problems.length}）：`)
    for (const problem of this.#problems) lines.push(`  ${problem}`)

    return lines
  }

  // ————————————————————————————————— 内部

  async #pickLoaded(title: string): Promise<PluginView | undefined> {
    const views = this.host.list()
    if (views.length === 0) {
      void vscode.window.showInformationMessage('VSCordis：当前没有已加载的插件')
      return undefined
    }
    const picked = await vscode.window.showQuickPick(
      views.map((view) => ({
        label: view.id,
        description: `[${view.state}] v${view.version}`,
        detail: `provides: ${view.provides.join(',') || '-'}`,
        view,
      })),
      { title },
    )
    return picked?.view
  }

  /** 卸载/重载可能级联影响下游插件，报告出来才不会被误认为"没生效"。 */
  #reportCascade(prefix: string): void {
    const paused = this.host.list().filter((view) => view.state === 'paused')
    const suffix = paused.length === 0 ? '' : `；${paused.length} 个插件因依赖缺失而 paused：${paused.map((view) => view.id).join(', ')}`
    void vscode.window.showInformationMessage(`${prefix}${suffix}`)
    this.bridge.log('info', `${prefix}${suffix}`)
  }

  async dispose(): Promise<void> {
    await this.host.dispose()
  }
}

function statusIcon(view: PluginView): string {
  switch (view.state) {
    case 'active':
      return '●'
    case 'paused':
      return '○'
    case 'failed':
      return '✗'
    default:
      return '·'
  }
}

function readDisposeTimeoutMs(): number {
  const configured = vscode.workspace.getConfiguration('vscordis').get<number>('disposeTimeoutMs', 2000)
  return Number.isFinite(configured) && configured > 0 ? configured : 2000
}
