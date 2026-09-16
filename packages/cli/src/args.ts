/**
 * 极简参数解析（刻意不引依赖）。
 *
 * 支持三种形态：`--flag`、`--key value`、位置参数。
 * 不支持 `--key=value`（用起来容易和 Windows 路径里的 `=` 混淆），也不支持组合短选项。
 */

export interface ParsedArgs {
  readonly command: string | undefined
  readonly positionals: readonly string[]
  readonly flags: ReadonlyMap<string, string | true>
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  let command: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue

    if (token.startsWith('--')) {
      const name = token.slice(2)
      if (name.length === 0) continue
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(name, next)
        index += 1
      } else {
        flags.set(name, true)
      }
      continue
    }

    if (command === undefined) command = token
    else positionals.push(token)
  }

  return { command, positionals, flags }
}

export function flagValue(args: ParsedArgs, name: string, fallback: string): string {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : fallback
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name)
}
