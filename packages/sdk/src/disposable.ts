/**
 * 可逆副作用的两种表示。
 *
 * - `Disposable`：VSCode 生态的原生表示（`{ dispose(): void }`），结构化兼容 `vscode.Disposable`。
 * - `Teardown`：函数式表示，允许异步。`EffectStack` 同时接受两者。
 */

export interface Disposable {
  dispose(): void
}

export type MaybePromise<T> = T | Promise<T>

export type Teardown = () => void | Promise<void>

export const NOOP_DISPOSABLE: Disposable = Object.freeze({
  dispose(): void {
    /* intentionally empty */
  },
})

/** 把任意对象包装成幂等的 Disposable：重复 dispose 只生效一次。 */
export function toDisposable(fn: Teardown): Disposable {
  let done = false
  return {
    dispose(): void {
      if (done) return
      done = true
      void fn()
    },
  }
}
