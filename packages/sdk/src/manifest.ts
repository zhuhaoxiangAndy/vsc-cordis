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
  /** 权限白名单；未声明 = 未授予（ADR-0005） */
  readonly permissions?: readonly string[]
  readonly trust?: PluginTrust
  readonly engines?: {
    readonly vscordis?: string
    readonly vscode?: string
  }
}
