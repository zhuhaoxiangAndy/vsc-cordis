# ADR-0009：工具链与"零网络可验证"

状态：已接受（2026-02-14）

## 背景

无人值守执行 + 额度受限 + 依赖需从镜像下载。原技术栈建议里包含 Vitest；但测试框架一旦不可安装，
整个验证链条就会中断，导致"无法证明代码可运行"。

## 决策

1. **测试框架用 Node 内置 `node:test` + `node:assert/strict`**，直接执行 `.ts` 文件
   （Node ≥ 22.18 原生类型剥离，且桥接 stub 需要的 `module.registerHooks` 已可用；
   本机 Node v24.12.0）。
   - 理由：零依赖 → 无网络也能跑；`kernel` 是纯状态机，不需要 snapshot/mock 设施。
   - 代价：没有 Vitest 的 `expect` 语法糖与 watch UI。可接受。
   - Vitest 保留为可选升级路径，不进本轮依赖。
2. **类型检查用 `tsc --noEmit`**（`npm run typecheck`），依赖仅在镜像可用时安装；不可用时测试仍可运行。
3. 由于"类型剥离"的限制，代码层面强制遵守：
   - **禁用** `enum`、`namespace`、构造函数参数属性、装饰器（不可擦除语法）；
   - 相对导入**必须带 `.ts` 扩展名**（Node ESM 不做扩展名推断）；
   - 跨包引用**只能是 `import type`**（运行时靠 tsconfig `paths` 与 esbuild 解析；类型被擦除后运行时不依赖解析）；
   - `verbatimModuleSyntax: true` 强制显式 `import type`，把这条纪律交给编译器看守。
4. 模块系统：内核与 SDK 声明 `"type": "module"`；宿主扩展产物固定为 `dist/extension.cjs`
   （VSCode 加载 CJS 最稳），由 esbuild 直接决定产物格式，不依赖包的 `type` 字段。
5. **pnpm 供应链保护（`allowBuilds`）用显式清单，不留未决项**：只放行 `esbuild`
   （需要执行安装脚本落地平台二进制），对 `@vscode/vsce-sign` 显式写 `false`
   （它的 `postinstall` 会从平台包复制、失败则 HTTPS 下载「vsce sign」用的二进制；
   而本仓库只用 `vsce package` 打包、不签名）。显式拒绝同时避免了隐式网络下载。
   - 取证：pnpm 11.6 会把新发现的被拦截依赖写成占位文本 `set this to true or false`；
     pnpm **11.7.0 起**该未决值直接让 `pnpm install` 退出 1
     （`ERR_PNPM_IGNORED_BUILDS`），并连带使 `pnpm run <script>`（内部做依赖状态检查）
     全部不可运行 —— 即"基线验证命令本身跑不起来"。
   - 这是"零网络可验证"的一部分：任何隐式下载都会让无网环境失败，所以策略必须是
     "显式放行需要的、显式拒绝其余"，而不是"交给默认值"。

## 后果

- 任何环境（含 CI 无网缓存）下 `npm test` 都能给出确定结果，这是无人值守的关键前提。
- 代价：测试断言比 Vitest 冗长；若将来引入 Vitest，需要迁移 `.spec.ts` 的 import（工作量可控）。
