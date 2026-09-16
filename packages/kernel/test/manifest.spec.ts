import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSafeRelativePath, validateManifest } from '../src/manifest.ts'

const base = {
  id: 'com.example.hello',
  name: 'Hello',
  version: '1.0.0',
  main: 'dist/index.cjs',
}

test('合法清单通过校验，并补齐默认值', () => {
  const result = validateManifest({ ...base })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.manifest.id, 'com.example.hello')
  assert.equal(result.manifest.trust, 'untrusted') // 默认最严：没有隔离后端就拒绝加载
  assert.deepEqual(result.manifest.dependencies, {})
  assert.deepEqual(result.manifest.permissions, [])
})

test('简单 id（无点号）同样合法', () => {
  const result = validateManifest({ ...base, id: 'hello' })
  assert.equal(result.ok, true)
})

test('缺少必填字段时给出逐条错误', () => {
  const result = validateManifest({ name: 'X' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors.length, 3) // id / version / main
})

test('main 禁止绝对路径与 .. 逃逸', () => {
  for (const main of ['/abs/index.cjs', 'C:\\abs\\index.cjs', '../outside.cjs', 'a/../../b.cjs']) {
    const result = validateManifest({ ...base, main })
    assert.equal(result.ok, false, `应当拒绝 main=${main}`)
  }
})

test('main 必须是打包后的单文件（.cjs/.mjs/.js）', () => {
  const result = validateManifest({ ...base, main: 'src/index.ts' })
  assert.equal(result.ok, false)
})

test('未知权限导致拒绝加载（fail-closed）', () => {
  const result = validateManifest({ ...base, permissions: ['vscode:commands.register', 'vscode:root'] })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.errors.join('\n'), /未知权限 "vscode:root"/)
})

test('依赖的版本范围只接受支持的子集', () => {
  const ok = validateManifest({ ...base, dependencies: { clock: '^1.2.3', logger: '*' } })
  assert.equal(ok.ok, true)

  const bad = validateManifest({ ...base, dependencies: { clock: '~1.2.3' } })
  assert.equal(bad.ok, false)
  if (bad.ok) return
  assert.match(bad.errors.join('\n'), /版本范围非法/)
})

test('依赖键必须是合法的服务名', () => {
  const result = validateManifest({ ...base, dependencies: { 'Bad Name': '*' } })
  assert.equal(result.ok, false)
})

test('trust 只接受 trusted / untrusted', () => {
  assert.equal(validateManifest({ ...base, trust: 'trusted' }).ok, true)
  const bad = validateManifest({ ...base, trust: 'root' })
  assert.equal(bad.ok, false)
})

test('非对象输入直接拒绝', () => {
  assert.equal(validateManifest(null).ok, false)
  assert.equal(validateManifest([]).ok, false)
  assert.equal(validateManifest('x').ok, false)
})

test('isSafeRelativePath 的边界', () => {
  assert.equal(isSafeRelativePath('dist/index.cjs'), true)
  assert.equal(isSafeRelativePath('a/b/c.js'), true)
  assert.equal(isSafeRelativePath(''), false)
  assert.equal(isSafeRelativePath('/etc/passwd'), false)
  assert.equal(isSafeRelativePath('a//b.js'), false)
  assert.equal(isSafeRelativePath('a/../b.js'), false)
})
