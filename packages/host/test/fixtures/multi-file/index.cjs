// 多文件夹具：入口 require 了自己的子模块，用于验证"卸载要清整棵子树，而不只是入口那一条"。
const helper = require('./helper.cjs')

module.exports = {
  name: 'multi-file',
  helperIncarnation: helper.incarnation,
  activate() {},
}
