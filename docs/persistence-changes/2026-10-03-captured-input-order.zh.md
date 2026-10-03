---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-03-captured-input-order

[English](2026-10-03-captured-input-order.md) | 中文

## 概述

为暂存输入增加可选 captured 标记，区分待处理队列顺序与之后到达的输入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-captured-input-order
baseline: false
changes:
  - root: "event:agent/input/held"
    previous: "2026-10-03-input-custody"
    after: "dbe949135ae111cf9ee0a0c0d1bf327482ae6b8e0e4a40277bf30606cff24659"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有暂存记录省略标记并保留到达顺序。新接管的待处理输入携带 captured true，投影在持久确认失败及重启后仍把接管队列排在后来暂存的输入之前。唯一可执行 Inbox 不变，标记不授予权限。这是可选字段新增，Session 格式保持第四版。

<a id="verification"></a>
## 验证

输入控制、Inbox、指令上下文及输入投影的定向回归 221 个用例通过。input-control.ts、input-control-projection.ts 和 inbox.ts 的语句、分支、函数及行均达到 100%。持久目录重启及失败 flush 的重试保持前插和替换输入先于后来暂存的输入。

<a id="dev-note"></a>
## 开发备注

无。
