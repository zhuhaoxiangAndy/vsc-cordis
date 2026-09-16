# VSCordis（宿主扩展）

这是 vscordis 的**唯一发布单元**：一个普通 VSCode 扩展，在 Extension Host 之上运行一个类 Cordis 的
微型插件运行时。

它自己几乎不做业务，只做四件事：

1. 把真实的 `vscode` API 桥接成**受控面**（权限代理 + 自动副作用登记）；
2. 发现并加载插件（`trusted` 走同进程，`untrusted` 走隔离子进程）；
3. 在服务提供者变化时协调依赖方（暂停/恢复）；
4. 监听插件目录变化并热重载。

## 命令

`Ctrl+Shift+P` 输入 `VSCordis`：

| 命令 | 作用 |
| --- | --- |
| `vscordis: 运行插件命令…` | **运行时注册的命令不会出现在命令面板**（面板只显示静态 `contributes.commands`），所以由这个入口用 QuickPick 枚举当前活的插件命令 |
| `vscordis: 加载插件…` | 从未加载的已发现插件里选一个加载 |
| `vscordis: 卸载插件…` | 卸载并级联暂停依赖它的插件 |
| `vscordis: 重载插件…` | 完整卸载后重新加载（拿到全新的模块实例） |
| `vscordis: 卸载全部插件` | |
| `vscordis: 显示运行时状态` | 插件/服务/命令/依赖图/隔离子进程数/发现问题的完整快照 |

## 配置

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `vscordis.pluginRoots` | `[]` | 额外的插件搜索根（支持 `${workspaceFolder}`） |
| `vscordis.autoLoad` | `true` | 启动时自动加载发现的插件 |
| `vscordis.hotReload` | `true` | 监听插件目录变化并自动重载 |
| `vscordis.hotReloadDebounceMs` | `150` | 文件变化防抖窗口 |
| `vscordis.disposeTimeoutMs` | `2000` | 单个副作用回收的超时 |
| `vscordis.disposeBudgetMs` | `30000` | 单个插件整栈回收总预算；超出后剩余 teardown 跳过并记日志（ADR-0015） |
| `vscordis.activationTimeoutMs` | `15000` | 插件 `activate()` 的时限（没有它，一个挂死的插件会冻结整个宿主） |
| `vscordis.isolation.permissionModel` | `true` | 对 `untrusted` 插件使用 Node 权限模型（`--permission`） |
| `vscordis.isolation.inheritEnv` | `false` | 隔离子进程是否继承宿主完整环境变量；默认只传系统白名单（ADR-0021） |

## 开发

- 完整项目文档见仓库根目录的 `README.md`；
- 架构决策见 `docs/adr/`；
- 手动验收步骤见 `docs/acceptance-*.md`；
- 插件作者指南：`@vscordis/sdk` 里的 `PluginContext` 类型注释，以及 `plugins/` 下的示例。

**本扩展不包含业务逻辑**：所有功能都以插件形式存在于 `vscordis.pluginRoots` 指向的目录里。
