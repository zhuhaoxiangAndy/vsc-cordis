import { watch, type FSWatcher } from 'node:fs'
import * as path from 'node:path'
import { isInside } from './loader-node.ts'

/**
 * 热重载的文件侧（M3）。
 *
 * 设计要点：**"哪些文件变了 → 该重载谁"被抽成纯函数 `planReload`**（不碰文件系统），
 * 于是绝大部分逻辑可以用单测穷举，只有 `PluginWatcher` 是薄薄的 fs.watch 适配层。
 *
 * 分工：
 *   esbuild --watch 负责 源码 → dist/index.cjs
 *   本模块负责           dist/index.cjs 变化 → 触发 reload
 * 之所以不把 esbuild 塞进扩展进程：编译是开发期动作，让它成为宿主的运行时依赖
 * 会平白增加发布体积与启动开销，而 `npm run watch` 只需要在终端里开一个。
 */

export interface ReloadPlan {
  /** 受影响、需要重载的插件目录（绝对路径）。 */
  readonly changedDirs: readonly string[]
  /** 是否需要重新扫描插件根（清单变了 / 出现了新目录 / 发生了无法定位的变化）。 */
  readonly rediscover: boolean
  /** 被主动忽略的噪声路径（编辑器临时文件等），用于诊断。 */
  readonly ignored: readonly string[]
}

/** 编辑器/系统产生的噪声文件：以点开头、以 ~ 结尾、常见交换/临时后缀。 */
const NOISE_PATTERN = /^\.|~$|\.swp$|\.swx$|\.tmp$|\.crdownload$|\.part$/i

/**
 * 把一批变更路径映射成重载计划。纯函数，无 IO。
 */
export function planReload(changedPaths: readonly string[], roots: readonly string[]): ReloadPlan {
  const changedDirs = new Set<string>()
  const ignored: string[] = []
  let rediscover = false

  const absoluteRoots = roots.map((root) => path.resolve(root))

  for (const changed of changedPaths) {
    const absolute = path.resolve(changed)

    if (NOISE_PATTERN.test(path.basename(absolute))) {
      ignored.push(absolute)
      continue
    }

    const root = absoluteRoots.find((candidate) => isInside(candidate, absolute))
    if (root === undefined) {
      ignored.push(absolute)
      continue
    }

    const segments = path.relative(root, absolute).split(path.sep)
    if (segments.length < 2) {
      // 直接落在插件根目录下的文件：定位不到具体插件（可能是正在写入的新 plugin.json），
      // 因此只能整体重新扫描。
      rediscover = true
      ignored.push(absolute)
      continue
    }

    const pluginDir = path.join(root, segments[0] ?? '')
    if (path.basename(absolute) === 'plugin.json') {
      // 清单可能改了 id / 依赖 / 权限 —— 这些都会影响"该不该加载、算不算同一个插件"，必须重扫。
      rediscover = true
    }
    changedDirs.add(pluginDir)
  }

  return { changedDirs: [...changedDirs], rediscover, ignored }
}

export interface PluginWatcherOptions {
  /** 动态获取插件根（配置可能变化）。 */
  readonly roots: () => readonly string[]
  readonly debounceMs?: number
  readonly onPlan: (plan: ReloadPlan) => void
  readonly onError?: (error: unknown) => void
}

const DEFAULT_DEBOUNCE_MS = 150

/**
 * 对插件根做递归监听并做防抖聚合。
 *
 * 两点值得说明：
 * - `persistent: false`：监听器不该自己把进程吊住（测试环境尤其需要），
 *   在扩展宿主里事件循环本来就活着，所以不影响实际行为。
 * - 根目录不存在或不可递归监听时**不报错中断**，只回调 onError：
 *   `pluginRoots` 里配了指不到的路径是常见情况，不该让热重载整体失效。
 */
export class PluginWatcher {
  readonly #options: PluginWatcherOptions
  readonly #watchers: FSWatcher[] = []
  readonly #pending = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #forceRediscover = false
  #closed = false

  constructor(options: PluginWatcherOptions) {
    this.#options = options
  }

  get watching(): readonly string[] {
    return this.#watchers.map((watcher) => String((watcher as unknown as { _path?: string })._path ?? '?'))
  }

  get active(): number {
    return this.#watchers.length
  }

  /** 重新绑定监听。插件根变化（改配置、出现新根）后调用。 */
  refresh(): void {
    this.dispose()
    this.#closed = false

    for (const root of this.#options.roots()) {
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
          if (filename === null || filename === undefined) {
            // 定位不到具体文件 → 只能升级为一次全量重扫。
            this.#forceRediscover = true
            this.#schedule()
            return
          }
          this.#enqueue(path.join(root, String(filename)))
        })
        watcher.on('error', (error) => {
          this.#options.onError?.(error)
        })
        this.#watchers.push(watcher)
      } catch (error) {
        this.#options.onError?.(error)
      }
    }
  }

  dispose(): void {
    this.#closed = true
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    for (const watcher of this.#watchers.splice(0)) {
      try {
        watcher.close()
      } catch {
        // 关闭失败无需处理
      }
    }
    this.#pending.clear()
    this.#forceRediscover = false
  }

  #enqueue(file: string): void {
    if (this.#closed) return
    this.#pending.add(file)
    this.#schedule()
  }

  #schedule(): void {
    if (this.#closed) return
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      const paths = [...this.#pending]
      this.#pending.clear()
      const rediscover = this.#forceRediscover
      this.#forceRediscover = false

      const plan = planReload(paths, this.#options.roots())
      const merged: ReloadPlan = {
        changedDirs: plan.changedDirs,
        rediscover: plan.rediscover || rediscover,
        ignored: plan.ignored,
      }
      if (merged.changedDirs.length > 0 || merged.rediscover) {
        this.#options.onPlan(merged)
      }
    }, this.#options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
  }
}
