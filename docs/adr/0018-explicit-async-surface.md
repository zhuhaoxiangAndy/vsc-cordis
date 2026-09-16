# ADR-0018：显式异步面 `ctx.async` —— 让隔离模式也能有事件订阅，而不撒谎

状态：已接受（2026-02-14）｜决策者：无人值守自主决策｜**部分取代 ADR-0016 的一条判定**

## 背景：ADR-0016 的判定里有个没被检验的前提

ADR-0016 判定「`onDidSaveTextDocument` 在隔离模式下不可支持」，理由是很硬的：
回调参数是 `TextDocument`，带 `getText()` / `positionAt()` 这类**同步方法**，
而跨进程只能传纯数据 —— 于是类型契约会撒谎。

但那个判定默认了一个前提：**必须复用同一个 API 面**（`ctx.vscode.workspace.onDidSaveTextDocument`）。
这个前提本身没被检验。一旦放弃它，问题就有解。

## 决策 1：新增 `ctx.async` —— **显式异步面**，两种模式同一份签名

```ts
export interface AsyncTextDocument {
  readonly uri: string          // 纯数据
  readonly fsPath: string
  readonly languageId: string
  readonly lineCount: number
  readonly version: number
  getText(): Promise<string>    // ← 类型上就写着异步，不存在"看起来同步"的伪装
}

export interface AsyncApi {
  onDidSaveTextDocument(listener: (document: AsyncTextDocument) => void): Promise<Disposable>
}
```

关键点有三条，缺一不可：

1. **类型上就是异步的**（`Promise<Disposable>`、`Promise<string>`）——不撒谎；
2. **两种模式都提供同一份签名**——插件代码不需要分支；
3. **同进程模式也走同一套语义**（把真实 `TextDocument` 适配成 `AsyncTextDocument` 形状）。

第 3 条是刻意的：如果只在隔离模式提供 `ctx.async`，插件作者就得写
`if (隔离) { ... } else { ... }`，那正是 ADR-0016 想避免的分裂。
代价是同进程模式下多一个微任务的包装开销（`Promise.resolve(document.getText())`），
换"一份代码两种模式"完全值得。

## 决策 2：正文**按需取**（句柄），不随事件整篇传输

事件载荷是纯数据 + 一个**文档句柄**：

```
宿主: onDidSaveTextDocument(真实文档) → { uri, fsPath, languageId, lineCount, version, documentHandle }
子进程: doc.getText() → RPC(document.getText, [handle]) → 宿主按句柄取正文
```

- 为什么不在事件里塞正文：大文件每次保存都整篇走 IPC 是不可接受的。
- 为什么不把整篇留在宿主里"等插件随时来取"：那会把文档一直钉在内存里。
  所以句柄**有生命周期** —— 每个插件只保留最近 64 个，超出的淘汰；
  用旧句柄读正文会得到一条**明确的**"句柄已过期"，而不是空串。
- 句柄**按插件归属校验**：与输出通道、状态栏项一致，猜一个数字不能读别人的文档。

## 决策 3：同步入口继续不支持，但错误信息必须给出**替代路径**

`ctx.vscode.workspace.onDidSaveTextDocument` 在隔离模式下仍然抛错，
但文案从"不支持，见 ADR-0016"改成"请改用 `ctx.async.onDidSaveTextDocument`，见 ADR-0018"。

只告诉用户"不行"而不告诉"那该怎么办"是**半个答案**。
测试也相应地断言这条替代路径存在 —— 有专门一条用例同时用两个入口，
验证同步那个抛错、异步那个正常工作、两者互不污染。

## 决策 4：订阅归到 `vscode:workspace.read` 权限下

事件订阅读的是工作区内容，因此需要 `vscode:workspace.read`。
未授权时激活失败（不是静默无订阅）——与本项目"越权即响亮失败"的一贯处理一致。

## 决策 5：卸载时清理必须**双向**

宿主侧的订阅（真实 VSCode 监听器）与子进程侧的监听器表都要清：

- 子进程侧：`LocalDisposable` 删除本地监听器 + 通知宿主 `events.unsubscribe`；
- 宿主侧：`IsolatedSession.#cleanupHostSide` 在子进程退出时兜底释放所有订阅。

少了任何一边都会留下"事件发进黑洞"或"宿主白跑监听"的残留。测试同时断言
`saveSubscriptions.active === 0` 与 `disposed === 1`。

## 未覆盖

1. **跨进程服务仍然没有对等物**（`ctx.async` 里没有 `useService`）。
   事件转发只需要"单向推 + 一次按需取"，而服务需要一个**方法级 RPC 协议**：
   方法发现、参数与返回值的序列化契约、方法调用失败的错误传播、以及"提供者退出时
   消费者的在途调用怎么办"。这不是一个量级的工作，且没有它并不影响隔离方案成立 ——
   需要服务协作的插件用 `trust: trusted`（ADR-0003 已说明它只防误用）。
2. **只覆盖 `onDidSaveTextDocument` 一种事件**。配置变化、活动编辑器变化等尚未纳入 `ctx.async`；
   纳入哪一个由真实需求驱动，而不是先把面铺开。
3. **同进程模式下 `getText()` 的返回值是快照**（调用时刻的正文），
   而隔离模式下是**按句柄取回的当时正文**。两者在"调用后对方又改了文档"这一瞬间可能有差异，
   实战中无影响（保存事件里读正文），但值得记下来。
4. 句柄淘汰是**按数量**而不是按时间的近似值；64 这个数字没有实测依据，属于保守选择。
