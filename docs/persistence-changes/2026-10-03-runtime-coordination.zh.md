---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-03-runtime-coordination

[English](2026-10-03-runtime-coordination.md) | 中文

## 概述

记录原生 V4 执行目录绑定、标题策略与生成状态、精确标题输入截断，以及可选的父级交付位置。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-runtime-coordination
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "c88423d41455e57935ae51e4857cf3682f85cdd5887ea59d987419f384f95ce0"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "b97998b628079a8a7535bea10223b5ee49130298953899ff1e8c0a1d97bb51ca"
    decision: same-version
  - root: "event:session/execution-directory"
    previous: null
    after: "ae3b11d0f44715ba8cdaa1a23c8cf970a86986b70dd901c76bce6b4049dca04e"
    decision: same-version
  - root: "event:session/title"
    previous: "2026-09-11-initial"
    after: "e3266875dcdc30f2a848a770dab7e9dcf376f8571a58b452b36c329a698a2354"
    decision: same-version
  - root: "event:session/title-generation"
    previous: null
    after: "ba5b6bd42e37395fe5f5aee06a01c1c3d934258ee1ad72a8d7ae18f0982e5e69"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "7ea0c34f507656299c22fd742e17a757d130c06a6d73aff02640d49b60974476"
    decision: same-version
  - root: "event:session/title-policy"
    previous: null
    after: "af16d0311fd822ebf024070bd3413e4cb5de712224188e074b755dfa51a2ffba"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "37c01bfae9769b626b6da2111eed30778d394f3c63df21788ad086dc2c07ceed"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

分类器允许本次同版本转换：新增三个纯日志事件根，并为已有标题和 agent-message 字段增加可选信息。已有 V4 载荷在结构上仍有效。Session 执行目录、标题策略与标题生成记录需要对应的已声明事件实现；旧构建必须拒绝未知且不可忽略的事件。first-prompt 标题使用子会话自身后缀，all-prompts 提供方保持符合条件的继承输入。本确认不添加升级前 Session 导入，也不改动冻结的格式历史。

<a id="verification"></a>
## 验证

V4 执行状态、Session 标题 LLM 与 continuation message 针对性套件通过 3 个文件、24 个测试。冷 Controller 投影／搜索、all-prompts 标题、标题生命周期、projection cache 格式 fixture 与 Session Query 套件通过 16 个文件、242 个测试。持久化分类器报告九项同版本变更，无需增加 header version。

<a id="dev-note"></a>
## 开发备注

无。
