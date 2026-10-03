---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-03-native-lead-coordination

[English](2026-10-03-native-lead-coordination.md) | 中文

## 概述

为扩展记录新增可选的原生 Lead 过渡与协调操作事实，为 Lead 事务新增独立协调审计及初始化材料顺序，并新增一条仅写日志的中断审批拒绝事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-native-lead-coordination
baseline: false
changes:
  - root: "event:approval/interrupted-rejected"
    previous: null
    after: "a57d2d97b9a04472e1bf489a6aaf4796e76f8562ce0d2d1eb67ee71e0c48ecba"
    decision: same-version
  - root: "event:team/extension"
    previous: "2026-10-03-native-lead-mail"
    after: "6f0ee24b137470c294d0f3b19ddf8f47450793d5e4ddc0ad7b5e49ae3d0ed27b"
    decision: same-version
  - root: "event:team/lead/transaction"
    previous: "2026-10-03-native-lead-mail"
    after: "155b5354bec57e47bfef91341021268a6d14d0c61db6923006333b95e1fe5059"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有事件字段、版本和审批结果取值不变。新字段可省略；没有初始化顺序元数据的事务仍按原顺序排队。第一版新审批事件在读取时不可忽略，只在原轮次结束后结算原路由提问。绑定的 Task 写入方仍拥有事务中的 Task 审计，协调材料使用独立命名空间。Session 格式仍是第四版，不迁移、替换或重写已有会话及已接受的类型确认。

<a id="verification"></a>
## 验证

真实 Loader、Agent Loop、JSONL 和公开 Task 写入方接口的定向测试覆盖冻结准入、Profile 互斥、维护权限过期、完整效果重试、原子释放、两次 Lead 过渡和冷恢复不唤醒投递。无密钥的 headless 录制场景保留原工具拒绝及 blocked 回合，并拒绝无关失败或 Task 写入。审批测试覆盖唯一拒绝终态、迟到答复和中断原提问恢复。这些工程检查不表示真实模型产品 Handoff 已验收；最终命令与精确覆盖率另记在外层 H3 证据中。

<a id="dev-note"></a>
## 开发备注

无。
