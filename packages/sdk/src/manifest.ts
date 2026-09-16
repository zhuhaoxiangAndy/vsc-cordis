/**
 * plugin.json 的**类型契约**（校验策略在 @vscordis/kernel，见 ADR-0001 分层）。
 */

/** `trusted` = 同进程加载（只防误用）；`untrusted` = 必须进程隔离，无后端时拒绝加载（ADR-0003）。 */
export type PluginTrust = 'trusted' | 'untrusted'

export interface PluginManifest {
  /** 反向域名风格唯一 id，例如 `hello` 或 `com.example.hello` */
  readonly id: string
  readonly name: string
  /** 语义化版本 `x.y.z` */
  readonly version: string
  /** 相对插件根目录的入口文件，必须是打包后的单文件 CJS（ADR-0009） */
  readonly main: string
  readonly description?: string
  /**
   * 依赖的**服务名** → 版本范围（不是插件 id，见 ADR-0007）。
   * 支持的最小范围子集：`*`、`1.2.3`、`^1.2.3`、`>=1.2.3`。
   */
  readonly dependencies?: Readonly<Record<string, string>>
  /**
   * **声明**本插件会提供的服务名（运行期仍以 `ctx.provide()` 为准）。
   *
   * 为什么需要它：服务是运行期注册的，静态工具（`vscordis tree` 依赖图、冲突检查、
   * 加载顺序推导）无法从代码里可靠地推出"谁会提供什么"。
   *
   * 声明与实际不一致**不会**导致加载失败 —— 但宿主会在激活后比对二者并**告警**
   * （见 ADR-0014）。这是刻意的：声明只服务于工具，运行期事实才是权威。
   */
  readonly provides?: readonly string[]
  /** 权限白名单；未声明 = 未授予（ADR-0005） */
  readonly permissions?: readonly string[]
  readonly trust?: PluginTrust
  readonly engines?: {
    readonly vscordis?: string
    readonly vscode?: string
  }
}
