import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { PluginHost, describe, type PluginEntry, type PluginView } from '@vscordis/kernel'
import { isPermission, type Permission } from '@vscordis/sdk'
import { VscodeBridge, type ModuleLoader } from './bridge.ts'
import { discoverPlugins, expandRootVariables, sortByDependencies, type PluginRoot } from './discovery.ts'
import { IsolatedPluginLoader } from './isolation/isolated-loader.ts'
import { VscodeHostApi } from './isolation/vscode-host-api.ts'
import { NodeModuleLoader } from './loader-node.ts'
import { PluginWatcher, type ReloadPlan } from './watcher.ts'

export interface RuntimeOptions {
  readonly output: vscode.LogOutputChannel
  /** 宿主扩展自身目录：用于定位内置验签公钥 `keys/vscordis-ed25519.pub.pem`。 */
  readonly extensionUri: vscode.Uri
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
  readonly #extensionUri: vscode.Uri
  readonly #publicKeyPem: string | undefined
  readonly #watcher: PluginWatcher
  readonly #workerPath: string
  readonly #supportsIsolation: boolean
  /** 保留引用是为了状态面板能报告"当前有几个隔离子进程"——诊断信息不该只活在测试里。 */
  readonly #isolatedLoader: IsolatedPluginLoader
  /** 规范化目录 → 插件 id。热重载要靠目录反查 id；目录被删除时也靠它决定卸载谁。 */
  readonly #dirToId = new Map<string, string>()
  #lastReloadMs = 0
  #lastReloadAt: Date | undefined
  #entries: readonly PluginEntry[] = []
  #problems: readonly string[] = []

