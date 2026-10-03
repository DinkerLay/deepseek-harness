---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-03-native-lead-mail

[English](2026-10-03-native-lead-mail.md) | 中文

## 概述

新增原生 Lead 输入排队与送达事件，并增加可选的发送者任期和逐内容作者事实。转交在同一 Team 邮箱中保留原输入身份；只有拥有者协调器可以把已捕获的交付责任排队。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-native-lead-mail
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-03-input-custody"
    after: "129af5ad99236dd33ab58cdc5f9d156575810d040f63bd38ddd85c473588473c"
    decision: same-version
  - root: "event:agent/input/held"
    previous: "2026-10-03-captured-input-order"
    after: "f67bea50146446449b16a7ad255357d712e87a8b76046f7e42383c3f14db3ad2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-30-controlled-message-approval-route"
    after: "dcf3f047f8c56c41a8a245b6362f47101427110136c02dc4748528c67a402a28"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-30-controlled-message-approval-route"
    after: "8cafe7cf12aa73c2673924eacffbf501ca9927a93b75251ad757f1939f6fb64b"
    decision: same-version
  - root: "event:team/extension"
    previous: "2026-09-30-controlled-message-approval-route"
    after: "a4a9a534ec4620e6d6cd46a524c98e232b657e0b2141e0fef48cae3601c75e2e"
    decision: same-version
  - root: "event:team/lead/transaction"
    previous: "2026-10-03-native-lead-seat"
    after: "1f03c60cefa9f7b7560d66871e2b63ebcf1b2eb534742747f20c41a3d472a8f8"
    decision: same-version
  - root: "event:team/message/input-queued"
    previous: null
    after: "236ebd7000e15685babe3927195ce0af103631781f8b2028dae3322433991aab"
    decision: same-version
  - root: "event:team/message/lead-delivered"
    previous: null
    after: "a69e7a47a041627811f4a5e7c23a489c1b223e2aefff6008d414e3ac6153da62"
    decision: same-version
  - root: "event:team/message/queued"
    previous: "2026-09-30-controlled-message-approval-route"
    after: "7577a1a8ce29fad12254a712042e789933471395913b255eba6fa0086621c8fa"
    decision: same-version
  - root: "event:team/task/transaction"
    previous: "2026-09-30-controlled-message-approval-route"
    after: "371d62eeb1f2ceb319345cd7ae669b529bf398b246b31c30430ca3751252fddf"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-30-controlled-message-approval-route"
    after: "09e545d2a5dbaf56050af7afa2e8bbf05a3e30a739b62dc49dbc2f5a54d0b7b4"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两个第一版新事件在读取时不可忽略。已有消息字段和版本不变，新增来源字段可省略。普通排队消息、Task 和扩展通知不能携带捕获的转交输入。官方非 Handoff 投递仍写原事件。Lead 送达只记录一次逻辑锚点与实际执行、任期，不再同时写旧送达事件。Session 格式仍是第四版，不迁移或重写已有数据。

<a id="verification"></a>
## 验证

真实 Loader、Agent Loop 和 JSONL 测试覆盖同一输入跨两次交接、取消或编辑后的新捕获、不唤醒预投递、离线来源清理、过期操作答复、作者来源及持久确认失败。Host 和 Client 类型检查通过。原生逐文件覆盖率与工作包验收另记在外层 H2 证据中；这些测试不表示产品协调流程或真实模型 Handoff 已验收。

<a id="dev-note"></a>
## 开发备注

无。
