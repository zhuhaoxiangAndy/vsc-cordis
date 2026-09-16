# ADR-0020：隔离前的 reparse point 校验 —— 链接不得逃出插件根

状态：已接受（2026-09-17，交付后安全加固轮）｜决策者：无人值守自主决策

## 背景（一手证据）

ADR-0013 用 `child_process.fork` + Node `--permission` + `--allow-fs-read=<pluginRoot>` 给 `untrusted`
插件做“真边界”。但 Node 权限模型的路径白名单只对**路径字符串**生效，不解析 root 内的符号链接/junction。

本机实测（Windows 11，VSCode 1.118.1 / Electron 39.8.8 / Node 22.22.1）：

| 动作 | 结果 |
| --- | --- |
| 直接读 `pluginRoot/../outside/secret.txt` | `ERR_ACCESS_DENIED` |
| 读 `pluginRoot/link-dir/secret.txt`（`link-dir` 是指向 outside 的 junction） | **读到了内容** |
| 子进程运行时 `fs.symlinkSync(...)` | `ERR_ACCESS_DENIED`（“requires full fs.read and fs.write permissions”） |
| 子进程运行时 `fs.linkSync(...)` | `ERR_ACCESS_DENIED` |

因此攻击面不是“插件运行期自己制造链接”（权限模型拦住了），而是“插件包在加载前已经带有链接”：
第三方仓库/目录形态的插件可以带一个指向 `%USERPROFILE%\.ssh` 之类的 junction；签名/哈希只覆盖
`main`，不会拒绝它。真实 `isolated-worker.cjs` 探针已复现：普通路径读被拒，junction 读成功。

## 决策

1. **fork 之前扫描**：`IsolatedPluginLoader.load` 在构建出 `execArgv` 后、创建 `IsolatedSession`
   之前调用 `assertNoEscapingReparsePoints(entry.root)`。顺序不能反：一旦 fork 成功，恶意插件已经在
   子进程里跑起来了。
2. **只对启用权限模型的路径扫描**：当 `execArgv` 含 `--permission` 时执行。
   `vscordis.isolation.permissionModel=false` 时 fs 本来就不再是强制边界，用户已显式接受降级；
   此时不扫描，避免制造“关了模型反而更严”的错觉。
3. **判定规则**：递归遍历插件根；每个 symlink/junction（Windows 下 `Dirent.isSymbolicLink()` 对
   junction 同样为 true，已实测）都 `realpath`，目标必须仍在 `realpath(pluginRoot)` 内，否则
   fail-closed。
4. **root 内链接放行，但不递归进链接本身**：避免循环与重复扫描；链接目标的真实路径会在正常目录
   遍历中被再次扫描到。
5. **失败必须是加载失败**：`PluginReparsePointError` 被包成 `PluginIntegrityCheckError`，
   `PluginHost` 把插件标记为 `failed`，且 `IsolatedPluginLoader.sessionsStarted` 保持为 0
   （测试用这个哨兵证明“先拒绝、后 fork”）。
6. **硬链接不检测**：Node 权限模型无法区分硬链接与其目标；运行期 `fs.link` 已被权限模型拒绝，
   而能在本机把外部文件 hardlink 进插件根的人本来就能读该文件。作为已知缺口记录。
7. **可操作错误信息**：报出链接路径、解析后的目标和原因（“`--allow-fs-read` 会跟随链接”），
   而不是一句“加载失败”。

## 后果

- 带外部链接的插件包现在会被拒绝加载；monorepo 开发目录里指向 root 内的链接不受影响。
- 每次加载 `untrusted` 插件增加一次插件目录递归扫描。插件 `main` 必须是单文件 bundle，
  插件根通常很小；这是可接受的加载期成本。
- 扫描发生在 fork 前，因此失败路径不留下子进程、命令、输出通道等宿主侧残留。

## 测试证据

`packages/host/test/isolation.spec.ts`：

- 外部 junction 必须被 fork 前拒绝，并断言 `sessionsStarted === 0`；
- 指向 root 内部的 junction 正常加载并读到文件（防止“见链接就拒”的一刀切回归）。

两条都做了反向验证：临时移除扫描逻辑，第一条必须失败（说明它测的是修复本身，不是恒真断言）。

## 未覆盖

- NTFS 卷挂载点/其它 reparse tag 不一定被 `stat().isSymbolicLink()` 报告为链接；本 ADR 覆盖常见的
  symlink/junction 攻击面，不声明覆盖所有 reparse point。
- 扫描与 fork 之间存在 TOCTOU 窗口：本机另一个进程可在扫描后替换目录。真正对抗性场景仍应使用
  专用 OS 账户/容器；本仓库的威胁模型是“同一账户下的不可信插件代码”，不包含同账户下的并发本地
  攻击者。
- `permissionModel=false` 时没有 fs 边界，链接校验也不提供保护。
