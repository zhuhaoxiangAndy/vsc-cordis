import type { CordisPlugin } from '@vscordis/sdk'

/**
 * M1 PoC 插件。
 *
 * 演示三件事：
 * 1. 所有副作用都经 `ctx.effect` 登记（命令 ×2、输出通道 ×1）；
 * 2. 只用 `ctx.vscode` 受控面，**产物里不出现一行 `require('vscode')`**（构建期强制）；
 * 3. `deactivate` 先于副作用回收执行，所以它还能安全地写日志。
 */
export default {
  name: 'hello',

  activate(ctx) {
    const api = ctx.vscode

    ctx.effect(
      () => api.commands.registerCommand('hello.greet', (name?: unknown) => {
        const who = typeof name === 'string' && name.length > 0 ? name : 'VSCordis'
        void api.window.showInformationMessage(`Hello, ${who}！来自插件 ${ctx.id}`)
      }),
      (disposable) => disposable.dispose(),
      'command:hello.greet',
    )

    ctx.effect(
      () => api.commands.registerCommand('hello.echo', (text?: unknown) => String(text ?? '')),
      (disposable) => disposable.dispose(),
      'command:hello.echo',
    )

    const channel = ctx.effect(
      () => api.window.createOutputChannel('VSCordis Hello'),
      (created) => created.dispose(),
      'output:hello',
    )
    channel.appendLine(`hello 插件于 ${new Date().toISOString()} 激活`)

    ctx.log.info(`hello 已激活：已注册 2 个命令 + 1 个输出通道（effects=${ctx.effects.size}）`)
  },

  async deactivate(ctx) {
    ctx.log.info(`hello 正在卸载：${ctx.effects.size} 项副作用即将被 LIFO 逆序回收`)
  },
} satisfies CordisPlugin
