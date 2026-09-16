import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ISOLATION_UNSUPPORTED, unsupportedReason } from '../src/isolation/protocol.ts'

/**
 * 项目规则（ADR-0018 决策 3）：**只告诉用户"不行"而不告诉"那该怎么办"是半个答案。**
 *
 * 这条规则以前只由一条针对 `onDidSaveTextDocument` 的用例守着；这里把它升级为
 * **遍历整张 `ISOLATION_UNSUPPORTED` 表**的元测试 —— 未来新增"隔离模式不支持 X"时，
 * 忘记写替代路径会立刻变红，而不是等到用户来问。
 *
 * 断言刻意"机械化"：不判断文案好不好，只要求每一条都包含可机检的三要素
 * （为什么 / 替代路径 / 可操作的 API 或开关）。文风交给 code review。
 */
test('ISOLATION_UNSUPPORTED：每一条都必须同时给出"为什么"与"替代路径"', () => {
  const entries = Object.entries(ISOLATION_UNSUPPORTED)

  // 哨兵：表为空（或被人清空）时这条元测试必须失败，不能"全绿但什么也没查"
  assert.ok(entries.length >= 3, `表里有 ${entries.length} 条 —— 少于 3 条说明这条元测试正在空转`)

  for (const [member, reason] of entries) {
    assert.ok(reason.length >= 40, `${member} 的说明太短（${reason.length} 字），不足以解释原因与出路`)
    // 为什么不行
    assert.match(reason, /不可用|不支持|不能用|无法|拿不到/, `${member} 必须说清"为什么不行"`)
    // 替代路径的存在性
    assert.match(
      reason,
      /请改用|请用|用 |改用|两个选择|要看|或者/,
      `${member} 必须给出替代路径（只写"不行"是半个答案）`,
    )
    // 替代路径必须可操作：提到具体 API / 开关 / 入口命令
    assert.match(
      reason,
      /ctx\.async|trust:|ctx\.vscode|vscordis: |vscordis tree/i,
      `${member} 的替代路径应当提到具体 API 或开关，而不是只说"换个方式"`,
    )
  }
})

test('unsupportedReason：未知成员也要给出可读兜底（不能返回空串）', () => {
  const message = unsupportedReason('something.unknown')
  assert.match(message, /隔离模式不支持 something\.unknown/)
})
