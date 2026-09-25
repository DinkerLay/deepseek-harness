---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-26-controlled-team-mode

[English](2026-09-26-controlled-team-mode.md) | 中文

## 概述

新增可选的成员分组、作为 Team 首个事件固定受控协作策略的记录，以及使已完成 Task 结果不能满足下游前置条件的不可撤销标记。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-26-controlled-team-mode
baseline: false
changes:
  - root: "event:team/member/configured"
    previous: "2026-09-24-team-configured-member"
    after: "fa9f4c7b2727b86530bca8973950bbd2ea70e2d22cf3d978733493d5e683a507"
    decision: same-version
  - root: "event:team/mode"
    previous: null
    after: "868cc02472798ed4dcb93a1bb45dc185b7aab795f33814edafcce3628c1b59b0"
    decision: same-version
  - root: "event:team/task"
    previous: "2026-09-11-initial"
    after: "3eb23097413d1b87d812c4134f5d1e6987a4b033d7c61ad70e2e3045419885c6"
    decision: same-version
  - root: "event:team/task/transaction"
    previous: "2026-09-24-team-task-extension-transaction"
    after: "e126c7c12171b0de5a89b2bfa7e258312ccc3f8cb04fb0030618550c74f23a50"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有成员和 Task 记录没有新增的可选字段，仍按原样回放。官方 Team 会话不写新的模式事件。受控产品会话在其他 Team 事件之前写入该事件；它属于同版本新增事件，旧运行时不声称可继续运行这些新会话。结果不可用标记一旦设置，后续 Task 修订不能将其移除。

<a id="verification"></a>
## 验证

Agent Team、Team 工具与 Preset registry 的 12 个测试文件共 187 项通过。投影测试验证不能撤销标记；受控模式测试验证成员间消息和未标记产品写入被拒。本确认记录还需通过 Session 类型及持久化文档检查。

<a id="dev-note"></a>
## 开发备注

无。
