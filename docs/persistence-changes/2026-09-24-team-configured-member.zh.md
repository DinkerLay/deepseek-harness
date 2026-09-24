---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-team-configured-member

[English](2026-09-24-team-configured-member.md) | 中文

## 概述

记录显式配置的 Team 成员、绑定的 Preset 声明修订值及生命周期阶段。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-team-configured-member
baseline: false
changes:
  - root: "event:team/member/configured"
    previous: null
    after: "0aad63be083774f083a1f394dc0c64eb49129a92ca30500e843fb5848f5ff666"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有的 team/member 第 2 版记录仍有效，且保持原有结构。只有显式选择 Preset 或记录扩展生命周期阶段时，Team 创建过程才写入 team/member/configured 第 3 版。Team 投影能回放两种事件，不改变 V4 Session 头。不了解这个必需事件的旧读取器可能拒绝包含它的 Team 日志。

<a id="verification"></a>
## 验证

原生 Team 服务、Team 工具与 Team 客户端 UI 的定向 Vitest 测试共 7 个文件、144 项通过。测试覆盖第 2 版事件回放、第 3 版 Preset 绑定、冷恢复、声明变更后拒绝恢复，以及工具参数转发。Host 与 Client 的 TypeScript 项目检查通过。

<a id="dev-note"></a>
## 开发备注

无。
