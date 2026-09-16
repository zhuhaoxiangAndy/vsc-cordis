# Changelog

本仓库在交付后继续以「轮次」推进；下面每一条都对应 `main` 上的一个提交，
设计理由一律引用 `docs/adr/*`，不复述。

## [Unreleased]

### 新增

- **`ctx.async` 第二个事件**：`onDidChangeActiveTextEditor`（两种模式同一签名；没有活动编辑器时回调
  `undefined`）。与保存事件共用文档句柄设计（`getText()` 按句柄跨进程取、64 个上限、按插件归属校验）。
  见 ADR-0018。
- **整栈副作用回收预算**：`EffectStack.disposeBudgetMs` + 宿主设置 `vscordis.disposeBudgetMs`
  （默认 30000，`0` 关闭）。超出预算后剩余 teardown 不再执行、逐项记日志，并暴露
  `skippedByBudget` 计数；同进程与隔离两种模式共用同一份配置。见 ADR-0015。
- **远程服务代际锚定**：`provide` 时分配代际 token，过期代理调用**响亮失败**并指向
  `ctx.async.useService`，不再静默路由到 last-wins 后的新提供者。见 ADR-0019 决策 13。
- **命令方向的 structured clone 前置校验**：`invoke` 参数、`result` 返回值、
  `commands.executeCommand` 参数都在调用点给出「哪个命令 / 第几个参数 / 路径 / 为什么」。见 ADR-0019 决策 12。
- **CLI 的 engines 提前检查**：`tree` / `list` 把 `engines.vscordis` 与仓库内宿主版本比对，
  不匹配给 warning（强制点仍在加载期）。见 ADR-0017。
- **`--expose-gc` 严格浸泡**（默认 skip）与内存取证方法：1000 轮后堆增长回到噪声范围。见 ADR-0015。
- **可诊断性**：`PluginHost.queueDepth`（串行队列"排队中 + 执行中"的任务数）暴露到
  `vscordis: 显示运行时状态` —— 长时间 >0 就说明某个生命周期任务卡住，比"宿主没反应"精确得多。
- **快速验收单** `docs/acceptance-quick.md`：≈10 分钟走完五条主线，含 `permissionModel` 逃生开关。
- 内核新增导出：`normalizeVersion`（宿主与 CLI 共用归一化规则）、`RemoteServiceError`。

### 修复

- **生产路径的 `engines` 检查曾被静默跳过**：`Runtime` 没有把 `hostVersion` / `vscodeVersion`
  传给 `PluginHost`（新增接线测试守住）。见 ADR-0017。
- **子进程异常退出时在途调用会永久挂起**：`exit` 处理器补 `#failAll`（活锁 → 明确失败）。见 ADR-0019 决策 10。
- 隔离提供者的 `conflict: 'last-wins'` 曾被静默降级为 `exclusive`；未知策略现在两处 fail-closed。见 ADR-0019 决策 8。
- `ctx.provide` 的 `remote` 标记不再可由插件自设（同进程与隔离两处拒绝）。见 ADR-0019 决策 9。
- 隔离路由表与注册表的顺序问题：`provide` 抛冲突时不再留下指向"从未生效的提供者"的路由。
- 版本协商补齐：`tryResolve` 支持范围（版本不符不再被当成"软依赖缺失"）；
  隔离取用点复查消费者声明的范围。见 ADR-0019 决策 7。
- pnpm 11.7 下 `allowBuilds` 未决占位导致 `pnpm install` 退出 1、`pnpm run verify` 不可运行。见 ADR-0009 决策 5。

### 测试

- 170 → **215 项**（214 通过 + 1 个 `--expose-gc` 严格用例按设计 skip），8 个构建目标、4 个插件产物冒烟。
- 两条关键回归做了**反向验证**（临时去掉修复必须失败）：子进程崩溃的在途调用、last-wins 后的旧代理。
- 新增规模/内存证据：`soak.spec.ts` 的严格模式明确排除了**夹具自身记账**（状态转换日志数组）对堆测量的污染；
  另加 300 插件依赖链的加载/卸载规模测试（实测约 30ms，结构归零 + 10s 灾难性回归上界）。

### 文档

- ADR-0009 / 0015 / 0017 / 0018 / 0019 更新「未覆盖」为现状；`docs/plugin-authoring.md`、
  `docs/acceptance-m4b.md` 同步新能力与手动验收步骤。
- `docs/design/overview.md` 修正「两种执行模式」表中一行过时描述（"服务跨进程 ❌"），补贡献者地图。
- 新增 `docs/acceptance-quick.md`（≈10 分钟验收主线）并从 README「快速开始」链入。
