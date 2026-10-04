# Agent Note: 分离 Session 地址与执行视图

Status: implemented

[English](2026-10-04-session-address-execution-presentation.md) | 中文

## 问题

稳定的对话地址可能比当前为它提供服务的执行存活更久。将该地址替换为执行身份会改变导航和产品引用；将地址继续用作执行绑定，又会把输入、控制、投影和历史定向到错误的 Session。历史执行视图还需要独立的只读状态，但不能创建另一个 Session 对象或改变 Host 权限。

共享 Conversation 外壳包含头部、输入和目标视图。在产品包中重新实现该外壳会重复其生命周期与呈现规则。产品特有的来源消息可能需要不同卡片，但增加第二个 Conversation Definition 会重复同一个持久化输入，而不是呈现其既有 Node。

## 决策

客户端将执行绑定与视图地址分离。消费方持有的 `SessionReference` 仍是 Provider 唯一的显式目标。`SessionProvider.presentationOptions` 提供稳定地址与只读呈现，不改变绑定 key、作用域上下文、可观察源或命令接收方。适配器以增量可选字段公开标准 prop `sessionAddressId` 与 `sessionReadOnly`；运行时默认值仍为实际 Session 身份与可写呈现。实际的只读 Session 快照也会让视图只读，包括共享 generation 后续切换为只读的情况。

`PropsRenderFactories<true>` 在既有 Factory render share 中为 Session 作用域组件显式提供 Provider 位置。其默认参数保留原 share，`PropsRuntime` 不要求从不使用 Provider 的组件提供它。运行时创建该位置时不要求 area renderer，仅在组件调用它时才要求。

### Conversation 装配

`main.conversation` 拥有 `conversation.binding` 选择链，其 owner 数据是已选择的 Session 身份。全部拒绝时的 fallback 渲染 `conversation.frame`。命中的消费方绑定其持有的执行引用，再渲染同一个 Factory，因此头部、transcript（文本记录）、输入与控制都使用同一个实际执行子树。该链是选择式替换，不是中间件；它不提供 `next()` 回调。

frame 拥有既有头部和正文装配，以及有序的 `conversation.top` 列表。严格 top 列表只在存在执行绑定时渲染，保留无 Session 时的 hero 和常驻 composer。历史消费方可以在只读引用下渲染另一个 frame；通用框架不会选择执行、解释产品阶段或将各段历史合并成连续 transcript。

只读呈现不挂载 composer 与头部修改控件。Chat 保留复制、查看与展开，但隐藏分支和逐消息修改操作列表。View 与分页状态仍是浏览器本地读取。呈现设置不是 Host 凭证或授权；控制器只读目标与原生 Host 校验继续承担各自职责。

### 精确节点呈现

`conversation.chat.node.presentation` 接受原始 `ChatNode`，选择一个替换正文。全部拒绝时，使用原受限钩子上下文渲染既有 keyed `conversation.chat.node` 正文。源 Definition、Node 数据、Node key、流中的包装层与 Session 事件保持不变。来源识别及任何产品卡片由消费包负责，不进入通用 Chat 折叠逻辑。

## 考虑过的替代方案

**改变全局选择的 Session。** 这会混淆稳定导航与执行身份，并重新定向无关消费方。Provider 绑定的子树隔离执行选择，同时将地址保留为呈现数据。

**将 Conversation 外壳复制到产品包。** 这会产生另一套头部、输入、视图与作用域生命周期实现。可复用 frame 将这些职责保留在既有所有者处。

**为同一来源消息创建另一个 Definition。** 这会重复 Node 与持久化事件解释。精确节点呈现仅改变既有 Node 的正文，无关来源仍使用原 keyed renderer。

**在每个组件的运行时 prop 中要求 Provider。** 即使组件不渲染 Provider，这也会扩大既有组件与 fixture（测试前置数据）的约定。显式 Factory share 选项使普通声明保持兼容。

## 影响

按地址操作的产品功能必须显式使用稳定地址，执行操作则继续使用 Provider 的实际作用域。视图所有者获取并释放其引用；Provider 借用引用，不创建引用所有权。仅显式覆盖地址无法选择另一执行。false 选项不能清除继承的只读呈现，释放一个历史视图也不会让共享只读 generation 恢复可写。

这些通用扩展不会产生 Session 事件、模型指令、工具或产品状态机。产品消费方选择引用前，必须自行核实就绪状态与当前执行；框架渲染其提供的引用，不授予执行权限。

## 验证

[执行 frame 装配测试](../../../../packages/client/ui-conversation/tests/execution-frame.client.spec.tsx) 使用脚本控制的 Remote 流和实际 `ClientSessions` 引用，启动生产 Web Client 组合及 renderer。它们验证无扩展时选择不变、有序 top 贡献、稳定地址下不同执行的 transcript、定向到实际执行的输入 RPC、共享 generation 的只读发布、引用释放，以及不改变事件和流身份的精确节点替换。它们不请求模型提供商。

[Chat 组件测试](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx) 在只读视图中保留复制，隐藏分支和逐消息修改入口，再验证可写视图中的这些控件。[Provider 测试](../../../../packages/client/ui-renderer/tests/session-provider.client.spec.tsx) 覆盖未使用该位置、且没有 area renderer 的适配器。公开的 `SlotTestRuntime` fixture 为产品策略测试镜像只读目标状态；它是测试所有的控制器 mock，不构成传输或 Host 授权证据。

[普通历史 Host 测试](../../../../packages/api/session-controller/tests/read-only-history.host.spec.ts) 启动真实的冷 Loader、Session store 和 Controller：显式只读 follow 不会提升 Agent，默认路径仍会提升。[Client 引用测试](../../../../packages/api/session-controller/tests/read-only-history.client.spec.ts) 通过生产 Gateway 装配验证显式目标、共享 generation 降级、修改拒绝与最后释放。[Chat 注入测试](../../../../packages/client/ui-chat/tests/apply-inject.client.spec.tsx) 验证不改变导航的仅视图 Turn 请求。这些是互补的所有权测试，不是模型提供商参与的产品验收。

装配 fixture 在第一个普通 Session 的输入目录物化时，会报告既有的渲染期发布警告。这些测试保留该诊断，不声称修复了目录发布路径。根级浏览器回放与真实产品验证仍独立于这些无密钥组件及传输测试。
