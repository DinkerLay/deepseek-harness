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
## Compatibility

Existing messages may omit attribution; absence does not grant added input authority. Official Team messages omit the new fields. Sessions without an answerer route use their original approval policy. Registered product routes retain the originating Session audit and resolve the current answerer at request time; ordinary delegated Sessions remain never. The new event is required to read when present, so builds without it reject that log rather than weakening policy.

<a id="verification"></a>
## Verification

The integrated fork run passed 1143 tests; the only failure was a catalog fixture missing existing Team tool names, and its corrected focused run passed 10/10. Outer type checks and all 81 tests passed. Recorded-session replay passed 176 cases with 2 skipped. Full documentation validation and real Web acceptance remain pending.

<a id="dev-note"></a>
## Dev Note

None.
