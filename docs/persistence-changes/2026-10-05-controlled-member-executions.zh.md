---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-05-controlled-member-executions

[English](2026-10-05-controlled-member-executions.md) | 中文

## 概述

新增原生受控成员执行代次、成员局部操作保管、候选重试和按代次记录的mailbox收据；新增不带授权的有界接续参考来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-controlled-member-executions
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-03-native-lead-mail"
    after: "735e19d0ebd26090ca5212baf0c31b6ed4319a64d25a3b024936ffb8f225e763"
    decision: same-version
  - root: "event:agent/input/held"
    previous: "2026-10-03-native-lead-mail"
    after: "4d1b45935483e5a15f7eb7b7eb372af00ecae671fff1fd68eaab0b9614bcb414"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-03-native-lead-mail"
    after: "25dd0ebc82d881cdf24b55b934257f39073aa91c752107773446489c079d0307"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-03-native-lead-mail"
    after: "420c4ebe8f4f60af35fa2ad7811a68a071c275f0559f71a6ea03f50d2164473d"
    decision: same-version
  - root: "event:team/member/candidate"
    previous: null
    after: "eb508816e81c2ad05b9e59fda8b927472425a6c5f896a704ae409d6ca54ff1f8"
    decision: same-version
  - root: "event:team/member/control"
    previous: null
    after: "743292313a5e1a7b39c37f10dd07867d2a6d679a9860342335062c94863dd275"
    decision: same-version
  - root: "event:team/member/execution"
    previous: null
    after: "6c6d4695e07a38d9523990961beecd3353ea36c161e477c96bd9c4ec5f48c890"
    decision: same-version
  - root: "event:team/message/input-queued"
    previous: "2026-10-03-native-lead-mail"
    after: "f1f084c884910b5fd2df7367916cdfac90e457ac9cc295b6c8d8f651859f0990"
    decision: same-version
  - root: "event:team/message/member-delivered"
    previous: null
    after: "8847ee7027d30d8e63e48cbcb03fcc3795f7628327a54a2d98ccc43f746f83e6"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-03-native-lead-mail"
    after: "06dcc22e1defd04b53b15a35b2d70ca9a4b4a71dd149d4bb7cc37aa6b59bce1b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有事件载荷和Session头保持不变。四个新原生Team事件记录执行与控制效果，不重解释最初成员身份或旧投递收据；不认识这些事件的旧读取器可以拒绝，而不猜测新绑定。符合attribution条件的team-member-material在未加载写入方时仍作为普通JSON来源元数据保留；它不授予权限，不改变通用回放要求，在既有Auto分类中保持事实资料。原生执行代次及准入由明确的Team/control记录决定，不依赖解释参考来源。因此保留已接受的Session格式。

<a id="verification"></a>
## 验证

原生执行、槽位和运行时定向107项测试通过，覆盖代次身份、历史作者不变、无模型候选准备、冷保管、写盘false/异常、维护占用以及未安装写入方的JSONL来源保留。原生Host和Client类型构建通过。本包完整覆盖率和最终Web验收另行跟踪，本记录不声称已通过。

<a id="dev-note"></a>
## 开发备注

无。
