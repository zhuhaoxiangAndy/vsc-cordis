# ADR-0023：命令 ID 归属校验（注册/注销都按 pluginId）

状态：已接受（2026-09-17，交付后安全加固轮）｜决策者：无人值守自主决策

## 背景（一手证据）

VSCode 的命令 ID 是**全局命名空间**；`commands.registerCommand` 允许同名重复注册。本项目在
两个模式下都维护一张“命令 ID → 所属插件”的表（进程内 `VscodeBridge`、隔离 `VscodeHostApi`），
但此前只用于 QuickPick 展示与执行白名单，没有作为所有权约束。

安全审计用真实 `VscodeHostApi` + `vscode` stub 复现：插件 B 可以发
`{ kind: 'call', method: 'commands.unregisterCommand', args: ['victim.cmd'] }`（该分支不要求权限），
把 A 的真实命令注销，然后在同一 ID 上注册自己的 handler，UI/按键调用就会落到 B。
`VscodeHostApi.dispose()` 修复（9471b2d）让 unregister 真正调用底层 dispose 后，这条路径从
“只清记账”升级为真实劫持。直接注册同名 ID 也存在同样的覆盖问题。

## 决策

1. **注册冲突 fail-closed**：同一命令 ID 已被**其它** `pluginId` 占用时，
   `registerCommand` 抛 `PermissionDeniedError`，错误信息带上两个 owner。
   同一插件重新注册同一 ID 仍允许（reload / 更新语义）。
2. **注销必须带归属**：`unregisterCommand(pluginId, command)` 接口显式携带 pluginId，只允许
   撤销自己注册的命令。隔离会话只对本会话 `#commandHandles` 里的命令调用 dispose；
   宿主 API 再做一次归属校验，形成双保险。
3. **两个模式同一条规则**：`packages/host/src/bridge.ts`（进程内）与
   `packages/host/src/isolation/vscode-host-api.ts`（隔离）行为一致，避免“同一份插件代码在两种
   模式下边界不同”。
4. 这不是新增权限词表，而是命令命名空间的所有权约束；命令仍推荐使用 `pluginId.*` 前缀，
   但真正的强制点在宿主侧。

## 后果

- 插件不能再互相覆盖命令 ID；依赖“后注册覆盖前注册”的写法必须改名。
- 恶意插件无法通过 unregister → re-register 劫持其它插件的命令。
- 未注册 ID 的 unregister 仍是幂等 no-op（旧命令/过期 handle 清理路径不受影响）。

## 测试证据

- `packages/host/test/bridge.spec.ts`：插件 B 抢注插件 A 的命令 → `PermissionDeniedError`，
  命令表仍指向 A。
- `packages/host/test/isolation.spec.ts`：B 直接发 `commands.unregisterCommand` 后 A 的命令仍可执行；
  B 再尝试 `commands.registerCommand` 抢注会激活失败，A 的命令保持可用。

## 未覆盖

- 不覆盖 VSCode **内建命令**的覆盖检测（`bridge.#commands` 只记录 vscordis 插件命令）；
  插件注册与内建命令同名的行为仍由 VSCode 决定。
- 不改变“命令不会出现在命令面板”的既有事实（ADR-0002）。
