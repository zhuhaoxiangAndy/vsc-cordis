import { fork, type ChildProcess } from 'node:child_process'
import type { CordisPlugin, Disposable, LogLevel, Permission, PluginContext } from '@vscordis/sdk'
import { PermissionDeniedError, type LoadedPluginModule, type PluginEntry } from '@vscordis/kernel'
import { PluginIntegrityError, verifyPluginArtifact } from '../integrity.ts'
import { buildExecArgv, toIsolatedPermissions, type ExecArgvPlan } from './permissions.ts'
import {
  PROTOCOL_VERSION,
  errorToWire,
  type ChildToHost,
  type HostToChild,
  type SerializedWorkspaceFolder,
} from './protocol.ts'

/**
 * 宿主侧的隔离加载器（M4b）。
 *
 * 它把"插件的生命周期"翻译成"子进程的生命周期"，并保证三件事：
 *
 * 1. **校验在 fork 之前**：先过完整性与签名，再启动进程。顺序颠倒等于没校验。
 * 2. **子进程的寿命挂在宿主 EffectStack 上**：`ctx.effect(() => session, s => s.kill())`。
 *    于是"卸载后无残留"对隔离插件有了更强的等价物 —— 不是"尽力清干净"，而是"进程没了"。
 * 3. **子进程一死就撤销所有宿主侧注册**：否则卸载后会留下幽灵命令
 *    （这正是 M1 验收标准「卸载后命令消失」在隔离模式下的翻版）。
 *
 * 本文件刻意**不 import `vscode`**：宿主能力全部通过注入的 `IsolatedHostApi` 获得。
 * 这样整条链路（真实子进程 + 真实 IPC + 真实 --permission 标志）都能用 node --test 端到端验证。
 */

export interface IsolatedHostApi {
  registerCommand(
    pluginId: string,
    command: string,
    invoke: (args: readonly unknown[]) => Promise<unknown>,
  ): Disposable
  unregisterCommand(command: string): void
  executeCommand(pluginId: string, command: string, args: readonly unknown[]): Promise<unknown>
  showMessage(
    kind: 'information' | 'warning' | 'error',
    message: string,
    items: readonly string[],
  ): Promise<string | undefined>
  createOutputChannel(pluginId: string, name: string): number
  appendOutputLine(handle: number, line: string): void
  disposeOutput(handle: number): void
  workspaceFolders(): readonly SerializedWorkspaceFolder[]
  log(pluginId: string, level: LogLevel, message: string): void
}

export interface IsolatedLoaderOptions {
  readonly hostApi: IsolatedHostApi
  /** 引导脚本的绝对路径（由 esbuild 打到 dist/isolated-worker.cjs）。 */
  readonly workerPath: string
  readonly publicKeyPem: string | undefined
  readonly readyTimeoutMs?: number
  readonly disposeTimeoutMs?: number
  readonly usePermissionModel?: boolean
  readonly onLog?: (message: string) => void
  /** 测试可注入，用来断言 execArgv 的推导结果。 */
  readonly execArgvFor?: (entry: PluginEntry, permissions: ReadonlySet<Permission>) => ExecArgvPlan
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined
  let rejectFn: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

export class PluginIntegrityCheckError extends Error {
  constructor(pluginId: string, reason: string) {
    super(`插件 "${pluginId}" 未通过加载前校验：${reason}`)
    this.name = 'PluginIntegrityCheckError'
  }
}

export class IsolatedPluginLoader {
  readonly #options: IsolatedLoaderOptions
  /**
   * 活跃的隔离会话（pluginId → session）。
   *
   * 它是**泄漏诊断**的关键：子进程是否真的退出了，光看日志不可靠。
   * 有了它，浸泡测试可以直接断言 `activeSessions === 0`，
   * 状态面板也能显示"当前有几个子进程"，而不必去猜。
   */
  readonly #sessions = new Map<string, IsolatedSession>()

  constructor(options: IsolatedLoaderOptions) {
    this.#options = options
  }

  get activeSessions(): number {
    return this.#sessions.size
  }

