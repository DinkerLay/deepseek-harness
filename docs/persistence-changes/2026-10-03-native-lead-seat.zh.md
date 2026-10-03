---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-03-native-lead-seat

[English](2026-10-03-native-lead-seat.md) | 中文

## 概述

新增第一版原生 Lead 席位事务，包含新执行绑定、不透明的 Task 写入方数据、Lead Task 释放快照及邮箱通知。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-native-lead-seat
baseline: false
changes:
  - root: "event:team/lead/transaction"
    previous: null
    after: "9ceba5d411831606155013c14275b97bf0f90afa3b2836182903cec5f7f1a558"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这是新增的必读事件，不改变已有记录和字段。没有此事件的 Team 仍由锚点担任第一任 Lead；可选运行时提供方不改变官方装配。读取方校验连续任期，并原子折叠席位、释放快照和通知。Session 格式保持第四版。

<a id="verification"></a>
## 验证

原生 Lead 身份与席位投影测试覆盖匹配、过期和复用执行，以及原子释放快照。准备中 Lead 运行时的 23 个选中用例通过，lead-runtime.ts 的语句、分支、函数和行均达到 100%。改用浏览器安全的类型导入后，Host 和 Client TypeScript 构建通过。这不表示产品交接协调器或真实模型验收已经完成。

<a id="dev-note"></a>
## 开发备注

无。
