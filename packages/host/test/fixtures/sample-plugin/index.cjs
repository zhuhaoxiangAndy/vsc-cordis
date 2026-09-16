// 测试夹具：用模块级状态证明"重新 require 会得到全新的模块实例"。
// 若 require.cache 没被清干净，重载后 incarnation 不变、activations 会继续累加。
let activations = 0
const incarnation = Math.random().toString(36).slice(2)

module.exports = {
  name: 'fixture',
  activate() {
    activations += 1
  },
  __telemetry() {
    return { incarnation, activations }
  },
}
