---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-team-composition-profile

[English](2026-09-27-team-composition-profile.md) | 中文

## 概述

持久记录由用户管理的 Team 组成转换、已配置成员的可选 Profile 槽位身份，以及权限表换绑扩展记录的可选组成变更标记。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-team-composition-profile
baseline: false
changes:
  - root: "event:team/composition"
    previous: null
    after: "96904f95f276e854cd7c497097245922f1f1e434a63a2281020580dbdedad822"
    decision: same-version
  - root: "event:team/extension"
    previous: "2026-09-27-team-extension-record"
    after: "df46177a437d5c73ed354fdd8f866d489f197e801abf74f84b76a1ef6cbb4058"
    decision: same-version
  - root: "event:team/member/configured"
    previous: "2026-09-26-controlled-team-mode"
    after: "981ea5b7f8722edd4e591e409003011119f6f718460ccbb98804185e9174d8c1"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有 Team 记录没有可选的槽位和组成变更字段，仍按原样回放。没有组成事件的 Team 保持动态状态。新增组成事件不改当前 Session 头格式；不认识这一必需事件的旧读取器会拒绝新日志，而不会猜测成员策略。原生投影从 Lead Session 事件重建锁定和应用状态。

<a id="verification"></a>
## 验证

Agent Team 的组成与投影定向 Vitest 文件通过 37 项；成员生命周期测试覆盖锁定准入、匹配的应用和 Preset 修订拒绝。外层 Task 管理通过 31 项测试，包括单事件权限换绑与回放。Web QA 团队应用七人 Profile 后保留了历史 Task。

<a id="dev-note"></a>
## 开发备注

无。
