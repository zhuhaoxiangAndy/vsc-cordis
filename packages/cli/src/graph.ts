/**
 * 服务依赖图：**纯函数**，无 IO（ADR-0014）。
 *
 * 为什么能做静态分析：`plugin.json` 里的 `provides` 声明了插件会提供哪些服务，
 * `dependencies` 声明了它需要哪些服务。二者一起就足以画出图。
 *
 * 静态分析的**硬边界**（必须清楚，否则会误用这张图）：
 * - 服务的**版本**是运行期 `ctx.provide(name, value, { version })` 决定的，清单里没有，
 *   因此这里**只能**校验"有没有提供者"，不能校验"版本是否满足范围"；
 * - 声明可能与实际不符 —— 宿主会在激活后比对二者并告警（ADR-0014），
 *   所以这张图是"设计意图"，运行期事实仍以 `ServiceRegistry` 为准；
 * - 隔离插件（`trust: untrusted`）不参与服务依赖（服务是进程内对象），
 *   若它们声明了 provides/dependencies，这里会给出提示。
 */

import { normalizeVersion, satisfies } from '@vscordis/kernel'

export interface GraphPlugin {
  readonly id: string
  readonly dir: string
  readonly version: string
  readonly trust: string
  readonly provides: readonly string[]
  readonly dependencies: Readonly<Record<string, string>>
  /** `plugin.json#engines`（ADR-0017 的强制字段；CLI 用它做**提前**提示）。 */
  readonly engines?: { readonly vscordis?: string; readonly vscode?: string }
}

export interface GraphService {
  readonly name: string
  readonly providers: readonly string[]
}

export interface GraphFinding {
  readonly level: 'error' | 'warning'
  readonly message: string
}

export interface DependencyGraph {
  readonly plugins: readonly GraphPlugin[]
  readonly services: readonly GraphService[]
  readonly findings: readonly GraphFinding[]
  /** 拓扑顺序：被依赖的服务先加载（仅用于展示；运行期的正确性不依赖加载顺序，见 ADR-0007）。 */
  readonly loadOrder: readonly string[]
  /** 服务名 → 消费者插件 id。 */
  readonly consumers: Readonly<Record<string, readonly string[]>>
}

export interface BuildGraphOptions {
  /**
   * 仓库内宿主扩展的版本（由 CLI 读 `packages/host/package.json` 传入）。
   *
   * 不传 = 跳过 engines 检查：`buildGraph` 保持**纯函数、无 IO**（ADR-0014），
   * 版本来自调用方注入；测试因此可以只测算法，不碰文件系统。
   */
  readonly hostVersion?: string
}

