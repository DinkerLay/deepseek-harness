# Agent Note: Session 创建准备与消息投递归属

Status: implemented

[English](2026-09-07-session-provisioning-and-delivery-attribution.md) | 中文

## Problem

始终继承 cwd 的历史 fork 无法表达可独立写入的执行目录。驻留子任务会接收多个父 Turn 的输入，因此一次 activation 的身份无法标识每次派发。继承的标题锁定也会阻止分支根据自己的工作生成名称。

## Decision

Host fork API 接受精确且闭合的种子长度，以及可选的预留目标身份和 cwd。重复使用相同目标时会核对已有历史前缀、preset 与位置；冲突的身份或包含未结束 Turn 的前缀会被拒绝。原有 atSeq 行为仍然可用。DSH 不创建 Git 仓库，也不负责 Product 目录回收。

AgentRegistry 的创建拦截器在工厂创建 Session 前运行。受信任的部署插件负责目录分配、元数据和回滚；effect 释放会阻止新调用并等待已进入的创建完成。Sandbox policy 限制在显式模式覆盖之后执行，使文件和 Shell 消费方都能遵守执行目录上限，包括一次性获批调用。文件和 Shell 工具在审批前拒绝超出已登记上限的请求，并在执行前再次解析获批策略。

可继续对话的子任务输入在 source.delegation 中持久记录派发方父 Session 与开放 Turn，并保留精确的 inbox 消息 ID。同一次 activation 驻留期间，每条后续输入仍有自己的归属。父 Session 没有开放 Turn 时不填写 parentTurn。

Fork 标题提供方只接收种子之后的人类输入。首消息策略据此生成名称，继承标题保持临时可用。用户重命名只锁定实际发生重命名的 Session。显式 refresh 追加 title-policy 事件解除用户锁定；title-generation 事件记录生成中、成功和失败，不开启任务 Turn，也不丢弃最后可用的标题。

命名频率不决定消息选择或裁剪。标题辅助库遵循 Provider 选择器，并提供完整封装后的精确字节数；部署方 Provider 负责保留与节选策略。节选输入在辅助请求和已接受标题中携带 `inputTruncated`。父会话投递策略可在保留报告与结算内容的同时选择静默投递。没有策略时 DSH 保持默认调度；部署方负责用户停止及恢复规则。回调失败会静默保留并记录错误。

显式 Fork 目标根据目标目录解析 Workspace 绑定。源祖先关系独立保留，因为把原 Workspace 分配给另一个不可变 cwd 会违反其所有权契约。

## Alternatives considered

**在 Session 创建后修改 cwd。** 不可变 cwd 属于执行与持久化身份，必须在发布之前确定。

**用一个 activation ID 标识子任务的全部工作。** 后续输入可能属于另一个父 Turn；已接受的 inbox 消息身份才能精确关联。

**通过用户接口给所有分支改名。** 这会记录显式锁定并阻止自动命名。Product 别名保留在该接口之外。

**把每次用户停止硬编码为父会话暂停。** 一轮中断不等于所有部署的后续唤醒策略。范围受限的投递约束让 Product 决定暂停语义，原生调用方保留默认调度。

## Consequences

Product 可以分配隔离的执行资源，DSH 继续拥有组合、身份与历史权威。这些通用接口不包含 Git 或 Product 策略。创建调用方必须保留恢复意图，不能把 worktree 当成 sandbox。Sandbox 限制只覆盖执行解析后策略的消费方，不涵盖不受限制的外部操作方。

[父会话停止的继续执行回归](../../../../packages/subagent/subagent/tests/continuation.spec.ts) 安装显式投递策略并验证父会话不会再请求模型。profile 级快照验证独立于这些包回归。

[同路由标题回归](../../../../packages/session/session-title/tests/provider.spec.ts) 固定两个 Turn 共用同一请求头时的自动更新行为。标题服务核验带标记的主请求包含待处理用户消息，不假设 user/message 先于 step/start 写入。
