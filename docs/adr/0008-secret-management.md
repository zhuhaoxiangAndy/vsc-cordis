# ADR-0008：密钥与签名材料的存放

状态：已接受（2026-02-14）

## 背景

用户选择：开发模式（工作区插件）可未签名；装入 `globalStorage` 的插件必须签名 + 哈希校验。
用户对密钥归属的回答是"我生成，但需要告诉我怎么操作（或你代我操作）"。

签名（M4 范围）里有一个经典坑：**如果签名放在 `plugin.json` 内部，签的到底是什么？**
把 `signature` 字段也算进被签内容会导致自引用。

## 决策

1. **签名覆盖的内容 = 规范化 JSON（去掉 `signature` 字段后的 manifest）+ 产物完整性信息**：

   ```
   payload = canonicalJSON({ manifest: <manifest 去掉 signature>, integrity: { algorithm, file, hash } })
   signature = ed25519.sign(payload)
   ```

   签名**独立存放**在插件目录的 `plugin.sig`（base64），不进 manifest，避免自引用。

2. **密钥存放**：
   - 私钥：`%USERPROFILE%\.dsh\keys\vscordis-ed25519.pem`（**工作区之外**，`.gitignore` 亦已排除 `*.key`/`*.pem`）
   - 公钥：仓库内 `keys/vscordis-ed25519.pub.pem`（供验证；可公开）
3. 生成脚本 `scripts/gen-key.mjs`，使用 `node:crypto` 的 `generateKeyPairSync('ed25519')`，
   **不引入任何第三方依赖**；脚本默认打印公钥并只在指定路径写私钥。
4. 私钥**永不**进入：git、日志、CI、错误信息、`plugin.json`。
5. 用户希望自己操作时：执行
   `node scripts/gen-key.mjs --out "%USERPROFILE%\.dsh\keys\vscordis-ed25519.pem"`，
   然后把打印出的公钥提交到 `keys/vscordis-ed25519.pub.pem`。
   我代执行时会显式说明这是工作区外的**写**操作。

## 后果

- 密钥可随时轮换：换公钥后，旧签名插件需重签；`plugin.json` 中的 `engines.vscordis` 可用来排除过旧插件。
- 单密钥方案没有吊销机制。若将来要发布到市场，需要升级为公钥清单 + 版本化信任根，列为后续工作。
