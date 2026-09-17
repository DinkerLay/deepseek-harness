# Agent Note: inbox 准备期间保留 transcript 回显

Status: implemented

[English](2026-09-17-transcript-echo-inbox-handoff.md) | 中文

## Problem

空闲时提交的 prompt 先经过 Host inbox，再由准备过程产生持久用户消息。如果把这个临时队列项当成 transcript 替代项，本地气泡就会在没有用户节点可渲染时被移除。首轮工作区准备会使间隙明显可见。这细化了[通用附件决策](../feature/2026-08-26-generic-file-upload.zh.md)保留的提交生命周期。

## Decision

Session 保留 `transcript` 提交，直到观察到匹配的持久 `user/message`、发生带标识的失败，或 Session 被销毁。观察队列只可使 queued 或 steering 提交退休。Chat 仅使用持久 user／steering 节点对 transcript 回显去重，不使用 inbox 项。steering 回显仍与其可见的待处理 steering 气泡去重。

现有延迟一帧退休与 `rpcId` 关联仍具有最终约束力。不增加超时、wire 字段、Session 事件、模型输入或历史改写。附件退休遵循同一个持久交接点，使图片预览在准备期间保持可用。

## Alternatives considered

**固定延迟后移除气泡。** 准备耗时不固定，超时仍可能留下空隙或重复已完成消息。

**只保留 Session 内存，而 Chat 继续隐藏 inbox 匹配项。** 气泡在准入期间仍会消失。生命周期和展示必须识别同一个替代对象。

**全部回显都等到持久用户消息后退休。** queued 和 steering 提交已有可见的 Host 待处理界面，必须保留现有交接行为。

## Consequences

空闲提交的气泡在轮次准备期间保持可见。原有 Session 和 Chat 组件回归用例覆盖准入、inbox 消费、延迟的持久投递、最终只有一个气泡，以及恰好一次结算。同组测试继续覆盖运行中的 queue 和 steering 行为。变更影响临时展示，持久 Session 输出保持不变。
