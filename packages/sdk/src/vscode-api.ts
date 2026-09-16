import type * as vscode from 'vscode'

/**
 * 暴露给插件的 VSCode API **受控子集**。
 *
 * 两条硬约束：
 * 1. 类型直接从真实 API 派生（`typeof` + `Pick`），宿主实现不可能与 `@types/vscode` 漂移；
 * 2. 运行时是权限代理，每个成员在被**调用时刻**校验权限（ADR-0005）。
 *
 * 注意这里是 `import type`：编译后完全消失，插件运行时**不会**去 require('vscode')。
 * 这一步很关键——扩展宿主会把 `vscode` 模块注入给任何扩展目录下的模块（ADR-0003 证据 1），
 * 我们唯一的防线是"插件产物里不出现 require('vscode')"（构建期强制）+ 受控代理。
 */
export type PluginVscodeApi = {
  readonly commands: Pick<typeof vscode.commands, 'registerCommand' | 'executeCommand'>
  readonly window: Pick<
    typeof vscode.window,
    | 'showInformationMessage'
    | 'showWarningMessage'
    | 'showErrorMessage'
    | 'createStatusBarItem'
    | 'createOutputChannel'
    | 'onDidChangeActiveTextEditor'
  >
  readonly workspace: Pick<
    typeof vscode.workspace,
    'workspaceFolders' | 'getConfiguration' | 'onDidSaveTextDocument'
  >
  /** 构造函数类成员是无副作用的工具，直接放行。 */
  readonly Uri: typeof vscode.Uri
  readonly Disposable: typeof vscode.Disposable
  readonly EventEmitter: typeof vscode.EventEmitter
}
