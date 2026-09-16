# 架构决策记录（ADR）索引

这里存放的是 vscordis 的**设计决策**：每条都记「背景 → 决策 → 后果」，以及**未覆盖**的边界。
代码回答"怎么做"，ADR 回答"为什么这么做、以及刻意不做什么"。

> 状态说明：全部为 `已接受`。括号里是产出该决策的轮次（M1–M5 / 交付后加固轮 / 收尾轮 / 后续轮）。
> 修改实现时如果与某条决策冲突，**先改 ADR 再改代码**，或者在 ADR 里写清为什么推翻它。

## 阅读路径（第一次进这个仓库）

1. `docs/design/overview.md`（架构总览，本文档的上层）
2. [ADR-0001](./0001-architecture-baseline.md) —— 分层与依赖倒置（为什么 kernel 里没有 `vscode`）
3. [ADR-0003](./0003-isolation-tiers-fail-closed.md) —— 隔离分级与 fail-closed
4. [ADR-0007](./0007-dependency-resolution-and-cascade.md) —— 依赖声明、解析与级联
5. [ADR-0015](./0015-liveness-and-residue-evidence.md) —— 活性保护与"无残留"的证据形式
6. [ADR-0019](./0019-cross-process-services.md) —— 跨进程服务（同步入口为什么必须拒绝）

## 全部决策

| 编号 | 标题 | 状态 |
| --- | --- | --- |
| [0001](./0001-architecture-baseline.md) | 基线架构分层与依赖倒置 | 已接受 |
| [0002](./0002-command-palette-and-unload-verification.md) | 命令面板语义与「卸载可观测性」的验收方式修正 | 已接受（修正 M1 验收标准） |
| [0003](./0003-isolation-tiers-fail-closed.md) | 隔离分级与「不可信插件 fail-closed」 | 已接受 |
| [0004](./0004-effect-stack-semantics.md) | EffectStack 语义（时间可组合性内核） | 已接受 |
| [0005](./0005-permission-model-and-gaps.md) | 权限模型及其不可弥合的缺口 | 已接受 |
| [0006](./0006-web-host-degradation.md) | Web 宿主的降级策略（"全平台"的真实含义） | 已接受 |
| [0007](./0007-dependency-resolution-and-cascade.md) | 依赖声明、解析与级联回收 | 已接受 |
| [0008](./0008-secret-management.md) | 密钥与签名材料的存放 | 已接受 |
| [0009](./0009-toolchain-zero-network-verifiable.md) | 工具链与"零网络可验证" | 已接受（含 pnpm 供应链保护决策） |
| [0010](./0010-host-layer-decisions.md) | 宿主层补充决策（Web 入口格式、inject 合并、桥接层自动登记语义） | 已接受（M1/M2 实施轮） |
| [0011](./0011-hot-reload.md) | 热重载（M3）的边界与失败语义 | 已接受（M3 实施轮） |
| [0012](./0012-integrity-and-signing.md) | 完整性与签名策略（M4a） | 已接受（M4a 实施轮） |
| [0013](./0013-isolation-backend.md) | 子进程隔离后端（M4b） | 已接受（M4b 实施轮） |
| [0014](./0014-cli-and-provides.md) | CLI 与 `provides` 声明（M5） | 已接受（M5 实施轮） |
| [0015](./0015-liveness-and-residue-evidence.md) | 活性保护与"无残留"的证据形式（交付后加固轮） | 已接受（加固轮） |
| [0016](./0016-isolation-capability-tradeoffs.md) | 隔离能力的取舍 —— 配置快照与状态栏项，以及为什么不假装支持事件与服务 | 已接受（M4c 轮） |
| [0017](./0017-engines-must-be-enforced.md) | `engines` 必须被强制，不能被静默丢弃 | 已接受（收尾轮） |
| [0018](./0018-explicit-async-surface.md) | 显式异步面 `ctx.async` —— 让隔离模式也能有事件订阅，而不撒谎 | 已接受（部分取代 0016 的一条判定） |
| [0019](./0019-cross-process-services.md) | 跨进程服务 —— 远程标记、方法表、以及"同步入口必须拒绝" | 已接受 |
| [0020](./0020-reparse-point-hardening.md) | 隔离前的 reparse point 校验 —— 链接不得逃出插件根 | 已接受（交付后安全加固轮） |

## 按主题找

| 主题 | ADR |
| --- | --- |
| 分层与内核语义 | [0001](./0001-architecture-baseline.md)、[0004](./0004-effect-stack-semantics.md)、[0007](./0007-dependency-resolution-and-cascade.md)、[0015](./0015-liveness-and-residue-evidence.md)、[0017](./0017-engines-must-be-enforced.md) |
| 宿主、命令与热重载 | [0002](./0002-command-palette-and-unload-verification.md)、[0010](./0010-host-layer-decisions.md)、[0011](./0011-hot-reload.md) |
| 隔离与安全 | [0003](./0003-isolation-tiers-fail-closed.md)、[0005](./0005-permission-model-and-gaps.md)、[0006](./0006-web-host-degradation.md)、[0008](./0008-secret-management.md)、[0012](./0012-integrity-and-signing.md)、[0013](./0013-isolation-backend.md)、[0016](./0016-isolation-capability-tradeoffs.md)、[0018](./0018-explicit-async-surface.md)、[0019](./0019-cross-process-services.md)、[0020](./0020-reparse-point-hardening.md) |
| 工具链与 CLI | [0009](./0009-toolchain-zero-network-verifiable.md)、[0014](./0014-cli-and-provides.md) |

## 相关文档

- 架构总览：`docs/design/overview.md`
- 插件作者指南：`docs/plugin-authoring.md`
- 签名手册：`docs/signing.md`
- 手动验收：`docs/acceptance-quick.md`（≈10 分钟主线）与三份分里程碑验收表
