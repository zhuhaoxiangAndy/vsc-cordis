# ADR-0002：命令面板语义与「卸载可观测性」的验收方式修正

状态：已接受（2026-02-14）｜修正了里程碑 1 的原始验收标准

## 背景（一手证据）

原始里程碑写的是"卸载后命令从命令面板消失"。经核实 microsoft/vscode 源码（tag 1.105.0），这条**不成立**：

- 命令面板的条目来自 `MenuService.getMenuActions(MenuId.CommandPalette)`
  （`src/vs/editor/contrib/quickaccess/browser/commandsQuickAccess.ts#L218`）；
- `platform/actions/common/actions.ts#L460-490` 把 MenuRegistry 中的命令作为 implicit item 注入面板；
- `services/actions/common/menusExtensionPoint.ts#L805-877` 把扩展的静态 `contributes.commands` 写入 MenuRegistry；
- 运行时通过 `vscode.commands.registerCommand` 注册的命令**从不进入 MenuRegistry**。
- `dispose()` 的效果是：从 `CommandsRegistry` 移除（`extHostCommands.ts#L149-171` → `mainThreadCommands.ts#L57-71`），
  因此只反映在 `vscode.commands.getCommands(true)` 上。

## 决策

1. 里程碑 1 的验收判据改为**两条可自动化断言的事实**：
   - `vscode.commands.getCommands(true)` 在卸载后不再包含该命令 id；
   - 卸载后 `executeCommand(id)` 抛 `command not found`。
2. 宿主静态 `contributes.commands` 只声明**宿主自己的 6 个入口命令**，永不声明插件命令。
3. 为让"插件命令"对人类可见且可演示，宿主提供静态入口 `vscordis.runPluginCommand`
   → 用 `showQuickPick` 枚举**当前活的**插件命令注册表。
   **卸载插件 → 该命令从 QuickPick 列表消失**，这才是本项目能真实兑现的"命令消失"体验。
4. `contributes.commands` 的动态化不在本项目范围内（无公开 API，且 workbench 只在扩展集变化时 clear+rebuild）。

## 后果

- 验收标准从"面板"改为"命令注册表 + QuickPick 代理"，两者都可被宿主自测断言。
- 反面代价：用户必须经过一次 QuickPick 才能触达插件命令，无法直接把插件命令绑到快捷键；
  这是 VSCode 公开 API 的硬限制，不是实现缺陷。
- 文档（README「已知硬限制」第 1 条）必须对这个限制保持显式说明，避免误导使用者。
