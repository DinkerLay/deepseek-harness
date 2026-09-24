---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-team-task-extension-transaction

[English](2026-09-24-team-task-extension-transaction.md) | 中文

## 概述

在 Lead Session 的单个事件中记录一批原生 Team Task 更新及外层扩展数据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-team-task-extension-transaction
baseline: false
changes:
  - root: "event:team/task/transaction"
    previous: null
    after: "78b661dae712c5a32ccef3b4dcc88883a1de46d6f592a1d63445c8649ddcdea6"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有的 team/task 第 2 版事件仍有效；没有安装 Task 扩展时，原生写入方继续使用它。新的 team/task/transaction 事件包含完整 Task 快照、各自预期的上一修订值，以及一条由扩展所有的、不透明的 JSON 字符串。原生投影只折叠 Task 快照并校验最终 DAG；安装的扩展可从同一事件派生自己的验收投影。V4 Session 头不变。不了解这个必需事件的读取器可能拒绝包含它的日志。

<a id="verification"></a>
## 验证

原生 Team 身份与投影的 2 个文件、87 项定向 Vitest 测试通过。测试覆盖默认原生写入、扩展路由、双 Task 原子提交、过期修订拒绝、最终图校验、回放、非法扩展数据拒绝和扩展卸载。Host 与 Client 的 TypeScript 项目检查通过。

<a id="dev-note"></a>
## 开发备注

无。
