---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-26-controlled-message-cap

[English](2026-09-26-controlled-message-cap.md) | 中文

## 概述

为受控 Team 的持久模式增加可选的普通消息字节上限。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-26-controlled-message-cap
baseline: false
changes:
  - root: "event:team/mode"
    previous: "2026-09-26-controlled-team-mode"
    after: "00b787c699b0d246df4d82b410d8b8c6ae616193420546e14792f3f543097a77"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

旧模式记录没有该字段，仍只受部署级消息上限约束。新受控 Team 可以固定较低的普通消息上限。带严格模式校验的旧运行时可能拒绝含此字段的新记录；不支持将运行中的受控 Team 降级。

<a id="verification"></a>
## 验证

Agent Team 的受控消息测试通过：超长普通消息被拒绝，同一模式下的 Task 通知正常送达。

<a id="dev-note"></a>
## 开发备注

无。
