---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-05-task-dispatch-control

English | [中文](2026-10-05-task-dispatch-control.zh.md)

## Summary

Adds optional dispatchBlocked: true to native Team Task snapshots, including the snapshots carried by Task and Lead transactions.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

This is an optional V4 event-body addition; no existing Task status, Attempt status, command enum, event version or header changes. Historical snapshots without the field retain the previous readiness calculation. The current writer includes the flag only when its registered Task owner blocks dispatch, and the current projection treats it as not ready. The product's detailed control records remain in its extension payload. Older strict consumers may reject the new property, while readers preserving unknown optional data can retain the historical Task facts; replaying the old facts does not grant permission to run the new control protocol. Product Task writes and input admission require the current registered owner and confirmed journal state. This acknowledgement adds no old-product migration or downgrade guarantee and preserves all accepted predecessor records.

<a id="verification"></a>
## Verification

The reported structural review contains exactly three optional-property-added changes, all same-version, at team/task, team/task/transaction and team/lead/transaction Task snapshot roots. Native Task-control and Subagent tests passed together (455 tests); the public outer Task package passed 234 tests, including control ownership, stale/final-graph validation and delivery admission. The final documentation, recorded-model, coverage and real-Web checks are recorded separately in the WP13 evidence before committing.

<a id="dev-note"></a>
## Dev Note

None.
