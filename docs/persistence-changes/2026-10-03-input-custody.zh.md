---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-03-input-custody

[English](2026-10-03-input-custody.md) | 中文

## 概述

新增可选的提供方输入控制器绑定、暂存接管与释放事实，以及 inbox 的唤醒意图、中断时队列重分类和暂存移出的可选审计字段。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-input-custody
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-30-controlled-message-approval-route"
    after: "5feaf7fefe67167bd1c47614fb6f63a828f81081bd82384ece83759ce09ddced"
    decision: same-version
  - root: "event:agent/input/controller-bound"
    previous: null
    after: "63822f0ed36e10e64973ac8af1a67ad7db4fcbdae3486d0ec400e453244611ed"
    decision: same-version
  - root: "event:agent/input/held"
    previous: null
    after: "495e083bf50f9ca10c78da6c290f92052d03ebc851f4a24df73fdd074fffe9ae"
    decision: same-version
  - root: "event:agent/input/released"
    previous: null
    after: "f8135734a85b589bd26e4e9b20c2435a1ceaf6ee0daaaae495903f41fb9cbd40"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

只新增事件根和 inbox 可选字段，不改变既有字段类型或闭合枚举选项。未绑定会话保留同步驱动路径。缺少的唤醒意图仍然未知，接管时不能猜测。暂存移出不算领取或取消。既有事件与 Session 格式 4 保持不变，不实现旧产品数据迁移。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/agent-loop/tests/input-control.spec.ts packages/core/agent/tests/input-control-projection.spec.ts packages/core/agent/tests/consumed-work.spec.ts packages/api/session-controller/tests/commands-queue-attachment.host.spec.ts：76 项通过。后续入口补接之前的相关回归为 87 文件、2202 项通过。覆盖率和完整 Handoff 验收仍待完成。

<a id="dev-note"></a>
## 开发备注

无。
