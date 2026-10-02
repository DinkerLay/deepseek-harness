---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-controlled-message-approval-route

[English](2026-09-30-controlled-message-approval-route.md) | 中文

## 概述

为 Team 消息及送达来源新增可选的逐块作者标记，并新增由 Host 绑定的审批应答路由事件。已有审批策略取值和已发布的成员状态字段不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-controlled-message-approval-route
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "9f5dfa3c6203608ec3bc997b980a376cc70b257827441bacce0e3b5031dcefea"
    decision: same-version
  - root: "event:approval/answerer-route"
    previous: null
    after: "e2132c2019606bae31b5b8a81527c37060b113d0176777d4bb028ed996a07247"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "aac3cc5a61549f2079eeec662eb6321f29f97497f0f33c655e6377cad93ab533"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "356c9f41eaa4755c9f450fad5721e0fe5f7a78a17b86449d366dbd10096abd2d"
    decision: same-version
  - root: "event:team/extension"
    previous: "2026-09-27-team-composition-profile"
    after: "d104eef4c1e1f60d627d76e42f89b90065fe7a2615b7499623148832784b071a"
    decision: same-version
  - root: "event:team/message/queued"
    previous: "2026-09-16-session-format-v4"
    after: "10ed5eed4ad42ee9fcf0f5db8d5bafe83b91722d9def172440828d6a1e73a391"
    decision: same-version
  - root: "event:team/task/transaction"
    previous: "2026-09-26-controlled-team-mode"
    after: "77fcdef5ff7e52848e901c043a5632ac1edb572a6e124a1f5c6c14b02dfa1658"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "0b17dc916666f156326d62a2242c5455742d4935833e54065e68bde2fbe89ee8"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有消息可以没有作者标记，缺失不增加输入的指令权限；官方 Team 消息不写新字段。没有路由的会话使用原审批策略。产品注册的路由保留原会话的审批审计，每次请求时解析当前应答方；普通委派会话仍为 never。新事件出现时必须被读者识别，不支持它的构建拒绝该日志，不削弱策略。

<a id="verification"></a>
## 验证

集成 fork 运行通过 1143 项；唯一失败是目录 fixture 漏列已有 Team 工具，修正后的定向运行通过 10/10。外层类型检查和全部 81 项测试通过。录制会话重放 176 项通过、2 项跳过。完整文档校验和真实 Web 验收仍待完成。

<a id="dev-note"></a>
## 开发备注

无。
