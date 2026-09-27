---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-team-member-tool-limit

[English](2026-09-27-team-member-tool-limit.md) | 中文

## 概述

在受控模式事件中增加可选的 Team 成员工具上限，包含允许和禁止清单，不改变官方 Team 默认行为。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-team-member-tool-limit
baseline: false
changes:
  - root: "event:team/mode"
    previous: "2026-09-26-controlled-message-cap"
    after: "13c2093d78a82a5a34827fb879328abaaf068464e2e2780117a89ad63b21194f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有模式事件没有 memberToolLimit，成员工具目录和直接调用规则保持原样。新的受控 Team 可在工具开放前把允许和／或禁止清单写进 Lead Session，重启后从同一记录恢复。新增字段是可选的，旧记录仍有效，因此事件版本保持为一。

<a id="verification"></a>
## 验证

Agent Team 与 Team 工具定向测试共通过 118 项，覆盖原生组合不变、继承工具交集、同作用域 Team 工具隐藏与直接调用拒绝。产品 Task 测试通过 33 项，包括产品 Team 工具隐藏。

<a id="dev-note"></a>
## 开发备注

无。
