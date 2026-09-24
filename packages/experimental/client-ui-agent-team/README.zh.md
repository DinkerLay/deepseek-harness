---
description: "使用并排查实验性 Web Agent Teams roster、共享任务板与 teammate 导航面板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

[English](README.md) | 中文

## 概述

本包向 Web 会话页头添加 Agent Teams action，让用户检查当前 roster、查看共享任务板并导航到 teammate 会话。它通过生成的 `ctx.remote.agentTeams` contribution 读取权威 Team 状态，并让普通 child history 导航继续使用稳定的 addressed-subagent 路径。通过公开发布的实验性 Agent Teams bundle 选择本包。这个浏览器 projection 不扩展稳定 API Proxy、不存储 Team 状态，也不注册面向模型的输入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.zh.md) 启用本包。这个组合包同时提供团队服务、工具与 Web 界面。Web Client loader 挂载 `/client` export；root Host export 不执行行为，本包也没有用户配置字段。

### 检查并导航 roster

打开 panel 会调用 `agentTeams/view`。Roster row 展示持久 name、轮次可用状态、model 与 diagnostics。provisioning 和 running 成员使用共享 ongoing loading，inactive 与 retired 成员使用 idle 灰点，retiring 成员使用 warning，failed 成员使用 error 红点。选择 active 或 inactive teammate 时，系统直接根据其 Lead 与 roster 身份打开普通的 `{ parentSessionId, childSessionId, mode: 'continuable' }` address，不刷新或检查 parent catalog；retiring 与 retired 行仍可见，但不能从 Team 面板打开。Host 在打开历史时校验 parent、child 与 mode。History 与后续人类提示词继续使用稳定 addressed-subagent 会话路径；本包不会添加 Team 专用 address 字段。

### 查看任务板

可开始的 pending 任务使用 idle 灰点，被依赖阻塞的 pending 任务使用 warning 橙点，in-progress 任务使用 ongoing loading，completed 任务使用 done 绿点。

只读任务板将成员表与紧凑任务列表并排展示。列表行显示任务标识、负责人、状态与前置依赖，不展开任务要求。选择任务后可查看完整记录，包括按 GFM 渲染的 Task 描述、各 Attempt 单独提交的结果与产物引用、验收有效性、提示性写入范围和重叠警告。原始 HTML 和不安全链接不会执行。现有面板会标出等待 Lead 验收、结果过期与新建重做任务；它不把 teammate Session 当成 Task。历史第二版 Task 仍只显示原始描述。详情操作可在成员可用时打开其会话，但不会定位到某项任务对应的对话轮次。Team agent 仍通过工具创建和更新任务；面板不提供任务修改控件。

任务标题旁提供两个可选的 session 级 child slot：`agent-team.panel.tasks.action` 用于切换视图，`agent-team.panel.tasks.graph` 用于渲染一个只读替代视图。两者都接收当前原生 `TeamView` 投影；action 还接收 `openGraph` 与 `active`，graph 接收用于明确打开成员会话的 `openMemberSession`。没有图扩展时，任务列表仍是默认 Task 视图。扩展必须从原生 `blockedBy` 推导连线，不得维护第二套 Team 状态。

Lead 的“消息”视图分页显示同伴消息原文、发送者、接收者、投递状态和可选 Task 关联，不在 Lead 对话中插入转发消息。非文本块仍可按持久化 JSON 查看。Teammate Session 不显示此视图，Host 也拒绝非 Lead 读取。新的入队或投递记录提交后，Lead Session 活动信号会刷新打开的视图。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client export 挂载来自 [`@deepseek-ai/dsh-experimental-agent-team/remote`](../agent-team/README.zh.md) 的生成的 `ctx.remote.agentTeams` contribution，然后通过 Cordis effect 注册 locale dictionary 与一个 conversation-header slot。Dispose plugin fiber 会移除这两项 registration。

面板渲染在会话容器外，并保持在视口范围内。打开时焦点移入面板；按 Escape 或选择关闭按钮时，焦点返回触发按钮。点击外部或将焦点移出面板与触发按钮时，面板关闭，但不会将焦点移回。打开或刷新面板会读取完整 Team view。Lead Session 打开期间，其 `agentTeamActivity` 投影会在成员或任务变更提交后触发静默重读，让可选图视图跟随 Board。并行刷新只保留最新响应，属于上一个会话的响应会被忽略。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 生成的 Remote、locale、导航与 slot registration |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Roster、任务板与可选视图切换的交互状态 |
| [`src/client/task-view-slots.ts`](src/client/task-view-slots.ts) | 可选 Task 投影的类型化 child slot |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文 panel 文案 |
| [`src/index.ts`](src/index.ts) | 不执行行为的 Host entry |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Agent Teams bundle](../agent-team-profile/README.zh.md)——挂载本 Client plugin 的公开 opt-in bundle。
- [Agent Teams service](../agent-team/README.zh.md)——权威 roster、task 与 Remote 行为。
- [会话 UI](../../client/ui-conversation/README.zh.md)——稳定 header slot 与 addressed-subagent 导航表层。
- [实验性包](../README.zh.md)——孵化状态与发布规则。

-----

<a id="model-experience"></a>
## 模型体验

无直接影响，因为该浏览器 projection 不注册面向模型的输入。

#### KV Cache 影响

无直接影响；Team 工具与普通会话提交负责后续任何模型可见用途。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Lead 范围的活动信号**——自动成员、任务与邮箱刷新跟随已打开 Lead Session 的投影；在 Teammate 自身 Session 中仍需手动刷新才能看见其他成员作出的变更。私聊历史仅在 Lead 视图中可用。
- **普通 child continuation**——导航后发送的人类消息使用稳定 addressed-subagent 提示词路径，而不是 Team peer mailbox。
- **没有任务专属会话位置**——任务 owner 只标识成员 Session，不标识执行某项任务的 Turn 或 Step；详情操作打开成员会话，不声称精确定位到该任务。
- **没有 lifecycle 或 workspace control**——panel 不能 spawn、rename、delete 或 interrupt teammate，write scope 仍只是提示性 metadata。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。RPC 是权威来源；本包持有一个可释放的页头注册及其任务视图 child 声明。