  constructor(options: RuntimeOptions) {
    this.#globalStorageUri = options.globalStorageUri
    this.#extensionUri = options.extensionUri
    this.#publicKeyPem = readPublicKey(options.extensionUri)

    const nodeLoader = new NodeModuleLoader({
      onLog: (message) => this.bridge.log('trace', message),
      integrity: {
        publicKeyPem: this.#publicKeyPem,
        // 用户决策：开发期（工作区目录）可未签名；装入 globalStorage 的插件必须签名 + 哈希。
        // 注意这是"是否强制"的开关，不是"是否校验"的开关 —— 带签名的插件在任何来源下都会被校验。
        requireSignature: (entry) => entry.source === 'global',
      },
    })

    // ————— 隔离后端（M4b）—————
    // 引导脚本不存在时**没有**隔离后端 → untrusted 插件继续被 fail-closed 拒绝，
    // 绝不会悄悄退回同进程执行（ADR-0003）。
    this.#workerPath = path.join(options.extensionUri.fsPath, 'dist', 'isolated-worker.cjs')
    this.#supportsIsolation = options.supportsIsolation ?? existsSync(this.#workerPath)

    const isolatedLoader = new IsolatedPluginLoader({
      hostApi: new VscodeHostApi({        isPluginCommand: (command) => this.bridge.livePluginCommands().some((info) => info.command === command),
        // 权限只能由宿主查清单得出：让子进程自述等于允许它给自己提权。
        permissionsOf: (id) => {
          const entry = this.#entries.find((candidate) => candidate.manifest.id === id)
          const granted = new Set<Permission>()
          // 用守卫过滤而不是硬转：清单里的权限是 string[]，而内核只放行已知权限
          // （未知权限会在 manifest 校验期直接拒绝加载，所以这里过滤掉的只会是"理论上不该存在"的值）。
          for (const value of entry?.manifest.permissions ?? []) {
            if (isPermission(value)) granted.add(value)
          }
          return granted
        },
        log: (level, message, meta) => this.bridge.log(level, message, meta),
      }),
      workerPath: this.#workerPath,
      publicKeyPem: this.#publicKeyPem,
      disposeTimeoutMs: readDisposeTimeoutMs(),
      usePermissionModel: vscode.workspace
        .getConfiguration('vscordis')
        .get<boolean>('isolation.permissionModel', true),
      onLog: (message) => this.bridge.log('debug', message),
    })
    this.#isolatedLoader = isolatedLoader

    // 按 trust 路由：untrusted 走子进程，其余走 in-process。
    // 路由放在这里而不是 bridge 里，是为了让 bridge 不必知道隔离的存在。
    const routingLoader: ModuleLoader = {
      load: (entry: PluginEntry) =>
        entry.manifest.trust === 'untrusted' ? isolatedLoader.load(entry) : nodeLoader.load(entry),
    }

    this.bridge = new VscodeBridge({
      platform: 'node',
      supportsIsolation: this.#supportsIsolation,
      output: options.output,
      loader: routingLoader,
    })
    this.host = new PluginHost({
      port: this.bridge,
      disposeTimeoutMs: readDisposeTimeoutMs(),
      activationTimeoutMs: readActivationTimeoutMs(),
      onTransition: (event) => {
        this.bridge.log('debug', `[状态] ${event.id}: ${event.from} → ${event.to}（${event.reason}）`)
      },
    })

    this.#watcher = new PluginWatcher({
      roots: () => this.#pluginRoots().map((root) => root.dir),
      debounceMs: readHotReloadDebounceMs(),
      onPlan: (plan) => {
        // 同 kernel 里的理由：`void promise` 不处理拒绝，必须自己吞掉并记日志。
        void this.#handleReloadPlan(plan).catch((error: unknown) => {
          this.bridge.log('error', `[热重载] 处理变更计划时抛错：${describe(error)}`)
        })
      },
      onError: (error) => {
        // 插件根不存在 / 不可递归监听都只记日志：不该让热重载整体失效。
        this.bridge.log('debug', `[热重载] 监听告警：${describe(error)}`)
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
    for (const entry of this.#entries) this.#dirToId.set(normalizeDir(entry.root), entry.manifest.id)
    for (const problem of result.problems) this.bridge.log('warn', `[发现] ${problem}`)
  }

  /**
   * 处理一次文件变化计划（ADR-0011）。
   *
   * 顺序有意固定：**先重新扫描，再决定重载谁** —— 清单可能改了 id 或依赖，
   * 只按变更前认识的插件去 reload 会得到与清单不一致的状态。
   */
  async #handleReloadPlan(plan: ReloadPlan): Promise<void> {
    const started = Date.now()

    if (plan.rediscover) await this.#refreshEntries()

    const byDir = new Map(this.#entries.map((entry) => [normalizeDir(entry.root), entry]))
    const targets: PluginEntry[] = []
    const removed: string[] = []

    for (const dir of plan.changedDirs) {
      const entry = byDir.get(normalizeDir(dir))
      if (entry !== undefined) {
        targets.push(entry)
        continue
      }
      // 目录已消失 → 卸载它此前对应的插件。保守起见只在"目录确实不存在"时才这么做，
      // 避免一次瞬时 IO 失败把全部插件卸掉。
      const id = this.#dirToId.get(normalizeDir(dir))
      if (id !== undefined && !existsSync(dir)) removed.push(id)
    }

    for (const id of removed) {
      await this.host.unload(id)
      this.bridge.log('info', `[热重载] 插件目录已删除，已卸载 ${id}`)
    }

    for (const entry of targets) {
      const id = entry.manifest.id
      try {
        if (this.host.view(id) === undefined) await this.host.load(entry)
        else await this.host.reload(id)
        await this.host.settle()
        this.bridge.log('info', `[热重载] ${id} → ${this.host.view(id)?.state ?? 'gone'}`)
      } catch (error) {
        // 失败可见、不回滚、不自动重试（ADR-0011 决策 5）：
        // 自动回滚需要旧版本与旧状态同时保活，会让"无残留"这条不变式无法断言。
        this.bridge.log('error', `[热重载] ${id} 失败：${describe(error)}`)
        void vscode.window.showWarningMessage(
          `VSCordis: 热重载 ${id} 失败，插件已进入 failed 状态（不会自动回滚到旧版本）：${describe(error)}`,
        )
      }
    }

    if (targets.length > 0 || removed.length > 0) {
      this.#lastReloadMs = Date.now() - started
      this.#lastReloadAt = new Date()
      this.bridge.log(
        'info',
        `[热重载] 本次耗时 ${this.#lastReloadMs}ms（重载 ${targets.length} 个，卸载 ${removed.length} 个）`,
      )
    }
  }

  #startWatching(): void {
    if (!vscode.workspace.getConfiguration('vscordis').get<boolean>('hotReload', true)) {
      this.bridge.log('info', '热重载已关闭（vscordis.hotReload = false）')
      return
    }
    this.#watcher.refresh()
    this.bridge.log(
      'info',
      `热重载已开启：监听 ${this.#watcher.active} 个插件根，防抖 ${readHotReloadDebounceMs()}ms（改动后请在输出通道核对耗时）`,
    )
  }

  entries(): readonly PluginEntry[] {
    return this.#entries
  }

  problems(): readonly string[] {
    return this.#problems
  }

  async initialize(): Promise<void> {
    await this.#refreshEntries()

    const autoLoad = vscode.workspace.getConfiguration('vscordis').get<boolean>('autoLoad', true)
    if (!autoLoad) {
      this.bridge.log('info', `自动加载已关闭；已发现 ${this.#entries.length} 个插件，等待手动加载`)
    } else {
      for (const entry of this.#entries) {
        try {
          await this.host.load(entry)
        } catch (error) {
          // 单个插件加载失败绝不能影响其它插件，也不能中断宿主启动。
          this.bridge.log('error', `插件 ${entry.manifest.id} 加载失败：${describe(error)}`)
        }
      }
      await this.host.settle()
    }

    // 即使关掉自动加载，热重载也要开：手动加载过的插件同样应该享受改动即生效。
    this.#startWatching()
    if (this.#publicKeyPem === undefined) {
      this.bridge.log(
        'warn',
        '未找到验签公钥 packages/host/keys/vscordis-ed25519.pub.pem：带签名的插件会被拒绝，' +
          'globalStorage 插件将无法加载（生成方式见 docs/signing.md）',
      )
    }
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
    lines.push(
      `隔离子进程：${this.#supportsIsolation ? `可用（${path.relative(this.#extensionUri.fsPath, this.#workerPath)}）` : '不可用 —— untrusted 插件会被拒绝加载'}` +
        ` · 活跃会话 ${this.#isolatedLoader.activeSessions}` +
        (this.#isolatedLoader.activeSessions === 0
          ? ''
          : `（${this.#isolatedLoader.activeSessionIds().join(', ')}）`),
    )
    lines.push(
      `完整性校验：${this.#publicKeyPem === undefined ? '⚠ 未配置验签公钥（带签名的插件会被拒绝）' : '已配置验签公钥'}` +
        ' · globalStorage 插件必须签名（docs/signing.md）',
    )
    const hotReload = vscode.workspace.getConfiguration('vscordis').get<boolean>('hotReload', true)
    const lastReload =
      this.#lastReloadAt === undefined
        ? '尚未发生'
        : `${this.#lastReloadMs}ms @ ${this.#lastReloadAt.toISOString()}`
    lines.push(`热重载：${hotReload ? `开启（监听 ${this.#watcher.active} 个插件根）` : '关闭'} · 上次重载 ${lastReload}`)

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
    this.#watcher.dispose()
    await this.host.dispose()
  }
}

/** 目录比较用的规范化键：Windows 下大小写不敏感。 */
function normalizeDir(dir: string): string {
  const resolved = path.resolve(dir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 读取内置验签公钥。
 *
 * 找不到时返回 undefined —— 此时**任何带签名的插件都会被拒绝**（fail-closed，ADR-0012 决策 4）。
 * 刻意不选择"没公钥就当作未签名放行"：那样攻击者只需删掉公钥文件就能降级整套机制。
 */
function readPublicKey(extensionUri: vscode.Uri): string | undefined {
  const keyPath = path.join(extensionUri.fsPath, 'keys', 'vscordis-ed25519.pub.pem')
  try {
    const value = readFileSync(keyPath, 'utf8')
    return value.trim().length === 0 ? undefined : value
  } catch {
    return undefined
  }
}

function readHotReloadDebounceMs(): number {
  const configured = vscode.workspace.getConfiguration('vscordis').get<number>('hotReloadDebounceMs', 150)
  return Number.isFinite(configured) && configured >= 0 ? configured : 150
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

/**
 * `activate()` 的时限。
 *
 * 默认给到 15s：插件的激活确实可能做网络请求或读大文件，太紧会误杀正常插件。
 * 但**不能没有** —— 没有它的话，一个永不 resolve 的 activate 会把串行队列永久卡住，
 * 连"卸载这个插件"都排在它后面，宿主再也回不来。
 */
function readActivationTimeoutMs(): number {
  const configured = vscode.workspace.getConfiguration('vscordis').get<number>('activationTimeoutMs', 15_000)
  return Number.isFinite(configured) && configured > 0 ? configured : 15_000
}
