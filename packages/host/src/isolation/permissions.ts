import type { Permission } from '@vscordis/sdk'
import type { IsolatedPermissions } from './protocol.ts'

/**
 * 权限 → 隔离参数 的映射。
 *
 * 这里要如实区分两种强度（ADR-0005 已记录的证据）：
 *
 * - **强制**：`fs:read` / `fs:write` / `process:spawn` 由 Node 权限模型
 *   （`--permission` + `--allow-*`）真正拦截。子进程试图读取白名单外的文件会拿到 `ERR_ACCESS_DENIED`。
 * - **约定**：`net` **没有**对应的 Node 开关，只能在子进程里拦截 `require('net'|'http'|…)`。
 *   这是防误用，不是强制封禁 —— 必须写进返回值里的 `warnings`，不能被静默吞掉。
 *
 * 另外 `--permission` 会顺带封掉 `worker` / `addons` / `wasi` / `inspector` —— 这正是我们想要的默认值。
 */

export interface ExecArgvPlan {
  readonly execArgv: readonly string[]
  /** 必须回显给用户的降级说明（为空表示没有降级）。 */
  readonly warnings: readonly string[]
}

export interface ExecArgvOptions {
  /** 子进程引导脚本的绝对路径。Node 权限模型下它也必须被显式允许读取。 */
  readonly workerPath: string
  /** 插件根目录：可读；只有拿到 `fs:write` 才可写。 */
  readonly pluginRoot: string
  readonly permissions: ReadonlySet<Permission>
  /**
   * 是否使用 Node 权限模型。默认 true。
   * 某些 Electron/VSCode 组合可能不支持 `--permission`，此时可关闭 —— 但必须明白：
   * 关掉之后隔离强度只剩"没有 vscode 模块 + 只能走受控 RPC"，fs/子进程不再被强制拦截。
   */
  readonly usePermissionModel?: boolean
}

export function buildExecArgv(options: ExecArgvOptions): ExecArgvPlan {
  const warnings: string[] = []
  const { permissions } = options

  if (options.usePermissionModel === false) {
    warnings.push(
      '已关闭 Node 权限模型（vscordis.isolation.permissionModel=false）：' +
        '文件系统与子进程不再被强制拦截，隔离强度降级为"无 vscode 模块 + 受控 RPC"。',
    )
    return { execArgv: [], warnings }
  }

  const execArgv: string[] = [
    '--permission',
    // Node 权限模型要求显式允许读取模块本身，否则连引导脚本都加载不了。
    `--allow-fs-read=${options.workerPath}`,
    `--allow-fs-read=${options.pluginRoot}`,
  ]

  if (permissions.has('fs:write')) {
    // 只放开插件自己的目录，不放开工作区 —— 需要写工作区的插件请显式申请（M4c 会加 fs:write:workspace）。
    execArgv.push(`--allow-fs-write=${options.pluginRoot}`)
  }

  if (permissions.has('process:spawn')) {
    execArgv.push('--allow-child-process')
    warnings.push('该插件被授予 process:spawn：它可以启动任意子进程，隔离强度显著下降。')
  }

  if (permissions.has('net')) {
    warnings.push(
      '该插件申请了 net 权限，但 Node 权限模型**没有**网络开关：' +
        '网络只能靠子进程内的 require 拦截（防误用，不防恶意）。见 ADR-0005。',
    )
  }

  return { execArgv, warnings }
}

export function toIsolatedPermissions(permissions: ReadonlySet<Permission>): IsolatedPermissions {
  const has = (permission: Permission): boolean => permissions.has(permission)
  return {
    commands: {
      register: has('vscode:commands.register'),
      execute: has('vscode:commands.execute') || has('vscode:commands.execute.any'),
      executeAny: has('vscode:commands.execute.any'),
    },
    window: {
      messages: has('vscode:window.messages'),
      output: has('vscode:window.output'),
    },
    workspace: {
      read: has('vscode:workspace.read'),
      configRead: has('vscode:workspace.config.read'),
      configWrite: has('vscode:workspace.config.write'),
    },
    fsRead: has('fs:read'),
    fsWrite: has('fs:write'),
    processSpawn: has('process:spawn'),
    net: has('net'),
  }
}
