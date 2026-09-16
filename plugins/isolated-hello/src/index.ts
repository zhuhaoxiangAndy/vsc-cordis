import type { CordisPlugin } from '@vscordis/sdk'

/**
 * M4b 示例：一个声明 `trust: untrusted` 的插件。
 *
 * 它**运行在独立子进程里**：
 * - 进程里根本没有 `vscode` 模块（`require('vscode')` 会失败，这是真边界）；
 * - 文件系统被 Node 权限模型限制在插件自己的目录内；
 * - 它的命令 handler 留在子进程，宿主执行命令时反向调用它求值。
 *
 * 因此这个插件的代码与 in-process 插件写法完全一致 —— 差异全部体现在运行时边界上。
 */
export default {
  name: 'isolated-hello',

  activate(ctx) {
    const channel = ctx.vscode.window.createOutputChannel('Isolated Hello')
    channel.appendLine(`隔离插件已激活，可见工作区数量：${ctx.vscode.workspace.workspaceFolders?.length ?? 0}`)

    ctx.effect(
      () => ctx.vscode.commands.registerCommand('isolated-hello.greet', (name?: unknown) => {
        const who = typeof name === 'string' && name.length > 0 ? name : 'world'
        void ctx.vscode.window.showInformationMessage(`来自隔离子进程的问候：${who}`)
        return `pong:${who}`
      }),
      (disposable) => disposable.dispose(),
      'command:isolated-hello.greet',
    )

    ctx.log.info(`isolated-hello 已激活（pid=${'(见宿主日志)'}）`)
  },

  async deactivate(ctx) {
    ctx.log.info('isolated-hello 正在停用：子进程会先 LIFO 回收副作用，再由宿主兜底 kill')
  },
} satisfies CordisPlugin
