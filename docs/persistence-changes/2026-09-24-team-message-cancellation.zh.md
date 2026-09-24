---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-team-message-cancellation

[English](2026-09-24-team-message-cancellation.md) | 中文

## 概述

记录 Lead 授权取消在 teammate 退队前无法投递的排队 Team 消息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-team-message-cancellation
baseline: false
changes:
  - root: "event:team/message/cancelled"
    previous: null
    after: "7e9638f6cd7c05e5251ad9379fe114fb7d62524031a332b7ea47f23fef25680c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新的 team/message/cancelled 事件保存目标成员、剩余未投递消息的 id 和取消原因。已有的 queued 与 delivered 事件保留发布过的第 2 版形式。Team 投影在同一 V4 Session 格式下既可回放没有取消记录的旧日志，也可回放包含取消记录的新日志。不了解这个必需事件的旧读取器可能拒绝包含取消记录的日志。

<a id="verification"></a>
## 验证

原生 Team 服务、工具及客户端的 7 个文件、154 项定向测试通过。测试覆盖取消事件回放、重复取消和取消已送达消息的拒绝、Preset 变更后拒绝恢复、取消消息及退队。Host 与 Client 的 TypeScript 项目检查通过。

<a id="dev-note"></a>
## 开发备注

无。
