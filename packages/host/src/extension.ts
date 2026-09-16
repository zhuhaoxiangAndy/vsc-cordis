import * as vscode from 'vscode'
import { Runtime } from './runtime.ts'

/**
 * Node 扩展宿主入口（Desktop / Remote-SSH / WSL / Dev Container）。
 *
 * 这里刻意保持极薄：真正的逻辑在 kernel，装配在 Runtime。
 * 宿主自己只做两件事：创建输出通道、把 Runtime 的生命周期挂到 VSCode 上。
 */

let runtime: Runtime | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('VSCordis', { log: true })
  context.subscriptions.push(output)

  runtime = new Runtime({
    output,
    extensionUri: context.extensionUri,
    globalStorageUri: context.globalStorageUri,
    // engines 是强制检查，所以把自己声明的版本传进去；缺省回落到 '0.0.0'
    // （此时任何 engines.vscordis 声明都会判不兼容 —— 宁可拒绝也不要静默跳过）。
    hostVersion: typeof context.extension.packageJSON.version === 'string' ? context.extension.packageJSON.version : '0.0.0',
  })

  context.subscriptions.push(...runtime.registerCommands())
  await runtime.initialize()

  output.info('VSCordis 已激活。命令：vscordis: 运行插件命令… / 加载 / 卸载 / 重载 / 卸载全部 / 显示运行时状态')
}

/**
 * VSCode 的 `deactivate` 只在扩展宿主退出时调用 —— 它是**兜底**而不是"活体摘除"机制
 * （官方不支持运行期卸载单个扩展，见 ADR-0003）。插件级的卸载由 `vscordis.unloadPlugin` 完成。
 */
export async function deactivate(): Promise<void> {
  const current = runtime
  runtime = undefined
  await current?.dispose()
}
