# ADR-0021：隔离子进程的环境变量默认白名单

状态：已接受（2026-09-17，交付后安全加固轮）｜决策者：无人值守自主决策

## 背景（一手证据）

`IsolatedSession` 原先用 `env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }` 启动 `untrusted` 插件。
Extension Host 的 env 可能包含 token、代理凭据、`SSH_AUTH_SOCK`、CI 变量等；插件能读 `process.env`，
而网络不是 Node 权限模型能强制的边界（ADR-0005），这等于给了一条现成的数据外传通道。

本机实测（VSCode 1.118.1 / Electron 39.8.8 / Node 22.22.1，真实 `isolated-worker.cjs`）：

| 动作 | 结果 |
| --- | --- |
| 宿主注入 `PERM_SENSITIVE=HOST_ENV_SENSITIVE_VALUE`，默认 fork | 子进程读到该值 |
| 只传白名单（`PATH/SystemRoot/TEMP/...`）+ `ELECTRON_RUN_AS_NODE=1` | worker 正常 `ready → activated` |
| 同上、宿主注入 `PERM_PROBE_SECRET` | 子进程读不到（`null`） |

白名单不是“零环境”：Windows/Electron 启动时会自行补回 `USERNAME`、`USERPROFILE`、`HOMEDRIVE` 等
少量系统变量；目标是去掉凭据类变量，不是匿名化。

## 决策

1. 默认 `vscordis.isolation.inheritEnv = false`。`IsolatedPluginLoader` 用
   `buildIsolatedChildEnv(false)` 生成固定白名单：进程启动/路径解析（`PATH`、`PATHEXT`、`COMSPEC`、
   `SystemRoot`、`windir`、`SYSTEMDRIVE`）、临时目录、处理器/OS 信息、区域设置、用户主目录与常见
   应用目录；并且**始终**设置 `ELECTRON_RUN_AS_NODE=1`（否则 Electron 下 fork 会启动完整应用）。
2. 显式打开 `vscordis.isolation.inheritEnv = true` 时才完整继承；此时每个 untrusted 插件加载都会
   写一条明确的降级日志，不允许静默。
3. 白名单不是权限模型，也不改变 fs/子进程边界；它是“减少默认暴露面”，不是“环境隔离”。真正对抗性
   场景仍应使用专用 OS 账户/容器。
4. 保留逃生开关的原因：插件可能依赖代理或自定义 env；开启即表示接受泄漏风险。
5. 记录理由时明确“没有 `env` 权限词表”：这里不假装 env 是白名单权限，避免插件作者把
   `permissionModel=true` 误解为“env 安全”。

## 后果

- 默认情况下，`untrusted` 插件看不到宿主自定义环境变量；依赖 env 的插件需要显式开关。
- 新配置出现在 VSCode Settings（`vscordis.isolation.inheritEnv`），并在 runtime 装配时传入 loader。
- Windows/Electron 自行补回的系统变量行为不受影响（不在我们控制范围内）。

## 测试证据

`packages/host/test/isolation.spec.ts`：

- 单元：默认过滤掉 `VSCORDIS_ENV_PROBE`，`inheritEnv=true` 时保留；
- 真实子进程：默认插件日志是 `env-probe:<missing>`；`inheritEnv=true` 时是实际值。

## 未覆盖

- 白名单仍包含可推断用户/系统信息的变量（`USERPROFILE`、`PATH` 等）；它防凭据泄漏，不做匿名化。
- `inheritEnv=true` 等于恢复旧行为，无法再提供默认暴露面收敛。
- 无法阻止插件通过其它通道（网络、命令参数、服务调用）外传它能读到的内容；这仍依赖 ADR-0005
  已声明的边界。
