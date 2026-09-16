# ADR-0003：隔离分级与「不可信插件 fail-closed」

状态：已接受（2026-02-14）

## 背景（一手证据）

1. **同进程无法形成边界**：`api/node/extHostExtensionService.ts#L30-60` 全局 patch `module._load`，
   `api/common/extHostRequireInterceptor.ts#L55-183` 按发起 require 的文件路径（含 `node_modules`）
   返回该扩展的 `vscode` API。也就是说，**插件产物里一句 `require('vscode')` 就能拿到全量 API**，
   绕过我们的 `ctx.vscode` 受控面。（该机制无文档契约，但为刻意实现且被 `vscode-languageclient` 依赖。）
2. **官方不支持运行期卸载单个扩展**：`vscode.d.ts#L8277-8325` 的 `Extension` 只有
   `id/extensionUri/isActive/exports/activate`；`_deactivate` 仅由 `_deactivateAll()` ← `terminate()` 触达；
   microsoft/vscode#199026 标记为 `out-of-scope / not_planned`。
   因此本项目的卸载粒度只能是「扩展内部的插件」，不可能是扩展本身。
3. **子进程中没有 `vscode` 模块**：隔离后受控面成为*唯一*通路，这才是真正的边界。

## 决策

按 `plugin.json` 的 `trust` 字段分三级，**无对应后端时拒绝加载（fail-closed）**：

| trust | 后端 | 边界强度 | 适用 |
| --- | --- | --- | --- |
| `trusted` | in-process（`require` + 受控 Proxy + EffectStack 强制登记） | 只防误用，不防恶意 | 自研 / 团队内部插件 |
| `untrusted` | `child_process.fork` + `--permission`（M4） | 真边界：无 `vscode` 模块、无任意 fs | 第三方插件 |
| `untrusted` 且无隔离后端 | **拒绝加载**并给出可操作错误 | — | Web 宿主、M4 之前 |

配套的纵深防御（仅 in-process 层，均标注为"尽力而为"）：

1. **构建期**：esbuild 插件把 `import 'vscode'` 直接报错（编译不通过），并扫描产物里的 `require("vscode")`；
2. **加载期**：在插件模块求值窗口内临时接管 `Module._load`，拒绝来自插件根目录的 `vscode` 请求；
3. **运行期**：`ctx.vscode` 是权限代理，越权调用抛 `PermissionDeniedError`。

三条都不能把 in-process 提升为安全边界——第 2 条依赖未文档化的 `_load`，任何原生插件/`process.binding`
都能绕过。**禁止在文档或 UI 中把 `trusted` 描述为"安全"**。

## 备选方案与否决理由

- **全部子进程隔离**：否决。同步 VSCode API（CompletionItemProvider / Hover / CodeLens）无法跨进程代理，
  且命令参数需要序列化，代价与限制过大。
- **worker_threads 作为不可信后端**：否决为主后端。它与宿主共享进程堆，原生插件/OOM 无法真正回收，
  "kill 即回收"这一最强论据不成立；且 Node 权限模型是全进程启动开关，不是 per-worker 沙箱。
- **拒绝所有不可信插件（不做子进程）**：否决。用户明确要求混合模型。

## 后果

- `untrusted` 插件在 M1–M2（本轮）**必然被拒绝**——这是设计选择而非缺陷，错误信息会明确告知；
  M4 落地子进程后端后自动开放。
- Web 宿主永久无法支持 `untrusted`（浏览器连嵌套 Worker 都没有）。
