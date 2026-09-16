# ADR-0006：Web 宿主的降级策略（"全平台"的真实含义）

状态：已接受（2026-02-14）

## 背景（一手证据）

microsoft/vscode-docs：

- `api/extension-guides/web-extensions.md#L14`：Web 扩展**没有 Node.js API，没有模块加载**；
- 同文件 `#L81-87`：运行在 Browser WebWorker 中，**`require` 与 `importScripts` 都不可用**，
  无法导入 `process` / `os` / `path` / `util` / `url`，文件访问必须走 `vscode.workspace.fs`；
- `api/advanced-topics/extension-host.md#L50`：**Web 宿主内不能实例化 Web Worker**；
- 源码 `src/vs/workbench/api/worker/extHostExtensionService.ts#L17-20`：
  `WorkerRequireInterceptor._installInterceptor()` 是空实现（不挂钩 Node require），
  `#L40-49` 只伪造 `vscode` 模块。

## 决策

用户选择"全平台都要"，但 Web 平台在物理上无法运行期加载任意代码。因此定义为**能力降级**，而非"支持"：

| 维度 | Desktop / Remote | Web |
| --- | --- | --- |
| 插件代码来源 | 磁盘（工作区 / globalStorage），运行期加载 | **构建期内置**（esbuild 静态内联进宿主 bundle） |
| 动态加载 | ✅ | ❌ 物理不可能 |
| 动态启停 | ✅ | ✅（同一套 kernel） |
| `trust: untrusted` | 子进程隔离（M4） | **一律拒绝**（fail-closed） |
| 文件系统发现 | ✅ | ❌ |

实现要求（为将来保留 Web 可行性，成本极低）：

1. `@vscordis/sdk` 与 `@vscordis/kernel` **零 Node 内建模块依赖**（ADR-0001 已确定）；
2. host 拆两个入口：`src/extension.ts`（Node）与 `src/browser.ts`（Web），
   各自 esbuild 打包到 `dist/extension.cjs` 与 `dist/web/extension.cjs`，`package.json` 声明 `browser` 字段；
3. 宿主的 6 个入口命令在两端都注册；Web 端 `loadPlugin` 只列出内置插件。

## 后果

- Web 端"插件"等价于"可启停的内置功能模块"，这是浏览器沙箱的硬边界，不是设计取舍。
- README 的「能力矩阵」必须逐格标注，禁止用"跨平台"一句话掩盖。
- Web 端不实现文件发现 → `vscordis.pluginRoots` 配置在 Web 上无效，需要显式提示。
