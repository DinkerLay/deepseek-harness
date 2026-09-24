---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-22-host-owned-delegation

[English](2026-09-22-host-owned-delegation.md) | 中文

## 概述

记录 Host 持有的委派执行身份、捕获的 Preset 声明版本与永久退役。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-22-host-owned-delegation
baseline: false
changes:
  - root: "event:subagent/host-owned"
    previous: null
    after: "1f5d5a6d2db94a159e6d1bafe3f265601853a223d05996693ee6c33fd4333886"
    decision: same-version
  - root: "event:subagent/host-retired"
    previous: null
    after: "0bf0aa8b33b45cd153d76a9730d91b53f10370201b787e74fb145413616ddd31"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新增两个必需 Session 事件，不改变已有载荷或 MessageSource 联合类型。已有日志继续可读。旧构建因不认识必需的所有权事件而拒绝新的 Host-owned 日志，不得将这些执行当普通子级恢复。Session 写入格式仍为 4。

<a id="verification"></a>
## 验证

消费该接口的 AgentHandoff 工作区通过真实 Loader、Agent loop、JSONL 持久化与控制日志测试，覆盖旧 Lead 销毁、无 Lead 冷恢复、所有者不匹配、消息去重与等待退役。定向 Agent loop 与 Preset 租约套件共 15 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
