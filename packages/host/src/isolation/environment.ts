/**
 * 隔离子进程的环境变量策略（ADR-0021）。
 *
 * 为什么不能直接 `{ ...process.env }`：Extension Host 的 env 可能包含 token、代理凭据、
 * SSH agent socket、CI 变量等；untrusted 插件能读 `process.env`，而网络又不能被 Node 权限模型
 * 强制限制（ADR-0005），这等于给了一条现成的数据外传通道。
 *
 * 默认只传“启动 Electron-as-Node + 基本路径/区域设置”所需的系统变量白名单；
 * 插件确实需要自定义环境变量时，用户可以显式打开 `vscordis.isolation.inheritEnv`，
 * 此时完整继承并明确接受降级。
 */

const SAFE_ENV_KEYS = [
  // 进程启动/可执行文件解析
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SystemRoot',
  'windir',
  'SYSTEMDRIVE',
  // 临时目录
  'TEMP',
  'TMP',
  'TMPDIR',
  // 系统信息
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'OS',
  // 区域设置
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  // 用户主目录/常用目录：不是秘密，且很多插件会用来拼默认路径
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SHELL',
  'TERM',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
] as const

/**
 * 构建隔离子进程的环境变量。
 *
 * `inheritEnv=true` 是完全继承（逃生开关）；默认是白名单，保证 `ELECTRON_RUN_AS_NODE`
 * 始终存在，否则 `fork` 会在 Electron 下尝试启动一个完整应用而不是 Node。
 */
export function buildIsolatedChildEnv(inheritEnv: boolean): NodeJS.ProcessEnv {
  if (inheritEnv) return { ...process.env, ELECTRON_RUN_AS_NODE: '1' }

  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }
  return env
}
