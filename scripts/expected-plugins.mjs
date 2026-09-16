// 构建/冒烟/门禁共享的插件清单单一来源。
// 目的：新增或删除示例插件时必须显式更新这里，避免 build 的 `continue` 或 smoke 的
// “0 个插件也算通过”把缺失目标变成静默成功。
export const EXPECTED_PLUGINS = [
  'consumer-greeting',
  'hello',
  'isolated-hello',
  'provider-clock',
]
