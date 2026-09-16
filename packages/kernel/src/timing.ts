/**
 * 超时控制的唯一实现点。
 *
 * 两个易错点在这里一次性处理掉：
 * 1. 定时器必须在 promise 先完成时被 `clearTimeout`，否则测试进程会被拖住不退出；
 * 2. 超时**不等于**副作用已停止 —— 调用方必须另外通过 `AbortSignal` 通知插件主动退出（ADR-0007 决策 6）。
 */
export class TimeoutError extends Error {
  constructor(ms: number, what: string) {
    super(`${what} 超时（>${ms}ms）`)
    this.name = 'TimeoutError'
  }
}

export async function withTimeout<T>(
  value: T | Promise<T>,
  ms: number | undefined,
  what = '操作',
): Promise<T> {
  if (ms === undefined || ms <= 0) return await value
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new TimeoutError(ms, what))
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
