import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildGraph, renderJson, renderMermaid, renderText, type GraphPlugin } from '../src/graph.ts'

function plugin(id: string, overrides: Partial<GraphPlugin> = {}): GraphPlugin {
  return {
    id,
    dir: `/plugins/${id}`,
    version: '1.0.0',
    trust: 'trusted',
    provides: [],
    dependencies: {},
    ...overrides,
  }
}

test('健康的一对：无 findings，且提供者排在消费者之前', () => {
  const graph = buildGraph([
    plugin('consumer', { dependencies: { clock: '^1.0.0' } }),
    plugin('provider', { provides: ['clock'] }),
  ])

  assert.deepEqual(graph.findings, [])
  assert.deepEqual(graph.loadOrder, ['provider', 'consumer'])
  assert.deepEqual(graph.services, [{ name: 'clock', providers: ['provider'] }])
  assert.deepEqual(graph.consumers.clock, ['consumer'])
})

test('依赖一个没人提供的服务 → error（该插件会在运行期被 parked）', () => {
  const graph = buildGraph([plugin('lonely', { dependencies: { clock: '^1.0.0' } })])
  assert.equal(graph.findings.length, 1)
  assert.equal(graph.findings[0]?.level, 'error')
  assert.match(graph.findings[0]?.message ?? '', /没有任何插件声明提供它/)
  assert.match(graph.findings[0]?.message ?? '', /paused/)
})

test('同一服务多个提供者 → error（运行期 exclusive 策略会抛 ServiceConflictError）', () => {
  const graph = buildGraph([plugin('a', { provides: ['clock'] }), plugin('b', { provides: ['clock'] })])
  const finding = graph.findings.find((candidate) => candidate.message.includes('个提供者'))
  assert.ok(finding !== undefined)
  assert.equal(finding.level, 'error')
  assert.match(finding.message, /ServiceConflictError/)
})

test('服务依赖环 → error，并打印环路', () => {
  const graph = buildGraph([
    plugin('a', { provides: ['sa'], dependencies: { sb: '*' } }),
    plugin('b', { provides: ['sb'], dependencies: { sa: '*' } }),
  ])
  const cycle = graph.findings.find((candidate) => candidate.message.includes('依赖环'))
  assert.ok(cycle !== undefined)
  assert.equal(cycle.level, 'error')
  assert.match(cycle.message, /a → b → a|b → a → b/)
})

test('自依赖不算环', () => {
  const graph = buildGraph([plugin('selfish', { provides: ['s'], dependencies: { s: '*' } })])
  assert.deepEqual(graph.findings, [])
})

test('隔离插件声明服务 → warning（隔离模式下 provide/use 会抛错）', () => {
  const graph = buildGraph([plugin('iso', { trust: 'untrusted', provides: ['clock'] })])
  assert.equal(graph.findings.length, 1)
  assert.equal(graph.findings[0]?.level, 'warning')
  assert.match(graph.findings[0]?.message ?? '', /隔离模式下 ctx\.provide\/ctx\.use 会抛错/)
})

test('版本提示：提供者插件版本明显不满足范围 → warning，并说明服务版本是运行期决定的', () => {
  const graph = buildGraph([
    plugin('provider', { version: '1.0.0', provides: ['clock'] }),
    plugin('consumer', { dependencies: { clock: '^2.0.0' } }),
  ])
  const warning = graph.findings.find((candidate) => candidate.level === 'warning')
  assert.ok(warning !== undefined)
  assert.match(warning.message, /运行期 ctx\.provide/)
})

test('版本满足时不产生提示', () => {
  const graph = buildGraph([
    plugin('provider', { version: '1.2.0', provides: ['clock'] }),
    plugin('consumer', { dependencies: { clock: '^1.0.0' } }),
  ])
  assert.deepEqual(graph.findings, [])
})

// ————————————————————————————————— ADR-0017：engines 的提前检查

test('engines.vscordis 不满足 → warning，并说明加载期会拒绝（ADR-0017）', () => {
  const graph = buildGraph([plugin('needs-new-host', { engines: { vscordis: '^2.0.0' } })], {
    hostVersion: '0.1.0',
  })
  const warning = graph.findings.find((candidate) => candidate.message.includes('engines.vscordis'))
  assert.ok(warning !== undefined)
  assert.equal(warning.level, 'warning')
  assert.match(warning.message, /加载期会直接拒绝/)
  assert.match(warning.message, /ADR-0017/)
})

test('engines.vscordis 满足（含预发布宿主版本归一化）→ 无提示', () => {
  const graph = buildGraph([plugin('needs-old-host', { engines: { vscordis: '>=0.1.0' } })], {
    // 归一化后是 0.1.0，应当满足 —— 与宿主 `#assertEnginesCompatible` 用同一条规则
    hostVersion: '0.1.0-beta.3',
  })
  assert.deepEqual(graph.findings, [])
})

test('不传 hostVersion → 跳过 engines 检查（buildGraph 保持纯函数、无 IO）', () => {
  const graph = buildGraph([plugin('unknown-host', { engines: { vscordis: '^9.0.0' } })])
  assert.deepEqual(graph.findings, [])
})