export function buildGraph(plugins: readonly GraphPlugin[], options: BuildGraphOptions = {}): DependencyGraph {
  const findings: GraphFinding[] = []
  const services = new Map<string, string[]>()
  const consumers = new Map<string, string[]>()

  for (const plugin of plugins) {
    for (const service of plugin.provides) {
      services.set(service, [...(services.get(service) ?? []), plugin.id])
    }
    for (const service of Object.keys(plugin.dependencies)) {
      consumers.set(service, [...(consumers.get(service) ?? []), plugin.id])
    }
  }

  // 同一服务多个提供者：运行期默认 exclusive 策略会直接抛 ServiceConflictError。
  for (const [service, providers] of services) {
    if (providers.length > 1) {
      findings.push({
        level: 'error',
        message: `服务 "${service}" 有 ${providers.length} 个提供者：${providers.join(', ')} —— 默认 exclusive 策略下第二个会抛 ServiceConflictError`,
      })
    }
  }

  // 消费者 → 它需要的提供者（用于拓扑排序与环检测）
  const edges = new Map<string, Set<string>>()
  for (const plugin of plugins) edges.set(plugin.id, new Set())

  for (const plugin of plugins) {
    for (const [service, range] of Object.entries(plugin.dependencies)) {
      const providers = services.get(service) ?? []
      if (providers.length === 0) {
        findings.push({
          level: 'error',
          message: `插件 "${plugin.id}" 依赖服务 "${service}"${range === '*' ? '' : ` (${range})`}，但没有任何插件声明提供它 —— 该插件会被 parked 在 paused 状态`,
        })
        continue
      }
      for (const provider of providers) {
        if (provider === plugin.id) continue // 自依赖不算环
        edges.get(plugin.id)?.add(provider)
        // 版本信息在清单里不存在，但插件版本是已知的：当提供者版本明显不满足范围时给出提示
        const providerPlugin = plugins.find((candidate) => candidate.id === provider)
        if (providerPlugin !== undefined && range !== '*' && !satisfies(providerPlugin.version, range)) {
          findings.push({
            level: 'warning',
            message:
              `插件 "${plugin.id}" 依赖 "${service}" (${range})，提供者 "${provider}" 的**插件版本**是 ${providerPlugin.version}。` +
              '注意：服务的实际版本由运行期 ctx.provide({ version }) 决定，此提示仅供参考',
          })
        }
      }
    }
  }

  // engines.vscordis：加载期是**强制**检查（ADR-0017），CLI 把同一判断**提前**给出。
  // engines.vscode 刻意不检查：CLI 不知道用户实际装了哪个 VSCode，猜一个版本报错比不报更糟。
  if (options.hostVersion !== undefined) {
    const actual = normalizeVersion(options.hostVersion)
    for (const plugin of plugins) {
      const range = plugin.engines?.vscordis
      if (range === undefined) continue
      if (!satisfies(actual, range)) {
        findings.push({
          level: 'warning',
          message:
            `插件 "${plugin.id}" 声明 engines.vscordis = ${range}，而仓库内宿主版本是 ${options.hostVersion}` +
            ` —— 版本不匹配时加载期会直接拒绝（ADR-0017）。CLI 的检查只是提前提示，` +
            '若你的目标宿主是另一个版本请忽略本条。',
        })
      }
    }
  }

  // 隔离插件不参与服务依赖：给出提示，避免作者以为声明会生效
  for (const plugin of plugins) {
    if (plugin.trust !== 'untrusted') continue
    if (plugin.provides.length > 0 || Object.keys(plugin.dependencies).length > 0) {
      findings.push({
        level: 'warning',
        message: `插件 "${plugin.id}" 是 trust: untrusted（运行在子进程），隔离模式下 ctx.provide/ctx.use 会抛错 —— 它的服务声明不会生效（见 ADR-0013）`,
      })
    }
  }

  const cycle = findCycle(
    plugins.map((plugin) => plugin.id),
    edges,
  )
  if (cycle !== undefined) {
    findings.push({ level: 'error', message: `检测到服务依赖环：${cycle.join(' → ')}` })
  }

  const numbered = [...findings].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))

  return {
    plugins: [...plugins].sort((a, b) => a.id.localeCompare(b.id)),
    services: [...services.entries()]
      .map(([name, providers]) => ({ name, providers }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    findings: numbered,
    loadOrder: topologicalOrder(plugins, edges),
    consumers: Object.fromEntries([...consumers.entries()].map(([name, list]) => [name, list])),
  }
}

function findCycle(
  nodes: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  let found: string[] | undefined

  const visit = (node: string): void => {
    if (found !== undefined) return
    const current = state.get(node)
    if (current === 'done') return
    if (current === 'visiting') {
      const start = stack.indexOf(node)
      found = [...stack.slice(start), node]
      return
    }
    state.set(node, 'visiting')
    stack.push(node)
    for (const next of edges.get(node) ?? []) visit(next)
    stack.pop()
    state.set(node, 'done')
  }

  for (const node of nodes) visit(node)
  return found
}

/** Kahn 拓扑排序：提供者排在消费者之前。有环时把剩余节点按 id 追加到末尾。 */
function topologicalOrder(
  plugins: readonly GraphPlugin[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
  const indegree = new Map<string, number>()
  for (const plugin of plugins) indegree.set(plugin.id, edges.get(plugin.id)?.size ?? 0)

  const ready = plugins
    .filter((plugin) => (indegree.get(plugin.id) ?? 0) === 0)
    .map((plugin) => plugin.id)
    .sort()
  const order: string[] = []

  while (ready.length > 0) {
    const id = ready.shift()
    if (id === undefined) break
    order.push(id)
    for (const plugin of plugins) {
      if (!(edges.get(plugin.id)?.has(id) ?? false)) continue
      const remaining = (indegree.get(plugin.id) ?? 0) - 1
      indegree.set(plugin.id, remaining)
      if (remaining === 0) {
        ready.push(plugin.id)
        ready.sort()
      }
    }
  }

  for (const plugin of plugins) {
    if (!order.includes(plugin.id)) order.push(plugin.id)
  }
  return order
}

// ————————————————————————————————— 渲染

export function renderText(graph: DependencyGraph): string {
  const lines: string[] = []
  lines.push(`vscordis 依赖图：${graph.plugins.length} 个插件，${graph.services.length} 个服务`)
  lines.push('')
  lines.push(`加载顺序：${graph.loadOrder.join(' → ') || '<无插件>'}`)

  lines.push('')
  lines.push('服务')
  if (graph.services.length === 0) lines.push('  <无>')
  for (const service of graph.services) {
    lines.push(`  ${service.name}`)
    lines.push(`    ├─ 提供者：${service.providers.join(', ') || '<无>'}`)
    const consumers = graph.consumers[service.name] ?? []
    lines.push(`    └─ 消费者：${consumers.join(', ') || '<无>'}`)
  }

  lines.push('')
  lines.push('插件')
  for (const plugin of graph.plugins) {
    lines.push(`  ${plugin.id}@${plugin.version} [${plugin.trust}]`)
    lines.push(`    provides：${plugin.provides.join(', ') || '-'}`)
    const deps = Object.entries(plugin.dependencies)
    lines.push(
      `    depends ：${deps.length === 0 ? '-' : deps.map(([name, range]) => `${name}@${range}`).join(', ')}`,
    )
  }

  lines.push('')
  lines.push(`发现的问题（${graph.findings.length}）`)
  if (graph.findings.length === 0) lines.push('  <无>')
  for (const finding of graph.findings) {
    lines.push(`  ${finding.level === 'error' ? '✗' : '⚠'} ${finding.message}`)
  }

  lines.push('')
  lines.push('注意：服务的**版本**由运行期 ctx.provide(name, value, { version }) 决定，静态图只能校验"有没有提供者"。')
  return lines.join('\n')
}

/** Mermaid flowchart —— 可直接贴进 Markdown / GitHub issue 里看。 */
export function renderMermaid(graph: DependencyGraph): string {
  const lines: string[] = ['flowchart LR']
  for (const plugin of graph.plugins) {
    const shape = plugin.trust === 'untrusted' ? '{{' : '['
    const close = plugin.trust === 'untrusted' ? '}}' : ']'
    lines.push(`  p_${sanitize(plugin.id)}${shape}"${plugin.id}@${plugin.version}"${close}`)
  }
  for (const service of graph.services) {
    lines.push(`  s_${sanitize(service.name)}(("${service.name}"))`)
  }
  for (const service of graph.services) {
    for (const provider of service.providers) {
      lines.push(`  p_${sanitize(provider)} -->|provides| s_${sanitize(service.name)}`)
    }
  }
  for (const plugin of graph.plugins) {
    for (const [name, range] of Object.entries(plugin.dependencies)) {
      lines.push(`  s_${sanitize(name)} -->|"${range}"| p_${sanitize(plugin.id)}`)
    }
  }
  lines.push('  classDef isolated stroke-dasharray: 5 5')
  const isolated = graph.plugins.filter((plugin) => plugin.trust === 'untrusted')
  if (isolated.length > 0) {
    lines.push(`  class ${isolated.map((plugin) => `p_${sanitize(plugin.id)}`).join(',')} isolated`)
  }
  return lines.join('\n')
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_')
}
