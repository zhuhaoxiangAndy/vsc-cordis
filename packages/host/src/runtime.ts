import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { PluginHost, ServiceRegistry, describe, type PluginEntry, type PluginView } from '@vscordis/kernel'
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
  /** 宿主 vscordis 自身的版本，用于强制插件的 `engines.vscordis`（ADR-0017）。 */
  readonly hostVersion: string
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
  /** 宿主侧隔离 API 的兜底释放入口：宿主关闭时注销命令、回收文档句柄。 */
  readonly #vscodeHostApi: VscodeHostApi
  /** 热重载计划串行队列：快速保存产生多个 plan 时不能并发 refresh/load/reload（审计 F2）。 */
  #reloadQueue: Promise<void> = Promise.resolve()
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

    // 注册表在这里显式创建：隔离加载器需要往**同一张**注册表里注册远程服务，
    // 否则"提供者在隔离进程、消费者在同进程"这种组合根本连不上（ADR-0019）。
    const registry = new ServiceRegistry({
      onListenerError: (error) => {
        this.bridge.log('error', '服务注册表监听器抛错', { error: describe(error) })
      },
    })

    const vscodeHostApi = new VscodeHostApi({
      isPluginCommand: (command) => this.bridge.livePluginCommands().some((info) => info.command === command),
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
    })
    this.#vscodeHostApi = vscodeHostApi

    const isolatedLoader = new IsolatedPluginLoader({
      registry,
      hostApi: vscodeHostApi,
      workerPath: this.#workerPath,
      publicKeyPem: this.#publicKeyPem,
      disposeTimeoutMs: readDisposeTimeoutMs(),
      disposeBudgetMs: readDisposeBudgetMs(),
      usePermissionModel: vscode.workspace
        .getConfiguration('vscordis')
        .get<boolean>('isolation.permissionModel', true),
      inheritEnv: vscode.workspace
        .getConfiguration('vscordis')
        .get<boolean>('isolation.inheritEnv', false),
      onUnexpectedExit: (pluginId, error) => {
        this.bridge.log('error', `隔离插件 ${pluginId} 子进程异常退出：${describe(error)}`)
        // 交给 PluginHost 的串行队列处理：把记录从 active 改成 failed，并回收宿主侧副作用。
        void this.host.reportExternalFailure(pluginId, error.message).catch((failure: unknown) => {
          this.bridge.log('error', `标记隔离插件 ${pluginId} failed 时出错：${describe(failure)}`)
        })
      },
      onWarning: (message) => this.bridge.log('warn', message),
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
      registry,
      disposeTimeoutMs: readDisposeTimeoutMs(),
      // 同进程与隔离两种模式必须用**同一个**预算值，否则"卸载最坏耗时"会随 trust 漂移。
      disposeBudgetMs: readDisposeBudgetMs(),
      activationTimeoutMs: readActivationTimeoutMs(),
      // engines 是**强制**检查（ADR-0017），而强制只在这两个版本被真的传进来时才可能发生。
      // 这里曾经漏传：extension.ts 明明把 hostVersion 交给了 Runtime，却没有继续往下传，
      // 于是生产路径上 `plugin.json#engines` 等于没写 —— 又一个"声明了却不生效"。
      hostVersion: options.hostVersion,
      vscodeVersion: vscode.version,
      onTransition: (event) => {
        this.bridge.log('debug', `[状态] ${event.id}: ${event.from} → ${event.to}（${event.reason}）`)
      },
    })

    this.#watcher = new PluginWatcher({
      roots: () => this.#pluginRoots().map((root) => root.dir),
      debounceMs: readHotReloadDebounceMs(),
      onPlan: (plan) => {
        // 串行化：debounce 只能合并同一窗口内的事件；快速保存可能产生多个 plan，
        // 慢 activate 下并发处理会让 refresh/load/reload 交错（审计探针已指出）。
        this.#reloadQueue = this.#reloadQueue
          .then(() => this.#handleReloadPlan(plan))
          .catch((error: unknown) => {
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
    // 重建而不是只 set：目录改名/插件换 id 后，旧映射必须消失，
    // 否则"删除旧目录"会把新目录里活着的同 id 插件误卸载（审计复现）。
    this.#dirToId.clear()
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
    // 先留存旧映射：refresh 会重建 #dirToId，之后就无法知道某个目录以前是哪个 id。
    const previousDirToId = new Map(this.#dirToId)

    if (plan.rediscover) await this.#refreshEntries()

    const byDir = new Map(this.#entries.map((entry) => [normalizeDir(entry.root), entry]))
    const targets: PluginEntry[] = []
    const removed: { readonly id: string; readonly reason: string }[] = []
    const idChanges: { readonly oldId: string; readonly entry: PluginEntry }[] = []

    for (const dir of plan.changedDirs) {
      const key = normalizeDir(dir)
      const entry = byDir.get(key)
      const previousId = previousDirToId.get(key)
      if (entry !== undefined) {
        if (previousId !== undefined && previousId !== entry.manifest.id) {
          // plugin.json#id 变了：同一个目录必须先卸掉旧 id，再按新 id 加载，
          // 否则旧 incarnation 与旧命令会永远活着（违反 ADR-0015 无残留）。
          idChanges.push({ oldId: previousId, entry })
        } else {
          targets.push(entry)
        }
        continue
      }
      if (previousId === undefined) continue

      // 目录/清单已消失 → 卸载旧 incarnation。保守边界：只有确认文件不存在才卸载，
      // 避免编辑器"先截断再写入"之间的瞬时空窗把插件误卸掉（ADR-0011 决策 6/7）。
      if (!existsSync(dir)) {
        removed.push({ id: previousId, reason: '插件目录已删除' })
      } else if (!existsSync(path.join(dir, 'plugin.json'))) {
        removed.push({ id: previousId, reason: 'plugin.json 已删除（目录仍在）' })
      }
    }

    for (const { id, reason } of removed) {
      await this.host.unload(id)
      this.bridge.log('info', `[热重载] ${reason}，已卸载 ${id}`)
    }

    for (const change of idChanges) {
      await this.host.unload(change.oldId)
      this.bridge.log(
        'info',
        `[热重载] 插件 id 变化：${change.oldId} → ${change.entry.manifest.id}，旧 incarnation 已卸载`,
      )
      // 旧 id 卸干净后再走统一加载路径；漏掉这一步会变成"只删不建"。
      targets.push(change.entry)
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
          : `（${this.#isolatedLoader.activeSessionIds().join(', ')}）`) +
        ` · 累计起过 ${this.#isolatedLoader.sessionsStarted}`,
    )
    lines.push(
      `完整性校验：${this.#publicKeyPem === undefined ? '⚠ 未配置验签公钥（带签名的插件会被拒绝）' : '已配置验签公钥'}` +
        ' · globalStorage 插件必须签名（docs/signing.md）',
    )
    // 与"活跃隔离子进程数"同一思路：把"宿主是不是卡住了"变成用户能自己看的数字。
    lines.push(
      `任务队列：深度 ${this.host.queueDepth}` +
        (this.host.queueDepth > 0
          ? '（有生命周期任务在排队/执行；长时间不归零说明某个任务卡住，见 ADR-0015）'
          : '（空闲）'),
    )
    // 展示**生效值**（不是默认值）：排查"为什么卸载要等这么久"时先看这里
    lines.push(
      `回收配置：单项超时 ${readDisposeTimeoutMs()}ms · 整栈预算 ${readDisposeBudgetMs()}ms` +
        (readDisposeBudgetMs() === 0 ? '（已关闭）' : '') +
        '（ADR-0015）',
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
      lines.push(
        `      provides=${view.provides.join(',') || '-'} depends=${Object.entries(view.dependencies).map(([n, r]) => `${n}${r}`).join(',') || '-'}` +
          ` · effects=${view.effectCount}`,
      )
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
    // 先停监听（不再产生新 plan），再等已排队的 plan 跑完，最后才拆宿主。
    await this.#reloadQueue.catch(() => undefined)
    try {
      await this.host.dispose()
    } finally {
      // 兜底释放：即使 host.dispose() 中途抛错，也不让隔离宿主资源留在表里。
      this.#vscodeHostApi.dispose()
    }
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
 * 单个插件整栈回收的总预算（ADR-0015 已知缺口 1）。
 *
 * 默认 30s：单项超时默认 2s，所以"十几个插件同时挂死"也不会把串行队列拖到几分钟。
 * `0` / 负数 = 显式关闭预算（回到"总时长 = N × 单项超时"的旧行为）。
 */
function readDisposeBudgetMs(): number {
  const configured = vscode.workspace.getConfiguration('vscordis').get<number>('disposeBudgetMs', 30_000)
  return Number.isFinite(configured) && configured >= 0 ? configured : 30_000
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