  activeSessionIds(): readonly string[] {
    return [...this.#sessions.keys()]
  }

  async load(entry: PluginEntry): Promise<LoadedPluginModule> {
    const pluginId = entry.manifest.id
    const permissions = new Set<Permission>(entry.manifest.permissions as readonly Permission[])

    // 1) 校验必须在 fork 之前 —— 否则不可信代码已经跑起来了。
    const outcome = verifyPluginArtifact({
      root: entry.root,
      publicKeyPem: this.#options.publicKeyPem,
      requireSignature: entry.source === 'global',
    })
    if (!outcome.ok) throw new PluginIntegrityError(pluginId, outcome.reason)

    const plan = this.#options.execArgvFor?.(entry, permissions) ??
      buildExecArgv({
        workerPath: this.#options.workerPath,
        pluginRoot: entry.root,
        permissions,
        ...(this.#options.usePermissionModel === undefined
          ? {}
          : { usePermissionModel: this.#options.usePermissionModel }),
      })
    for (const warning of plan.warnings) this.#log(`[${pluginId}] ${warning}`)

    const ref: { session: IsolatedSession | undefined } = { session: undefined }

    const plugin: CordisPlugin = {
      name: pluginId,
      activate: async (ctx: PluginContext): Promise<void> => {
        const session = new IsolatedSession({
          entry,
          plan,
          hostApi: this.#options.hostApi,
          workerPath: this.#options.workerPath,
          readyTimeoutMs: this.#options.readyTimeoutMs ?? 10_000,
          disposeTimeoutMs: this.#options.disposeTimeoutMs ?? 2_000,
          log: (message) => this.#log(message),
        })
        ref.session = session
        // 记账：子进程退出（无论是优雅停用还是被 kill）就把它从活跃表里摘掉。
        this.#sessions.set(pluginId, session)
        void session.waitForExit().then(() => {
          if (this.#sessions.get(pluginId) === session) this.#sessions.delete(pluginId)
        })
        try {
          await session.start()
        } catch (error) {
          session.kill()
          ref.session = undefined
          throw error
        }
        // 2) 子进程的寿命 = 宿主侧的一项副作用。
        //    即使插件本身没有登记任何 effect，卸载时也一定会走到 kill。
        ctx.effect(() => session, (current) => {
          current.kill()
        }, `isolated-child:${pluginId}`)
      },
      deactivate: async (): Promise<void> => {
        const session = ref.session
        ref.session = undefined
        await session?.shutdown()
      },
    }

    return {
      plugin,
      release: (): void => {
        const session = ref.session
        ref.session = undefined
        session?.kill()
        this.#log(`[${pluginId}] 隔离会话已释放`)
      },
    }
  }

  #log(message: string): void {
    this.#options.onLog?.(message)
  }
}

interface SessionOptions {
  readonly entry: PluginEntry
  readonly plan: ExecArgvPlan
  readonly hostApi: IsolatedHostApi
  readonly workerPath: string
  readonly readyTimeoutMs: number
  readonly disposeTimeoutMs: number
  readonly log: (message: string) => void
}

class IsolatedSession {
  readonly #options: SessionOptions
  readonly #pluginId: string
  readonly #ready = deferred<void>()
  readonly #activated = deferred<void>()
  readonly #deactivated = deferred<void>()
  readonly #invokes = new Map<number, Deferred<unknown>>()
  readonly #commandHandles = new Map<string, Disposable>()
  readonly #outputHandles = new Set<number>()
  #child: ChildProcess | undefined
  #exited: Promise<void> = Promise.resolve()
  #requestSeq = 0
  #closed = false

  constructor(options: SessionOptions) {
    this.#options = options
    this.#pluginId = options.entry.manifest.id
  }

  get pluginId(): string {
    return this.#pluginId
  }

  get pid(): number | undefined {
    return this.#child?.pid
  }

  get alive(): boolean {
    const child = this.#child
    if (child === undefined) return false
    // 注意不能用 exitCode === null 单独判断：被信号杀掉时 exitCode 仍是 null，signalCode 才有值。
    return child.exitCode === null && child.signalCode === null
  }

  async start(): Promise<void> {
    const child = fork(this.#options.workerPath, [], {
      execArgv: [...this.#options.plan.execArgv],
      // VSCode 宿主跑在 Electron 里：不设这个变量，fork 会去启动一个完整的 Electron 应用而不是 Node。
      // 在纯 Node 下它是无害的。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // structured clone：至少能保住 undefined / Date / Map / Set（默认的 JSON 序列化会丢）
      serialization: 'advanced',
      silent: true,
      cwd: this.#options.entry.root,
    })
    this.#child = child

    child.stdout?.on('data', (chunk: Buffer) => this.#options.log(`[${this.#pluginId}] ${chunk.toString().trimEnd()}`))
    child.stderr?.on('data', (chunk: Buffer) =>
      this.#options.log(`[${this.#pluginId}] [stderr] ${chunk.toString().trimEnd()}`),
    )
    child.on('message', (message: unknown) => {
      this.#handle(message as ChildToHost)
    })
    child.on('error', (error: Error) => {
      this.#failAll(`子进程错误：${errorToWire(error)}`)
    })

    this.#exited = new Promise<void>((resolve) => {
      child.on('exit', (code, signal) => {
        this.#cleanupHostSide()
        const detail = `退出码 ${code ?? 'null'} / 信号 ${signal ?? 'none'}`
        if (!this.#closed) this.#options.log(`[${this.#pluginId}] 子进程退出（${detail}）`)
        this.#deactivated.resolve()
        resolve()
      })
    })

    await withTimeout(this.#ready.promise, this.#options.readyTimeoutMs, `等待子进程就绪（${this.#pluginId}）`)

    this.#send({
      kind: 'activate',
      protocolVersion: PROTOCOL_VERSION,
      pluginId: this.#pluginId,
      pluginEntry: this.#options.entry.mainPath,
      permissions: toIsolatedPermissions(new Set(this.#options.entry.manifest.permissions as readonly Permission[])),
      workspaceFolders: this.#options.hostApi.workspaceFolders(),
      disposeTimeoutMs: this.#options.disposeTimeoutMs,
    })

    await withTimeout(this.#activated.promise, this.#options.readyTimeoutMs, `等待插件激活（${this.#pluginId}）`)
  }

  /** 反向调用：宿主执行命令时，请求子进程里的 handler 求值。 */
  async invokeCommand(command: string, args: readonly unknown[]): Promise<unknown> {
    if (!this.alive) throw new Error(`插件 ${this.#pluginId} 的子进程已退出，无法执行 ${command}`)
    const requestId = ++this.#requestSeq
    const pending = deferred<unknown>()
    this.#invokes.set(requestId, pending)
    this.#send({ kind: 'invoke', requestId, command, args })
    return await pending.promise
  }

  /** 优雅停用：让子进程自己收尾并 LIFO 回收副作用，超时后由 kill 兜底。 */
  async shutdown(): Promise<void> {
    if (!this.alive) return
    this.#closed = true
    this.#send({ kind: 'deactivate' })
    try {
      await withTimeout(this.#deactivated.promise, this.#options.disposeTimeoutMs, `等待插件停用（${this.#pluginId}）`)
    } catch (error) {
      this.#options.log(`[${this.#pluginId}] 优雅停用失败，改用强制终止：${errorToWire(error)}`)
      this.kill()
    }
  }

  /** 强制终止。幂等。 */
  kill(): void {
    this.#closed = true
    this.#cleanupHostSide()
    const child = this.#child
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGKILL')
    }
    this.#failAll(`插件 ${this.#pluginId} 的隔离会话已终止`)
  }

  async waitForExit(): Promise<void> {
    await this.#exited
  }

  // ————————————————————————————————— 内部

  #send(message: HostToChild): void {
    try {
      this.#child?.send(message)
    } catch (error) {
      this.#options.log(`[${this.#pluginId}] 向子进程发送消息失败：${errorToWire(error)}`)
    }
  }

  #handle(message: ChildToHost): void {
    switch (message.kind) {
      case 'ready':
        this.#ready.resolve()
        break
      case 'activated':
        this.#activated.resolve()
        break
      case 'deactivated':
        this.#deactivated.resolve()
        break
      case 'failed':
        this.#activated.reject(new Error(message.error))
        this.#ready.resolve()
        break
      case 'log':
        this.#options.hostApi.log(this.#pluginId, message.level, message.message)
        break
      case 'call':
        void this.#handleCall(message)
        break
      case 'result': {
        const pending = this.#invokes.get(message.requestId)
        if (pending === undefined) return
        this.#invokes.delete(message.requestId)
        if (message.ok) pending.resolve(message.value)
        else pending.reject(new Error(message.error))
        break
      }
    }
  }

  async #handleCall(call: Extract<ChildToHost, { kind: 'call' }>): Promise<void> {
    const pluginId = this.#pluginId
    const granted = new Set<Permission>(this.#options.entry.manifest.permissions as readonly Permission[])

    const require = (...candidates: Permission[]): void => {
      if (candidates.some((candidate) => granted.has(candidate))) return
      // 宿主侧鉴权是**权威**的：绝不因为"子进程说自己有权限"就放行。
      throw new PermissionDeniedError(pluginId, candidates.join(' 或 '), String(call.method))
    }

    try {
      switch (call.method) {
        case 'commands.registerCommand': {
          require('vscode:commands.register')
          const command = String(call.args[0] ?? '')
          const handle = this.#options.hostApi.registerCommand(pluginId, command, (args) =>
            this.invokeCommand(command, args),
          )
          this.#commandHandles.set(command, handle)
          this.#reply(call.id, undefined)
          break
        }
        case 'commands.unregisterCommand': {
          // 撤销不做权限校验：否则权限被回收后旧命令会永远摘不掉。
          const command = String(call.args[0] ?? '')
          this.#commandHandles.get(command)?.dispose()
          this.#commandHandles.delete(command)
          this.#options.hostApi.unregisterCommand(command)
          this.#reply(call.id, undefined)
          break
        }
        case 'commands.executeCommand': {
          require('vscode:commands.execute', 'vscode:commands.execute.any')
          const command = String(call.args[0] ?? '')
          const args = Array.isArray(call.args[1]) ? (call.args[1] as unknown[]) : []
          this.#reply(call.id, await this.#options.hostApi.executeCommand(pluginId, command, args))
          break
        }
        case 'window.showInformationMessage':
        case 'window.showWarningMessage':
        case 'window.showErrorMessage': {
          require('vscode:window.messages')
          const kind =
            call.method === 'window.showInformationMessage'
              ? 'information'
              : call.method === 'window.showWarningMessage'
                ? 'warning'
                : 'error'
          this.#reply(call.id, await this.#options.hostApi.showMessage(kind, String(call.args[0] ?? ''), []))
          break
        }
        case 'window.createOutputChannel': {
          require('vscode:window.output')
          const handle = this.#options.hostApi.createOutputChannel(pluginId, String(call.args[0] ?? pluginId))
          this.#outputHandles.add(handle)
          this.#reply(call.id, { handle })
          break
        }
        case 'output.appendLine': {
          require('vscode:window.output')
          const handle = Number(call.args[0])
          if (!this.#outputHandles.has(handle)) throw new Error(`未知的输出通道句柄：${handle}`)
          this.#options.hostApi.appendOutputLine(handle, String(call.args[1] ?? ''))
          this.#reply(call.id, undefined)
          break
        }
        case 'output.dispose': {
          require('vscode:window.output')
          const handle = Number(call.args[0])
          if (this.#outputHandles.delete(handle)) this.#options.hostApi.disposeOutput(handle)
          this.#reply(call.id, undefined)
          break
        }
        case 'log': {
          this.#options.hostApi.log(pluginId, 'info', String(call.args[0] ?? ''))
          this.#reply(call.id, undefined)
          break
        }
      }
    } catch (error) {
      this.#replyError(call.id, errorToWire(error))
    }
  }

  #reply(id: number, value: unknown): void {
    this.#send({ kind: 'response', id, ok: true, value })
  }

  #replyError(id: number, error: string): void {
    this.#send({ kind: 'response', id, ok: false, error })
  }

  /**
   * 子进程退出/被杀时，撤销**所有**宿主侧注册。
   * 少了这一步，卸载后命令面板代理里会残留幽灵命令 —— 与 M1 那条验收标准同源。
   */
  #cleanupHostSide(): void {
    for (const [, handle] of this.#commandHandles) {
      try {
        handle.dispose()
      } catch {
        // 撤销失败不应影响其余清理
      }
    }
    this.#commandHandles.clear()

    for (const handle of this.#outputHandles) {
      try {
        this.#options.hostApi.disposeOutput(handle)
      } catch {
        // 同上
      }
    }
    this.#outputHandles.clear()
  }

  #failAll(reason: string): void {
    for (const [, pending] of this.#invokes) pending.reject(new Error(reason))
    this.#invokes.clear()
  }
}

export async function withTimeout<T>(value: T | Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} 超时（>${ms}ms）`))
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
