---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-05-controlled-member-executions

English | [中文](2026-10-05-controlled-member-executions.zh.md)

## Summary

Adds native controlled-member execution generations, member-local operation custody, candidate retargeting and generation-specific mailbox receipts. Adds a non-authorizing reference source for bounded continuation material.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing event payloads and the Session header remain unchanged. The four new ordinary Team events carry execution/control effects without reinterpreting the original member identity or old delivery receipts; an older reader that does not know those events may reject them instead of inferring a new binding. The qualified team-member-material attribution is retained as ordinary JSON source metadata when its producer is absent. It grants no authorization, changes no generic replay requirement and remains factual material under the existing Auto classification. Native generation and admission depend on their explicit Team/control records, not on interpreting the reference source. These changes therefore retain the accepted Session format.

<a id="verification"></a>
## Verification

Focused native execution, slot and runtime suites passed 107 tests. They exercise generation identity, immutable authors, no-model candidate preparation, cold custody, false/throw checkpoint handling, maintenance occupation and producer-free JSONL retention of the reference source. Native Host and Client type builds passed. Full package coverage and final Web acceptance are tracked separately and are not claimed by this record.

<a id="dev-note"></a>
## Dev Note

None.
