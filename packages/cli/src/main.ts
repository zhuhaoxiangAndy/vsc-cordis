import { flagString, flagValue, hasFlag, parseArgs } from './args.ts'
import { runCreate, runDev, runList, runSign, runTree, type CommandContext } from './commands.ts'

export const HELP = `vscordis —— 把 Cordis 的时空可组合性带到 VSCode 插件

用法：
  vscordis <命令> [参数] [--flag]

命令：
  create <名字>          生成一个插件骨架
    --dir <目录>         输出到哪个插件根（默认 plugins）
    --trust trusted|untrusted   信任级别（默认 trusted）

  list                   列出插件并做依赖图检查
    --root <目录>        插件根（默认 plugins）

  tree                   打印服务依赖图
    --root <目录>        插件根（默认 plugins）
    --mermaid            输出 Mermaid flowchart（可直接贴进 Markdown）

  sign <插件目录>        签名插件（写入 integrity 与 plugin.sig）
    --key <私钥路径>     默认 %USERPROFILE%\\.dsh\\keys\\vscordis-ed25519.pem
    --verify             签完立刻用仓库公钥回验

  dev                    监听插件源码变化并增量重建（配合宿主热重载）
    --root <目录>        插件根（默认 plugins）

  help                   显示本帮助

退出码：0 成功 / 1 发现问题 / 2 用法错误

注意：静态依赖图依据 plugin.json 的 provides 声明；服务的**版本**由运行期
      ctx.provide(name, value, { version }) 决定，静态图无法校验（见 ADR-0014）。`

/**
 * 命令分发。与 `bin.ts` 分开是为了**可测试**：测试直接调 `main(argv, cwd)`，
 * 不会执行 bin 里的 `process.exitCode = ...` 副作用。
 */
export async function main(argv: readonly string[], cwd: string): Promise<number> {
  const args = parseArgs(argv)
  const ctx: CommandContext = {
    cwd,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }

  switch (args.command) {
    case 'create': {
      const name = args.positionals[0]
      if (name === undefined) {
        ctx.err('用法：vscordis create <名字> [--dir plugins] [--trust trusted|untrusted]')
        return 2
      }
      return await runCreate(ctx, name, flagValue(args, 'dir', 'plugins'), flagValue(args, 'trust', 'trusted'))
    }

    case 'list':
      return await runList(ctx, flagValue(args, 'root', 'plugins'))

    case 'tree':
      return await runTree(ctx, flagValue(args, 'root', 'plugins'), hasFlag(args, 'mermaid'))

    case 'sign': {
      const target = args.positionals[0]
      if (target === undefined) {
        ctx.err('用法：vscordis sign <插件目录> [--key <私钥路径>] [--verify]')
        return 2
      }
      return await runSign(ctx, target, flagString(args, 'key'), hasFlag(args, 'verify'))
    }

    case 'dev':
      return await runDev(ctx, flagValue(args, 'root', 'plugins'))

    case 'help':
    case undefined:
      ctx.out(HELP)
      return args.command === undefined ? 2 : 0

    default:
      ctx.err(`未知命令：${args.command}`)
      ctx.out(HELP)
      return 2
  }
}
