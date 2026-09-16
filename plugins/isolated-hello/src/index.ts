import type { CordisPlugin } from '@vscordis/sdk'

/**
 * M4b / M4c 示例：一个声明 `trust: untrusted` 的插件，运行在**独立子进程**里。
 *
 * 它演示了隔离模式已经具备的能力，以及"同步语义是怎么保住的"：
 * - **配置**：`getConfiguration().get()` 在子进程里是**同步**的 ——
 *   宿主按 plugin.json 的 `configuration.keys` 预取快照，配置变化时主动推送（ADR-0016）。
 *   可以在 settings.json 里写 `"isolated-hello.greeting": "你好"` 观察推送生效。
 * - **状态栏项**：`item.text = ...` 之后立刻读回就是新值（本地镜像），
 *   而变更通过一条串行 RPC 队列同步到宿主 —— 顺序有保证，不会出现"显示了但文字还是旧的"。
 *
 * 它**不能**用 `ctx.use` / `ctx.provide`（服务是进程内对象），也**不能**订阅文档事件 ——
 * 理由在 ADR-0016 里，是设计边界而不是待办。
 */
export default {
  name: 'isolated-hello',

  activate(ctx) {
    const api = ctx.vscode

    const channel = api.window.createOutputChannel('Isolated Hello')

    // 状态栏项：本地镜像 + 串行 RPC
    const status = api.window.createStatusBarItem(1, 100)
    status.text = '$(shield) isolated'
    status.tooltip = 'isolated-hello 正在子进程里运行'
    status.command = 'isolated-hello.greet'
    status.show()

    ctx.effect(() => status, (item) => item.dispose(), 'status:isolated-hello')

    ctx.effect(
      () => api.commands.registerCommand('isolated-hello.greet', (name?: unknown) => {
        const configured = api.workspace.getConfiguration('isolated-hello').get('greeting', '你好')
        const who = typeof name === 'string' && name.length > 0 ? name : String(configured)
        void api.window.showInformationMessage(`来自隔离子进程：${who}`)
        return `pong:${who}`
      }),
      (disposable) => disposable.dispose(),
      'command:isolated-hello.greet',
    )

    channel.appendLine(`隔离插件已激活；工作区数量：${api.workspace.workspaceFolders?.length ?? 0}`)
    channel.appendLine(
      `配置 isolated-hello.greeting = ${String(
        api.workspace.getConfiguration('isolated-hello').get('greeting', '<未设置>'),
      )}`,
    )
    ctx.log.info('isolated-hello 已激活（运行在子进程里）')
  },

  async deactivate(ctx) {
    ctx.log.info('isolated-hello 正在停用：子进程先 LIFO 回收副作用，宿主再兜底 kill')
  },
} satisfies CordisPlugin
