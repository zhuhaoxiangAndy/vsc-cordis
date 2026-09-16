/**
 * 错误类型。全部继承 `VscordisError`，便于宿主用一次 `instanceof` 区分
 * "插件/运行时语义错误"与"宿主内部 bug"。
 */

export class VscordisError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** 服务不存在（从未被提供，或提供者已卸载）。 */
export class ServiceUnavailableError extends VscordisError {
  readonly service: string
  readonly range: string | undefined

  constructor(service: string, range?: string) {
    super(`服务 "${service}"${range === undefined ? '' : ` (${range})`} 当前没有可用的提供者`)
    this.service = service
    this.range = range
  }
}

/** 服务存在，但版本不满足依赖方的范围要求。 */
export class ServiceVersionMismatchError extends VscordisError {
  readonly service: string
  readonly range: string
  readonly actual: string | undefined

  constructor(service: string, range: string, actual: string | undefined) {
    super(`服务 "${service}" 的版本 ${actual ?? '<未声明>'} 不满足范围 ${range}`)
    this.service = service
    this.range = range
    this.actual = actual
  }
}

/** 同名服务已被别的插件提供，且策略为 exclusive（默认，ADR-0007 决策 3）。 */
export class ServiceConflictError extends VscordisError {
  readonly service: string
  readonly existingOwner: string
  readonly incomingOwner: string

  constructor(service: string, existingOwner: string, incomingOwner: string) {
    super(
      `服务 "${service}" 已由插件 "${existingOwner}" 提供，` +
        `插件 "${incomingOwner}" 不得重复提供（如需覆盖请显式使用 conflict: 'last-wins'）`,
    )
    this.service = service
    this.existingOwner = existingOwner
    this.incomingOwner = incomingOwner
  }
}

/** 插件调用了未授权的能力（ADR-0005 决策 2：fail loud）。 */
export class PermissionDeniedError extends VscordisError {
  readonly permission: string
  readonly pluginId: string

  constructor(pluginId: string, permission: string, detail?: string) {
    super(`插件 "${pluginId}" 未获得权限 "${permission}"${detail === undefined ? '' : `（${detail}）`}`)
    this.pluginId = pluginId
    this.permission = permission
  }
}

/** 不可信插件缺少可用的隔离后端 → 拒绝加载（ADR-0003 fail-closed）。 */
export class IsolationUnavailableError extends VscordisError {
  readonly pluginId: string
  readonly platform: string

  constructor(pluginId: string, platform: string) {
    super(
      `插件 "${pluginId}" 声明 trust: untrusted，但当前平台 (${platform}) 没有可用的隔离后端。` +
        `拒绝加载：绝不以同进程方式降级执行不可信代码。`,
    )
    this.pluginId = pluginId
    this.platform = platform
  }
}

export class PluginAlreadyLoadedError extends VscordisError {
  constructor(pluginId: string, state: string) {
    super(`插件 "${pluginId}" 已处于 ${state} 状态，如需重新加载请先卸载或使用 reload`)
  }
}

export class InvalidManifestError extends VscordisError {
  readonly errors: readonly string[]

  constructor(source: string, errors: readonly string[]) {
    super(`插件清单非法 (${source})：\n  - ${errors.join('\n  - ')}`)
    this.errors = errors
  }
}

/**
 * 插件的 `engines` 声明与当前运行环境不兼容（ADR-0017）。
 *
 * 这是**强制**检查而不是提示：`engines` 以前被校验器静默丢弃，
 * 于是作者写了等于没写 —— 正是本项目一直在消除的那类陷阱。
 */
export class PluginEngineMismatchError extends VscordisError {
  readonly pluginId: string
  readonly problems: readonly string[]

  constructor(pluginId: string, problems: readonly string[]) {
    super(
      `插件 "${pluginId}" 与当前运行环境不兼容：${problems.join('；')}。` +
        'engines 是强制检查，请升级宿主扩展或改用兼容版本的插件。',
    )
    this.name = 'PluginEngineMismatchError'
    this.pluginId = pluginId
    this.problems = problems
  }
}

/**
 * 该服务由**隔离子进程**提供，只能用显式异步面取用（ADR-0019）。
 *
 * 为什么必须拒绝而不是"返回一个方法变成 Promise 的代理"：
 * `ctx.use('clock')` 的类型是同步的（`clock.now()` 返回 `Date`）。
 * 返回异步代理会让类型撒谎 —— 插件在运行时才发现拿到的是 Promise。
 * 所以同步入口在这里**响亮失败**，并把替代路径写在错误信息里。
 */
export class RemoteServiceError extends VscordisError {
  readonly service: string
  readonly provider: string

  constructor(service: string, provider: string) {
    super(
      `服务 "${service}" 由隔离插件 "${provider}" 提供，不能用 ctx.use 同步取用。` +
        '请改用 **ctx.async.useService(name)** —— 它返回的方法都是异步的（两种模式下签名一致）。',
    )
    this.name = 'RemoteServiceError'
    this.service = service
    this.provider = provider
  }
}
