import type { CordisPlugin } from '@vscordis/sdk'

/**
 * 消费者插件。
 *
 * 刻意**不**从 provider-clock 导入任何东西：契约由消费者自己用结构化类型声明。
 * 这正是"依赖契约而非实现"（ADR-0007 决策 1）—— 提供者换成 `provider-clock-v2`
 * 只要仍然提供 `clock@^1.0.0`，这里一行都不用改。
 */
interface Clock {
  readonly label: string
  now(): Date
}

export default {
  name: 'consumer-greeting',

  // 静态声明硬依赖。与 plugin.json 的 dependencies 合并：
  // manifest 里的范围（^1.0.0）用于解析，这里的名字用于"依赖缺失就 parked"。
  inject: ['clock'],

  activate(ctx) {
    const clock = ctx.use<Clock>('clock')

    ctx.effect(
      () => ctx.vscode.commands.registerCommand('greeting.time', () => {
        void ctx.vscode.window.showInformationMessage(`[${clock.label}] ${clock.now().toLocaleTimeString()}`)
      }),
      (disposable) => disposable.dispose(),
      'command:greeting.time',
    )

    ctx.log.info(`已注入 clock 服务：${clock.label}`)
  },

  async deactivate(ctx) {
    ctx.log.warn('clock 提供者消失（或本插件被重载）：命令已被撤销，等待 provider 回来即可自动恢复')
  },
} satisfies CordisPlugin
