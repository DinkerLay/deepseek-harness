---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-team-extension-record

[English](2026-09-27-team-extension-record.md) | 中文

## 概述

记录扩展拥有的 Team 事实及可选邮箱通知，不虚构 Task 更新。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-team-extension-record
baseline: false
changes:
  - root: "event:team/extension"
    previous: null
    after: "3728c6204af7e7dd3dd0d016ca34ac0249a239221b8b3cd0017d58a3b4c71d61"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

官方 Team 不写入此事件。已安装的扩展可以在 Lead Session 的单个事件中写入带写入方作用域的记录 ID、不透明 JSON 和可选的 Team 通知。重放时建立记录身份索引以拒绝重复，并将通知折叠进原生邮箱；不会创建或更改 Task。旧 Team 日志保持可读。不认识这个必需事件的旧读取器可能拒绝新日志。

<a id="verification"></a>
## 验证

原生 Team 定向测试覆盖原子追加、不更改 Task、同事件通知、并发去重及重复拒绝。Host 和 Client 的 TypeScript 检查通过。

<a id="dev-note"></a>
## 开发备注

无。