test('engines.vscode 不去猜：CLI 不知道用户装了哪个 VSCode，不产生提示', () => {
  const graph = buildGraph([plugin('needs-vscode', { engines: { vscode: '^9.0.0' } })], {
    hostVersion: '0.1.0',
  })
  assert.deepEqual(graph.findings, [])
})

test('renderJson：可被 JSON.parse 还原且字段不裁剪（机器可读输出）', () => {
  const graph = buildGraph([
    plugin('provider', { provides: ['clock'] }),
    plugin('consumer', { dependencies: { clock: '^1.0.0' } }),
  ])

  const text = renderJson(graph)
  assert.deepEqual(JSON.parse(text), graph)
  assert.ok(text.endsWith('\n'), '以换行结尾，方便直接重定向到文件')
})

/**
 * 规模证据（纯函数侧）：500 插件的长链与扇出都要在线性量级内完成。
 *
 * `buildGraph` 里有 `plugins.find(...)` 这样的写法（按 id 找提供者），长链/扇出正是会把
 * 这类 O(n²) 放大到肉眼可见的形状。这里只设**宽松上界**抓灾难性回归，不做性能承诺。
 */
test('规模：500 插件的长链与扇出都能在宽松上界内建图（抓 O(n²) 退化）', () => {
  const COUNT = 500

  const chain: GraphPlugin[] = []
  for (let index = 0; index < COUNT; index += 1) {
    chain.push(
      plugin(`chain-${index}`, {
        provides: [`svc-${index}`],
        ...(index === 0 ? {} : { dependencies: { [`svc-${index - 1}`]: '^1.0.0' } }),
      }),
    )
  }
  const chainStarted = performance.now()
  const chainGraph = buildGraph(chain, { hostVersion: '0.1.0' })
  const chainMs = performance.now() - chainStarted

  assert.deepEqual(chainGraph.findings, [])
  assert.equal(chainGraph.loadOrder.length, COUNT)
  assert.equal(chainGraph.loadOrder[0], 'chain-0', '提供者必须排在消费者之前')
  assert.equal(chainGraph.loadOrder.at(-1), `chain-${COUNT - 1}`)
  assert.ok(chainMs < 2_000, `长链 buildGraph 耗时 ${chainMs.toFixed(1)}ms，超过宽松上界 2s`)

  const fanout: GraphPlugin[] = [plugin('hub', { provides: ['hub'] })]
  for (let index = 0; index < COUNT; index += 1) {
    fanout.push(plugin(`leaf-${index}`, { dependencies: { hub: '^1.0.0' } }))
  }
  const fanoutStarted = performance.now()
  const fanoutGraph = buildGraph(fanout, { hostVersion: '0.1.0' })
  const fanoutMs = performance.now() - fanoutStarted

  assert.deepEqual(fanoutGraph.findings, [])
  assert.equal(fanoutGraph.consumers.hub?.length, COUNT)
  assert.ok(fanoutMs < 2_000, `扇出 buildGraph 耗时 ${fanoutMs.toFixed(1)}ms，超过宽松上界 2s`)

  console.log(
    `  [规模] buildGraph：链 ${chainMs.toFixed(1)}ms / 扇出 ${fanoutMs.toFixed(1)}ms（各 ${COUNT} 插件）`,
  )
})

test('findings 排序：error 在前', () => {
  const graph = buildGraph([
    plugin('iso', { trust: 'untrusted', provides: ['clock'] }),
    plugin('lonely', { dependencies: { nothing: '*' } }),
  ])
  assert.equal(graph.findings[0]?.level, 'error')
  assert.equal(graph.findings.at(-1)?.level, 'warning')
})

test('renderText：包含加载顺序、服务、插件与版本免责说明', () => {
  const text = renderText(
    buildGraph([plugin('provider', { provides: ['clock'] }), plugin('consumer', { dependencies: { clock: '^1.0.0' } })]),
  )
  assert.match(text, /加载顺序：provider → consumer/)
  assert.match(text, /├─ 提供者：provider/)
  assert.match(text, /└─ 消费者：consumer/)
  assert.match(text, /静态图只能校验"有没有提供者"/)
})

test('renderMermaid：provides 与依赖边都在，隔离插件带虚线 class', () => {
  const mermaid = renderMermaid(
    buildGraph([
      plugin('provider', { provides: ['clock'] }),
      plugin('iso', { trust: 'untrusted', dependencies: { clock: '^1.0.0' } }),
    ]),
  )
  assert.match(mermaid, /^flowchart LR/m)
  assert.match(mermaid, /p_provider -->\|provides\| s_clock/)
  assert.match(mermaid, /s_clock -->\|"\^1\.0\.0"\| p_iso/)
  assert.match(mermaid, /class p_iso isolated/)
})

test('没有插件时不崩', () => {
  const graph = buildGraph([])
  assert.deepEqual(graph.findings, [])
  assert.deepEqual(graph.loadOrder, [])
  assert.match(renderText(graph), /<无>/)
})

test('服务名里的特殊字符会被 Mermaid 标识符转义', () => {
  const mermaid = renderMermaid(buildGraph([plugin('p', { provides: ['weird.name'] })]))
  assert.match(mermaid, /s_weird_name\(\("weird\.name"\)\)/)
})
