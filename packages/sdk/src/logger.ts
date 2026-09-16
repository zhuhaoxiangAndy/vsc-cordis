export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

/**
 * 插件可用的日志通道。宿主注入实现（通常转发到 VSCode 的 OutputChannel）。
 * 刻意不暴露 `console` 全局：日志必须带插件 id 前缀，便于定位残留与越权。
 */
export interface Logger {
  trace(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, error?: unknown): void
}

export const NULL_LOGGER: Logger = Object.freeze({
  trace(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
})

/** 在每条消息前加上 `[pluginId]` 前缀，保证多插件共用一个输出通道时可区分。 */
export function prefixLogger(id: string, sink: Logger): Logger {
  const tag = `[${id}]`
  return {
    trace: (m, ...a) => sink.trace(`${tag} ${m}`, ...a),
    debug: (m, ...a) => sink.debug(`${tag} ${m}`, ...a),
    info: (m, ...a) => sink.info(`${tag} ${m}`, ...a),
    warn: (m, ...a) => sink.warn(`${tag} ${m}`, ...a),
    error: (m, e) => sink.error(`${tag} ${m}`, e),
  }
}
