import assert from 'node:assert/strict'
import { test } from 'node:test'
import { satisfies } from '../src/semver-mini.ts'

test('* 匹配任何合法版本', () => {
  assert.equal(satisfies('0.0.1', '*'), true)
  assert.equal(satisfies('9.9.9', '*'), true)
  assert.equal(satisfies('not-a-version', '*'), false)
})

test('精确版本', () => {
  assert.equal(satisfies('1.2.3', '1.2.3'), true)
  assert.equal(satisfies('1.2.4', '1.2.3'), false)
})

test('caret：^1.2.3 允许同主版本内的升级', () => {
  assert.equal(satisfies('1.2.3', '^1.2.3'), true)
  assert.equal(satisfies('1.9.0', '^1.2.3'), true)
  assert.equal(satisfies('1.2.2', '^1.2.3'), false)
  assert.equal(satisfies('2.0.0', '^1.2.3'), false)
})

test('caret：0.x 收紧到次版本（与 npm 语义对齐）', () => {
  assert.equal(satisfies('0.2.5', '^0.2.3'), true)
  assert.equal(satisfies('0.3.0', '^0.2.3'), false)
  assert.equal(satisfies('0.0.3', '^0.0.3'), true)
  assert.equal(satisfies('0.0.4', '^0.0.3'), false)
})

test('>= 下界', () => {
  assert.equal(satisfies('2.0.0', '>=1.2.3'), true)
  assert.equal(satisfies('1.2.3', '>=1.2.3'), true)
  assert.equal(satisfies('1.2.2', '>=1.2.3'), false)
})
