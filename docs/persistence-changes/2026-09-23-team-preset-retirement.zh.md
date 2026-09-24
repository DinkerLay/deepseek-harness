---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-23-team-preset-retirement

[English](2026-09-23-team-preset-retirement.md) | 中文

## 概述

为可持续子会话增加持久化的显式 Preset 绑定，并以独立事件记录 Team 成员配置、关联 Task 的同伴消息，以及原子化的 Task Attempt、结果、验收和重做失效。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-team-preset-retirement
baseline: false
changes:
  - root: "event:subagent/continuable-preset"
    previous: null
    after: "20d13228022fd1275ca30056c9b3726bef9a8c052f2971fe63a76671f4cba246"
    decision: same-version
  - root: "event:team/member/configured"
    previous: null
    after: "0aad63be083774f083a1f394dc0c64eb49129a92ca30500e843fb5848f5ff666"
    decision: same-version
  - root: "event:team/message/queued-task"
    previous: null
    after: "79fc87c57c40611e4905d9620cc195b90c6cf6a814863d5d045b9a29d74c38b2"
    decision: same-version
  - root: "event:team/task/managed"
    previous: null
    after: "3cec05fdb02396d846fe09461f08da316f4f8995371acc04600c2053e8561702"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有第二版 Team 成员、Task 和未关联 Task 的消息事件保留原读取路径；未显式指定 Preset 的子会话仍继承配置。新事件对 Preset 恢复、退队准入、Task 关联和受控 Task 验收是必需的，旧读取器会将其作为未知事件拒绝，不会默默重建错误的 Team。既有载荷类型均未更改，也没有引入第二套 Team 状态。

<a id="verification"></a>
## 验证

原生 Team、持续会话 Preset、Task 结果、工具、UI、持久化与投影的定向测试已通过；持久化分类器仅报告可在同一格式版本新增的事件根，既有已确认根没有破坏性变更。

<a id="dev-note"></a>
## 开发备注

无。
