# ADR-0007：依赖声明、解析与级联回收

状态：已接受（2026-02-14）

## 决策 1：`dependencies` 的键是**服务名**，不是插件 id

```json
{ "id": "consumer-greeting", "dependencies": { "clock": "^1.0.0" } }
```

理由：Cordis 的"空间可组合性"要求依赖**契约**而非**实现**。`provider-clock` 可以被
`provider-clock-v2` 替换，只要它提供同名同版本范围的服务，消费者不需要改一行代码。
若依赖插件 id，提供者更换就会强制消费者改清单——那只是 `extensionDependencies` 的翻版。

## 决策 2：版本范围只支持最小子集

支持 `*`、精确 `1.2.3`、`^1.2.3`、`>=1.2.3`。**超出子集的写法在 manifest 校验期报错**（fail-closed），
不静默当作 `*`。

理由：不引入 `semver` 依赖（避免供应链面与 bundle 体积）；这 4 种覆盖插件间协作的实际需要。
纯自研实现约 30 行，且可被单测完全覆盖。

## 决策 3：冲突策略默认 `exclusive`

同一服务名被第二个提供者注册时**直接抛 `ServiceConflictError`**，与 cordis `reflect.ts#L190` 一致。
可在 `provide()` 时显式传 `conflict: 'last-wins'` 覆盖。

理由：静默覆盖会让"服务到底是谁提供的"变成不可诊断的运行时谜题；显式冲突优于隐式替换。

## 决策 4：提供者变化 → 消费者 `pause`（不是卸载删除）

状态机：`idle → loading → active ⇄ paused`，异常路径 `→ failed`，`paused/waiting` 由依赖恢复驱动回 `active`。

- 硬依赖被撤销 → 消费者执行**完整卸载**（`deactivate()` → `EffectStack` LIFO → 解依赖边 → 释放模块缓存），
  但**保留记录**，状态置 `paused`；
- 硬依赖重新就绪 → 消费者**完整重新 activate**（重新 `require`，拿到新提供者的实例）；
- 软依赖（`tryUse`）不级联、不触发 `pause`，只登记用于诊断的边。

## 决策 5：级联是 EffectStack 的自然结果，不是特判

场景：A 提供 `clock`；B 消费 `clock` 并提供 `scheduler`；C 消费 `scheduler`。

A 卸载 → 撤销 `clock` → B `pause` → B 的 `provide('scheduler')` 是 B 栈上的一项 effect，
随栈回收而撤销 → `scheduler` 消失 → C `pause`。**没有任何一行代码专门处理"传递闭包"**，
级联由「服务的生命周期挂在 EffectStack 上」自动导出。这是本设计最核心的一条。

## 决策 6：全局串行队列

所有 `load` / `unload` / `reload` / `pause` / `resume` 走同一个 promises 队列。
依赖变化事件在队列**尾部**排队，保证「提供者先彻底卸载完毕，消费者才开始暂停」，
避免半个服务状态被观察到的竞态。

## 备选方案与否决理由

- **加载时按拓扑序排序，运行时不做协调**：否决。不满足"提供者变化时依赖方自动响应"。
- **scope 级细粒度重入（cordis 的完整时空模型）**：本轮否决为用户明确选择（v1 采用插件级 PAUSE/RELOAD）。
  细粒度会导致全局命令表"闪现"（注册/撤销交替），在 VSCode 上体验更差。
- **软依赖也级联**：否决。可选增强型依赖若会导致整插件暂停，插件作者将不敢使用它。
