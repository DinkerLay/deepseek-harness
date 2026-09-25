---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-26-controlled-team-mode

English | [中文](2026-09-26-controlled-team-mode.zh.md)

## Summary

Adds an optional teammate group, a first Team event that fixes controlled collaboration policy, and an irreversible marker for completed Task results that cannot satisfy downstream prerequisites.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing Team member and Task records omit the new optional fields and replay unchanged. Official Team sessions never write the new mode event. Controlled product sessions write it before any other Team event; the event is a same-version addition, so older runtimes do not claim to resume those new sessions. Once set, the result-unavailable marker cannot be removed by a later Task revision.

<a id="verification"></a>
## Verification

The Agent Team, Team tool, and Preset registry suites passed 187 tests across 12 files. Projection tests reject marker removal, and controlled-mode tests reject member-to-member messages and unmarked product writes. The Session type and persistence gates are run with this acknowledgement.

<a id="dev-note"></a>
## Dev Note

None.
