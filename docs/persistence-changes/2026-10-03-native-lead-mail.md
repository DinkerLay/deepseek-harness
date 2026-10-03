---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-03-native-lead-mail

English | [中文](2026-10-03-native-lead-mail.zh.md)

## Summary

Adds native Lead input queue and delivery events, plus optional sender-term and per-content author facts. Transfers retain the original identified input in the existing Team mailbox; only its owning coordinator can queue captured custody.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-native-lead-mail
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-03-input-custody"
    after: "129af5ad99236dd33ab58cdc5f9d156575810d040f63bd38ddd85c473588473c"
    decision: same-version
  - root: "event:agent/input/held"
    previous: "2026-10-03-captured-input-order"
    after: "f67bea50146446449b16a7ad255357d712e87a8b76046f7e42383c3f14db3ad2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-30-controlled-message-approval-route"
    after: "dcf3f047f8c56c41a8a245b6362f47101427110136c02dc4748528c67a402a28"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-30-controlled-message-approval-route"
    after: "8cafe7cf12aa73c2673924eacffbf501ca9927a93b75251ad757f1939f6fb64b"
    decision: same-version
  - root: "event:team/extension"
    previous: "2026-09-30-controlled-message-approval-route"
    after: "a4a9a534ec4620e6d6cd46a524c98e232b657e0b2141e0fef48cae3601c75e2e"
    decision: same-version
  - root: "event:team/lead/transaction"
    previous: "2026-10-03-native-lead-seat"
    after: "1f03c60cefa9f7b7560d66871e2b63ebcf1b2eb534742747f20c41a3d472a8f8"
    decision: same-version
  - root: "event:team/message/input-queued"
    previous: null
    after: "236ebd7000e15685babe3927195ce0af103631781f8b2028dae3322433991aab"
    decision: same-version
  - root: "event:team/message/lead-delivered"
    previous: null
    after: "a69e7a47a041627811f4a5e7c23a489c1b223e2aefff6008d414e3ac6153da62"
    decision: same-version
  - root: "event:team/message/queued"
    previous: "2026-09-30-controlled-message-approval-route"
    after: "7577a1a8ce29fad12254a712042e789933471395913b255eba6fa0086621c8fa"
    decision: same-version
  - root: "event:team/task/transaction"
    previous: "2026-09-30-controlled-message-approval-route"
    after: "371d62eeb1f2ceb319345cd7ae669b529bf398b246b31c30430ca3751252fddf"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-30-controlled-message-approval-route"
    after: "09e545d2a5dbaf56050af7afa2e8bbf05a3e30a739b62dc49dbc2f5a54d0b7b4"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The two new version-one events are required on read. Existing message fields and versions are unchanged; the added sender-term and per-content author fields are optional. Ordinary queued messages and Task or extension notices cannot carry captured transfers. Official non-Handoff delivery keeps its original event. Lead delivery records the logical anchor and actual execution and term once, without also writing the old delivery event. Session format remains version four; no existing data is migrated or rewritten.

<a id="verification"></a>
## Verification

Real Loader, Agent Loop and JSONL tests exercise the same input across two seats, fresh capture after cancellation or editing, non-waking preload, offline source cleanup, stale operation replies, sender identity and content authors, and failed durability confirmation. TypeScript Host and Client checks pass. Native per-file coverage and package acceptance are recorded separately in the outer H2 evidence; these tests do not claim product coordination or real-model Handoff acceptance.

<a id="dev-note"></a>
## Dev Note

None.
