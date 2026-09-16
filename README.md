# vsc-cordis

把 [Cordis](https://github.com/cordiverse/cordis) 的「时空可组合性」迁移到 VSCode 扩展开发：
在 Extension Host 之上运行一个微型插件运行时，使业务功能以**插件**形式动态加载、卸载、热重载，
通过声明式依赖声明服务依赖，服务提供者变化时自动协调依赖方。

- **时间可组合性**：所有副作用经 `ctx.effect` 登记，由 `EffectStack` 以 LIFO 逆序回收。
- **空间可组合性**：服务经 `ServiceRegistry` 提供/注入，维护依赖图，提供者变化时自动暂停/恢复消费者。
- **不修改 VSCode 源码，不使用非公开 API。** 宿主本身是一个普通 VSCode 扩展。

```
进度：M1（PoC）✅   M2（依赖协调）✅   M3（热重载）✅   M4a（完整性/签名）✅   M4b（子进程隔离）✅   M5（CLI）✅

全部五个里程碑已交付。**但 M1–M4b 的真实验收仍需你在真 VSCode 里按 F5 走一遍**
（三份步骤表见 `docs/acceptance-*.md`）—— 自动化测试覆盖了 kernel、加载器、watcher、完整性与隔离，
唯独桥接层与真实 Electron 行为只能手动确认。
```

## 目录

| 路径 | 包名 | 职责 |
| --- | --- | --- |
| `packages/sdk` | `@vscordis/sdk` | **契约层**：`PluginContext` / `CordisPlugin` / `plugin.json` / 权限 / 受控 API 类型。零运行时依赖。 |
| `packages/kernel` | `@vscordis/kernel` | **实现层**：`EffectStack` / `ServiceRegistry` / `PluginHost` / 状态机。零 `vscode`、零 Node 依赖。 |
| `packages/host` | `vscordis` | **唯一发布单元**：VSCode 扩展。把真实 API 桥接成受控面，负责加载/卸载/依赖协调/热重载。 |
| `packages/cli` | `@vscordis/cli` | **开发工具**：`create` / `list` / `tree`（依赖图 + Mermaid）/ `sign` / `dev`。 |
| `plugins/*` | — | 示例插件（esbuild 打成单文件 CJS）。 |
| `docs/adr` | — | 架构决策记录，每条含权衡与否决方案。 |
| `docs/acceptance-*.md` | — | 手动验收步骤、时延预算与未覆盖范围。 |

## 快速开始

```bash
pnpm install                       # 需要 Node >= 22.18（原生类型剥离）
pnpm run verify                    # 类型检查 + 119 项测试 + 构建 + 产物冒烟
```

开发时开两个进程：

```bash
pnpm run watch                     # 终端 A：esbuild 监听插件源码 → 增量重建
# 终端 B / VSCode：按 F5 启动扩展开发宿主
```

改 `plugins/*/src/**` 保存后，宿主会在 **~250ms** 内自动卸载并重载该插件
（时延预算分解与实测方法见 `docs/acceptance-m3.md`）。

`Ctrl+Shift+P` 输入 `VSCordis` 可见 6 个入口命令。

## 打包（本地 VSIX）

```bash
pnpm run verify:release            # 生产构建 → vsce 打包 → 校验真实 VSIX
code --install-extension vscordis-local.vsix    # 装进你自己的 VSCode
```

打包用官方的 **`@vscode/vsce`**（devDependency），理由是 VSIX 格式的权威实现就是它 ——
自写一个"能被解压工具打开"的 ZIP 只能证明 ZIP 合法，证明不了 VSCode 会接受它；
而且 vsce 会顺带校验扩展清单（能抓出 `browser` 指向不存在文件这类问题）。

`pnpm run verify:package` 校验的是**真实产物**：直接读 VSIX 的 ZIP 中央目录，
断言 `dist/extension.cjs`、`dist/isolated-worker.cjs`、`dist/web/extension.js`、
`keys/*.pub.pem`、`package.json` 都在，且源码 / 测试 / `node_modules` / sourcemap 都不在。
刻意不去自己实现一遍 ignore 语义再断言 —— 那只证明"我的实现和我的理解一致"。

生产构建的 VSIX 约 **34 KB**（开发构建约 209 KB，差在 sourcemap 与压缩）。
`packages/host/.vscodeignore` 的取舍写在文件注释里。

> 打包时会提示 `LICENSE ... not found`。这是 vsce 为**发布到市场**做的检查，
> 而发布到市场是你明确划出的红线；仓库根目录已有 MIT LICENSE，此处不复制作第二份以免漂移。

## 签名（M4a）

```bash
pnpm run keygen                                  # 生成密钥对：私钥在仓库外，公钥在 packages/host/keys/
pnpm run sign -- plugins/hello --verify          # 签名 + 立刻用仓库公钥回验
```

策略：**工作区插件可未签名；装入 `globalStorage` 的插件必须签名 + 哈希**，
且校验发生在 `require` **之前**。完整操作手册与错误对照表见 `docs/signing.md`。

签名保证"这段代码就是发布者发布的那段"，**不保证**它是善意的 —— 沙箱是另一件事（M4b）。

## 子进程隔离（M4b）

`plugin.json` 里声明 `"trust": "untrusted"` 的插件会被加载到**独立子进程**：

- 子进程里**没有 `vscode` 模块**（连模块解析都被权限模型挡住）—— 这是真边界，不是约定；
- 文件系统被 Node 权限模型限制在插件自己的目录内（越界读得到 `ERR_ACCESS_DENIED`）；
- 命令 handler 留在子进程，宿主执行命令时**反向调用**它求值；
- 子进程的寿命 = 宿主侧的一项 effect，卸载时 `kill` 是兜底。

隔离层刻意**不 import `vscode`**（宿主能力由接口注入），因此整条链路可以用 `node --test`
端到端验证：10 项测试跑的是**真实子进程 + 真实 IPC + 真实 `--permission`**。
示例插件 `plugins/isolated-hello`，手动验收见 `docs/acceptance-m4b.md`。

刻意收窄的边界（抛错并说明原因，不给假接口）：隔离插件**不能**用服务（`ctx.use`/`provide`）、
**不能**用 `createStatusBarItem` / `getConfiguration` / `onDidSaveTextDocument` —— 这些留到 M4c。
`net` 权限是**约定**而非强制（Node 没有网络开关）。详见 `docs/adr/0013-isolation-backend.md`。

## CLI（M5）

```bash
pnpm run tree                      # 服务依赖图（本仓库真实输出见下）
pnpm run cli -- tree --mermaid     # Mermaid flowchart，可直接贴进 Markdown
pnpm run cli -- create my-plugin --trust untrusted
pnpm run cli -- list               # 退出码 1 = 发现问题，可直接进 CI
```

```
vscordis 依赖图：4 个插件，1 个服务

加载顺序：hello → isolated-hello → provider-clock → consumer-greeting

服务
  clock
    ├─ 提供者：provider-clock
    └─ 消费者：consumer-greeting
```

`tree` 能画出图的前提是 `plugin.json` 的 **`provides` 声明**：
服务是运行期 `ctx.provide()` 注册的，清单里没有这个概念。
`provides` **只服务工具**——它不参与任何加载决策，声明与实际不符也不会加载失败，
但宿主会在激活后比对二者并**告警**（避免重演 `CordisPlugin.inject` 那种"声明了却不生效"的坑）。

静态图的**硬边界**（CLI 会把它打在输出里）：服务的**版本**由运行期 `ctx.provide(name, value, {version})`
决定，清单里没有，所以图只能校验"有没有提供者"；隔离插件不参与服务依赖。详见 `docs/adr/0014-cli-and-provides.md`。

## 能力矩阵（诚实版）

| 能力 | Desktop / Remote 宿主 | Web 宿主 (vscode.dev) |
| --- | --- | --- |
| 同进程受控 API 插件 | ✅ | ✅ |
| 运行期加载磁盘上的插件 | ✅ | ❌ 浏览器无法运行期加载代码，仅支持**构建期内置**插件 |
| 文件监听自动热重载 | ✅（`npm run watch` + `vscordis.hotReload`） | 不适用 |
| 手动 reload（拿到新模块实例） | ✅ | ✅（内置插件重新取工厂产物） |
| 子进程隔离（untrusted） | ✅ M4b（`docs/acceptance-m4b.md`） | ❌ 直接拒绝加载（fail-closed） |
| 签名与哈希校验 | ✅ M4a（`docs/signing.md`） | ✅ 同一实现（平台无关） |

## 已知硬限制（均有 ADR 与一手证据）

1. **运行时注册的命令不会出现在命令面板**：面板条目来自静态 `contributes.commands`（MenuRegistry），
   只有 `vscode.commands.getCommands(true)` 能反映运行期注册表。宿主为此提供 `vscordis: 运行插件命令…`
   作为动态入口。详见 `docs/adr/0002`。
2. **同进程插件可以绕过受控 API**：扩展宿主把 `vscode` 模块注入给任何扩展目录下的模块，
   `trust: trusted` 的插件在安全上**只防误用、不防恶意**；真正的边界是子进程。详见 `docs/adr/0003`。
3. **Node 权限模型没有网络开关**：`--permission` 可限制 `fs`/`child-process`/`worker`/`addons`，
   但**无法限制 `net`**，网络只能靠 require 拦截 + 审计（M4）。详见 `docs/adr/0005`。
4. **VSCode 官方不支持运行期卸载单个扩展**，因此卸载粒度是「扩展内部的插件」，不是扩展本身；
   宿主自身（`packages/host/**`）的改动也无法热重载，需要重载窗口。
5. **Web 端无法运行期加载代码**，且 Web 扩展宿主里 `require` 不可用（入口必须为 ESM）。详见 `docs/adr/0006`、`0010`。
6. **热重载失败不回滚**：新版本 `activate` 失败时插件进入 `failed` 并弹出警告，不会自动退回旧版本
   （回滚需要旧版本与旧状态同时保活，会让"无残留"无法断言）。详见 `docs/adr/0011`。

## 从 Cordis 继承了什么、刻意分歧了什么

| Cordis | 本项目 | 理由 |
| --- | --- | --- |
| `ctx.effect(cb)` 返回 disposer | `ctx.effect(register, dispose)` + `ctx.effectAsync` | `register` 必须同步，否则"拿到句柄"与"登记逆操作"之间的 await 窗口会导致资源逃逸 |
| fiber 顶层 disposer 逆序启动 + `Promise.all` 并发 | **严格 LIFO + 串行 `await`** | 并发回收会让"先释放 A、再释放依赖 A 的 B"退化成竞态 |
| `ctx.inject(deps, cb)` 细粒度重入 | 插件级 `paused`/`active` | VSCode 的命令表是全局的，细粒度重入会让命令"闪现"（ADR-0007） |
| 同名 service 在同一 isolate 内重复即抛错 | 默认 `exclusive`，可显式 `last-wins` | 与 cordis 一致，并补上显式接管路径 |
| `ctx.set` 要求同一 fiber 已 provide | 合并为 `ctx.provide` | 减少概念数量；两者差异在本场景没有实际收益 |

## 开发约定

- 测试用 **Node 内置 `node:test`** + 原生类型剥离，零测试框架依赖、无网络也可跑（ADR-0009）。
- 因为类型剥离不支持不可擦除语法，代码里禁用 `enum` / `namespace` / 构造函数参数属性 / 装饰器；
  相对导入必须带 `.ts` 扩展名；跨包引用只能是 `import type`（由 `verbatimModuleSyntax` 强制）。
- 插件产物必须是**单文件 CJS**，且构建期禁止 `import 'vscode'`（`scripts/build.mjs` 的 `forbid-vscode`）。
- `scripts/*.ps1` 必须保持 **ASCII-only**：PowerShell 5.1 会按 ANSI 代码页解码无 BOM 的 `.ps1`，
  中文会把后面的引号字节吞掉。中文提交信息走 `scripts/commit-messages/*.txt` + `git commit -F`。
