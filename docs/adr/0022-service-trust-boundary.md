# ADR-0022：服务没有信任级隔离（last-wins 可跨 trust 接管）

状态：已接受（2026-09-17，交付后安全加固轮）｜决策者：无人值守自主决策

## 背景（一手证据）

ADR-0019 支持跨进程服务，并允许显式 `conflict: 'last-wins'` 接管；仓库里有一条现有测试
明确断言“隔离提供者可以 last-wins 接管同进程提供者（消费者走异步面可用）”。

安全审计复现：一个 `permissions: []` 的 `untrusted` 插件可以对受信同进程服务使用
`conflict: 'last-wins'` 完成接管；注册表 owner 变成该 untrusted 插件，消费者通过
`ctx.async.useService` 调用时，参数会被路由进子进程，返回值也可以由子进程伪造。

这不是实现没有按代码工作，而是**能力/信任边界没有被明确声明**：服务名是全局能力名，
但文档/权限表没有告诉消费者“同名提供者可能来自 untrusted 进程”。

## 决策

1. **保留能力，不按 trust 级拦截**：`last-wins` 是提供者显式声明的选择，禁止它会让
   ADR-0019 的跨模式接管语义与现有契约失效。宿主不把 trust 级偷偷变成服务冲突规则。
2. **诚实声明**：服务名是**能力名，不是安全边界**。`untrusted` 提供者可以与 `trusted`
   提供者同名，并在 `last-wins` 下接管；消费者的参数/返回值会跨进子进程。
3. **不静默**：发生“隔离提供者以 last-wins 接管同进程提供者”时，宿主必须写一条 **warn 级**
   日志，带上双方 owner 与 ADR-0022 指针。`IsolatedPluginLoader` 的 `onWarning` 被 Runtime 接到
   `LogOutputChannel` 的 warn 级（`onLog` 仍是 debug），保证默认日志级别下可见 ——
   诊断信息不能只活在测试里（ADR-0015 同源原则）。
4. **消费者自保**：不接受被替换的消费者应使用默认 `exclusive`（冲突直接拒绝），或在调用前
   检查 `providerInfo()` 的 owner/version；`ctx.async.useService` 当前只返回方法表 + 代际
   token，不返回 owner，后续如需可显式扩展。
5. `plugin.json#dependencies` 是**契约声明**，不是 `allowlist`；它约束版本与依赖关系，
   不承诺提供者的 trust 级。

## 后果

- `remote` 标记是“跨进程”诊断标记，不是“不可信”或“可信”标记。
- 状态面板 / `vscordis tree` 能展示 owner 与 remote，但不能替代消费者自己的来源校验。
- 未来若需要真正的服务信任级隔离，应引入显式的服务权限/信任级词汇与契约，而不是悄悄改变
  `last-wins` 的语义。

## 未覆盖

- 当前没有 `services` 权限词表；没有提供者信任级随服务记录传递；没有消费者侧 owner 校验 API。
- 这条 ADR 只说明服务层信任模型，不改变 `fs` / 子进程边界（ADR-0013 / 0020 / 0021）。
