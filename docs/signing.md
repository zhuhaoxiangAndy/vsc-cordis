# 签名与完整性校验：操作手册

对应决策：`docs/adr/0008-secret-management.md`（密钥存放）、`docs/adr/0012-integrity-and-signing.md`（策略与语义）。

## 一分钟版本

```bash
node scripts/gen-key.mjs                        # 1. 生成密钥对
git add packages/host/keys/*.pub.pem            # 2. 公钥入库
node scripts/sign-plugin.mjs plugins/hello      # 3. 给插件签名
```

## 三步详解

### 第 1 步：生成密钥对

```bash
node scripts/gen-key.mjs
```

产出两个文件，**位置刻意分开**：

| 文件 | 路径 | 是否入库 |
| --- | --- | --- |
| 私钥 | `%USERPROFILE%\.dsh\keys\vscordis-ed25519.pem` | ❌ **绝不**（工作区之外；`.gitignore` 另加 `*.pem` 双保险） |
| 公钥 | `packages/host/keys/vscordis-ed25519.pub.pem` | ✅ 必须入库，否则宿主无法验签 |

验证私钥确实不在仓库范围内：

```bash
git status --short          # 不应出现任何 .pem 私钥
git ls-files "*.pem"        # 只应看到 packages/host/keys/*.pub.pem
```

私钥位于 `%USERPROFILE%\.dsh\keys\`，**在仓库之外**，因此 git 在物理上无法跟踪它
（这也比"依赖 .gitignore"更可靠）。`.gitignore` 里的 `*.pem` 是第二道防线，
用来拦住"有人不小心把私钥生成在仓库里"的情况 —— 注意它同时需要一条**反向例外**：

```gitignore
*.pem
!packages/host/keys/*.pub.pem   # 公钥必须能入库，否则宿主无法验签
```

换一个位置（例如放在你自己的密钥盘）：

```bash
node scripts/gen-key.mjs --out D:\keys\vscordis.pem
# 之后签名时要显式指定：
node scripts/sign-plugin.mjs plugins/hello --key D:\keys\vscordis.pem
```

覆盖已有密钥必须显式加 `--force`，并且要明白后果：**所有已发布的旧签名会全部失效**。

### 第 2 步：给插件签名

```bash
node scripts/sign-plugin.mjs plugins/hello
```

它会做两件事：

1. 计算 `main` 指向产物的 sha256，写进 `plugin.json` 的 `integrity` 字段；
2. 对整个清单的**规范化 JSON**（递归按 key 排序）签名，base64 结果写入插件目录下的 `plugin.sig`。

签名为什么放**独立文件**而不是 `plugin.json` 里：把签名塞进被签内容会造成自引用
（"签的是什么"变成循环）。详见 ADR-0008。

> ⚠️ 该命令会**重写 `plugin.json`**（保留字段、统一 2 空格缩进 + 结尾换行）。
> 因为签名覆盖整个清单，**任何字段改动之后都必须重新签名**。

### 第 3 步：理解策略（什么时候必须签名）

| 插件来源 | `source` | 是否必须签名 | 说明 |
| --- | --- | --- | --- |
| 工作区目录（`.vscordis/plugins`、`vscordis.pluginRoots`） | `workspace` | ❌ 可选 | 开发期体验优先。若**带了签名**，仍然会被严格校验 |
| `globalStorage/plugins`（安装到本机的插件） | `global` | ✅ **必须** | 未签名直接拒绝加载，错误信息里附本手册链接 |

判定在 `NodeModuleLoader.load()` 里，**在 `require` 之前**执行 —— 否则被篡改的代码已经被求值了。

## 校验的四种结果

`verifyPluginArtifact()` 返回 `mode`，宿主把它写进输出通道：

| mode | 含义 |
| --- | --- |
| `unsigned-dev` | 无签名、无哈希（仅工作区插件允许） |
| `hash-only` | 有 `integrity` 哈希、无签名（能发现产物被换，但**不能**证明来源） |
| `signed` | 哈希 + 签名均通过 |
| 失败 | 任何一项不通过 → 抛 `PluginIntegrityError` → 插件进入 `failed` |

## 常见错误与处理

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `必须提供 plugin.sig 签名文件` | 插件来自 `globalStorage` 但没签名 | `node scripts/sign-plugin.mjs <目录>` |
| `完整性校验失败：… 的实际 sha256 为 …` | 产物被改过，或签名后重新构建了 | 重新签名 |
| `签名验证失败：清单内容与签名不匹配` | 清单被改过（或用了另一把私钥） | 重新签名；若换过密钥，检查公钥文件是否更新 |
| `插件带签名，但宿主未配置验证公钥` | 仓库里没有 `packages/host/keys/vscordis-ed25519.pub.pem` | 生成密钥并提交公钥 |
| `integrity.hash 必须是 64 位十六进制 sha256` | 手改坏了 | 重新签名 |

## 明确的边界（不要误以为它解决了沙箱问题）

签名保证的是**"这段代码就是发布者发布的那段"**，它**不保证**这段代码是善意的。
同进程加载的插件可以绕开受控 API 直接拿到 `vscode` 模块（ADR-0003 有源码级证据），
因此 `trust: trusted` 的插件在安全上只防误用、不防恶意。

真正的边界是**子进程隔离**（M4b，见 ADR-0013/0019）：有隔离后端时 `trust: untrusted` 在子进程
运行；**没有**隔离后端或 Web 宿主才 fail-closed 拒绝加载。**签名与隔离是互补的两件事，不能互相替代。**
