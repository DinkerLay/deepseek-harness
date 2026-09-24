---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-continuable-preset-binding

[English](2026-09-24-continuable-preset-binding.md) | 中文

## 概述

为可续子 Session 记录可选的显式 Preset 绑定。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-continuable-preset-binding
baseline: false
changes:
  - root: "event:subagent/continuable-preset"
    previous: null
    after: "20d13228022fd1275ca30056c9b3726bef9a8c052f2971fe63a76671f4cba246"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

只有显式绑定 Preset 的子级才会在首次模型请求前写入新的 subagent/continuable-preset 事件。已有子级日志没有该事件，仍继承父级组合。当前读取器无需改变 V4 Session header 即可读取两类历史；不认识这一必需事件的旧读取器可能拒绝新的显式绑定子级日志。

<a id="verification"></a>
## 验证

针对 Preset 组合租约、注册表修订、可续子级绑定与恢复以及 Typert 声明执行了定向 Vitest：5 个文件、239 项测试通过。Host 与 Client TypeScript 项目检查通过。

<a id="dev-note"></a>
## 开发备注

无。
