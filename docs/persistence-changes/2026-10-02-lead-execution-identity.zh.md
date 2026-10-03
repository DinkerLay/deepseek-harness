---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-02-lead-execution-identity

[English](2026-10-02-lead-execution-identity.md) | 中文

## 概述

为普通、无种子的执行新增第一版 team/lead/execution 身份事件；Session 格式 4 保持不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-02-lead-execution-identity
baseline: false
changes:
  - root: "event:team/lead/execution"
    previous: null
    after: "54241acd2b3a944145e378c351ea5f68cdc8fbfc2e3ba80e844734f4a2bc0e9a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有事件定义不变，已有会话不需要身份事件。此事件记录锚点、任期和不可变的 Preset 绑定，其存在不授予 Lead 权限。仅限 Host 的投影排除继承记录，拒绝格式错误、重复或过晚的身份。较旧的 harness 会拒绝未知事件，不会将该执行解释成隐式 Team。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/agent-team/tests：160 项通过。身份投影的 21 项测试达到语句、分支、函数和行 100%；四个 Agent Loop 与 JSONL 集成用例核对官方与受控组合公开前的身份记录、持久恢复、普通 fork 隔离和 Team reload。这些证据不表示输入准入已实现，也不表示 Handoff 已完成。

<a id="dev-note"></a>
## 开发备注

无。
