---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-05-task-dispatch-control

[English](2026-10-05-task-dispatch-control.md) | 中文

## 概述

给原生Team Task快照新增可选dispatchBlocked: true，包括Task与Lead事务携带的快照。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-task-dispatch-control
baseline: false
changes:
  - root: "event:team/lead/transaction"
    previous: "2026-10-03-native-lead-coordination"
    after: "045c9e3042c2080ebe9d892114cb5ca93ebd6ff4031aa3035c04f04231985688"
    decision: same-version
  - root: "event:team/task"
    previous: "2026-09-26-controlled-team-mode"
    after: "2eebe4a07b6cd078b3f0813c9c22945371b18f890e9ffa9f53379926919080da"
    decision: same-version
  - root: "event:team/task/transaction"
    previous: "2026-10-03-native-lead-mail"
    after: "c025bde4bd5e9363e155c12147aa565c521c2e6fcbdc3b70b7b21b8e00965b04"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这是V4事件体的可选新增，不改变已有Task状态、Attempt状态、命令枚举、事件版本或Session头。缺少该字段的历史快照保持原来的ready计算。当前写入方只在已注册Task拥有者阻止派发时写入该标记，当前投影据此判定不可开工；产品的详细控制记录仍在其扩展payload中。旧严格消费者可能拒绝新属性，保留未知可选数据的读取方可以保留历史Task事实，但回放旧事实不代表获准执行新的控制协议。产品Task写入和输入准入仍要求当前拥有者存在并已确认日志。本确认不增加旧产品迁移或降级保证，不改已接受的前驱记录。

<a id="verification"></a>
## 验证

结构核对只报告三处optional-property-added，分别是team/task、team/task/transaction、team/lead/transaction中的Task快照，均为同版本。原生Task控制与Subagent合跑455项通过；公开外层Task包234项通过，覆盖控制归属、陈旧/最终图校验和投递准入。最终文档、模型录制、覆盖率和真实Web门槛在提交前另记WP13证据。

<a id="dev-note"></a>
## 开发备注

无。
