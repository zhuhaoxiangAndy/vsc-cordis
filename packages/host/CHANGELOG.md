# Changelog

## 0.1.0

**宿主（`vscordis`）**

- 时间可组合性：`EffectStack` 严格 LIFO 串行回收；`ctx.effect` / `ctx.effectAsync` / `ctx.scope`。
- 空间可组合性：`ServiceRegistry` 按服务名注册，依赖方在提供者消失时自动暂停、回来时自动恢复；
  级联是「服务生命周期挂在 EffectStack 上」的自然结果，没有特判代码。
- 动态加载 / 卸载 / 重载；文件监听热重载（`npm run watch` + `vscordis.hotReload`）。
- 受控 API：插件拿到的是 `PluginVscodeApi`（真实 API 的子集）+ 调用时刻鉴权；
  所有 `register*` / `create*` 的返回值自动登记为副作用。
- 完整性与签名：`plugin.sig` + `plugin.json#integrity`，校验发生在 `require` **之前**；
  工作区插件可未签名，装入 `globalStorage` 的必须签名。
- 子进程隔离：`trust: untrusted` 的插件运行在独立进程里，无 `vscode` 模块、
  文件系统受 Node 权限模型限制；命令 handler 通过反向 RPC 调用。
- 活性保护：`activate()` 超时（默认 15s），超时后先发 `AbortSignal` 再回滚 ——
  串行队列不会因为一个挂死的插件而永久卡住。

**CLI（`@vscordis/cli`）**

- `create` / `list` / `tree`（含 `--mermaid`）/ `sign` / `dev`。

**已知边界**（详见各 ADR）

- 运行时注册的命令不进命令面板（VSCode 公开 API 的硬限制）；
- 同进程插件只能防误用，不能防恶意 —— 真边界是子进程；
- Node 权限模型没有网络开关，`net` 是约定而非强制；
- 隔离模式下暂不支持服务、状态栏项、配置读取与事件订阅；
- Web 宿主无法运行期加载代码，只支持构建期内置插件。
