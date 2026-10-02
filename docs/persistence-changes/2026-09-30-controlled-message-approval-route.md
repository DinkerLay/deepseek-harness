---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-controlled-message-approval-route

English | [中文](2026-09-30-controlled-message-approval-route.zh.md)

## Summary

Adds optional per-block author attribution to Team messages and their delivered sources, and a new Host-owned approval answerer route event. Existing approval policy values and released member state fields are unchanged.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-controlled-message-approval-route
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "54cbd7060d44933df08a9ffb0ae7ae60009763e4f76af8053ae5b1295a99e363"
    decision: same-version
  - root: "event:approval/answerer-route"
    previous: null
    after: "e2132c2019606bae31b5b8a81527c37060b113d0176777d4bb028ed996a07247"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "be04be000a1f8a8e469682713c2ea03f3d0e8b26a9bcfe8304060e7db810f60c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "edc3291037a93b162a16c9f702e3ea7fa49afdbc78beeb4e657d70f4de6c74de"
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
    previous: "2026-09-21-user-question-reply"
    after: "6eba80fd2ef925a22f87c05998929d6bf01e4a45d1d9b32ef87a13f0b222ead4"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing messages may omit attribution; absence does not grant added input authority. Official Team messages omit the new fields. Sessions without an answerer route use their original approval policy. Registered product routes retain the originating Session audit and resolve the current answerer at request time; ordinary delegated Sessions remain never. The new event is required to read when present, so builds without it reject that log rather than weakening policy.

<a id="verification"></a>
## Verification

The integrated fork run passed 1143 tests; the only failure was a catalog fixture missing existing Team tool names, and its corrected focused run passed 10/10. Outer type checks and all 81 tests passed. Recorded-session replay passed 176 cases with 2 skipped. Full documentation validation and real Web acceptance remain pending.

<a id="dev-note"></a>
## Dev Note

None.
