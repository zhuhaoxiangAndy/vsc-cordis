import type { CordisPlugin } from '@vscordis/sdk'

/** 服务契约（结构性）：消费者不需要共享包，只需要"形状一致"。 */
export interface Clock {
  readonly label: string
  now(): Date
}

/**
 * 模块级状态 —— 每次重新加载/热重载都会重置。
 * 这不是装饰，而是"卸载后无残留"最直观的可观测证据：
 * 若 `require.cache` 没清干净，重载后 label 仍是旧值。
 */
let generation = 0

export default {
  name: 'provider-clock',

  activate(ctx) {
    generation += 1
    const clock: Clock = {
      label: `clock#${generation}`,
      now: () => new Date(),
    }

    // provide 返回的 Disposable 会被自动登记到本插件的 EffectStack 上，
    // 于是"提供者卸载 → 服务撤销 → 消费者 paused"这条级联自动发生（ADR-0007 决策 5）。
    ctx.provide<Clock>('clock', clock, { version: '1.0.0' })

    ctx.effect(
      () => ctx.vscode.commands.registerCommand('clock.label', () => clock.label),
      (disposable) => disposable.dispose(),
      'command:clock.label',
    )

    ctx.log.info(`已提供 clock 服务：${clock.label}`)
  },

  async deactivate(ctx) {
    ctx.log.info('clock 提供者正在卸载：依赖 clock 的插件将自动 paused')
  },
} satisfies CordisPlugin
