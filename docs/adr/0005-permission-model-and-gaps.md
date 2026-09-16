# ADR-0005：权限模型及其不可弥合的缺口

状态：已接受（2026-02-14）

## 背景（一手证据）

Node.js 权限模型（`doc/api/permissions.md`）：

- Node 20.0.0 引入 `--experimental-permission`（Stability 1）；
- **Node 22.13.0 起转正为 `--permission`（Stability 2）**；
- 可用子开关（`lib/internal/process/permission.js` 的 `availableFlags`）：
  `fs-read` / `fs-write` / `child-process` / `worker` / `addons` / `wasi` / `inspector`；
- **没有 `net` 开关**：网络访问无法由权限模型限制；
- 该模型是**进程级、启动时固定**的开关，不是 per-worker 沙箱。实测（本机 Node v24.12.0）：
  无 `--allow-worker` 时 `new Worker` 抛 `ERR_ACCESS_DENIED`；加 `--allow-worker` 后 worker 内
  `fs` 仍受父进程 `--allow-fs-read` 约束。文档 §"does not inherit to a worker thread"
  与实测存在冲突，因此**不依赖 worker 继承语义**做安全推断。

VSCode 侧：stable 1.107.1 的 Electron 39 内置 Node 22.21.1（≥22.13），故子进程可用 `--permission`。

## 决策

1. 权限是**声明式白名单**，写入 `plugin.json` 的 `permissions`：

   | 权限 | 含义 |
   | --- | --- |
   | `vscode:commands.register` | 注册命令（只能注册 `pluginId.` 前缀之外的自定义 id） |
   | `vscode:commands.execute` | 执行命令，且**仅限已注册的 vscordis 插件命令** |
   | `vscode:commands.execute.any` | 执行任意命令（含 VSCode 内建命令），高危 |
   | `vscode:window.messages` | 弹出信息/警告/错误提示 |
   | `vscode:window.statusbar` | 创建状态栏项 |
   | `vscode:window.output` | 创建输出通道 |
   | `vscode:workspace.read` | 读取工作区结构（`workspaceFolders` 等） |
   | `vscode:workspace.config.read` / `.write` | 读写配置 |
   | `net` / `fs:read` / `fs:write` / `process:spawn` | 非 VSCode 能力，M4 起由隔离后端执行 |

2. **越权调用抛 `PermissionDeniedError`**（fail loud），不做静默 no-op。
3. 权限校验点在**受控 API 代理**内，按调用时刻判定；每次拒绝与每次使用都写审计日志。
4. 未在清单中声明的权限一律视为未授予（白名单，不是黑名单）。

## 必须写进文档的缺口（诚实声明）

- `net` **无法**由 Node 权限模型限制。因此 `net` 权限的实现只是
  「插件进程内拦截 `require('net'|'http'|'https'|'dgram'|'tls'|'dns')` + 审计」，
  这是**防误用**，不是强制封禁。真正的强制需要 OS 级隔离（Windows AppContainer / Linux seccomp+bubblewrap），
  列为后续工作，不在本轮范围。
- `fs:*` 可以由 `--permission --allow-fs-read/--allow-fs-write` 强制，但需要精确的路径列表；
  子进程后端必须为其自身的引导脚本授予读权限。
- 在 `trust: trusted`（同进程）下，权限只是**代码层面的约定**，不具备对抗性。

## 后果

- 验收标准"插件无法直接访问未授权的 VSCode API"在 `trusted` 层无法被严格证明，
  只能在 `untrusted`（子进程）层成立。这一区分必须在 README 与测试命名中体现。
