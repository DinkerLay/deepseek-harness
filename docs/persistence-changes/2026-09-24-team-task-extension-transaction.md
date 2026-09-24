---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-team-task-extension-transaction

English | [中文](2026-09-24-team-task-extension-transaction.zh.md)

## Summary

Record native Team Task updates, mailbox notices, and extension-owned data in one Lead Session event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-team-task-extension-transaction
baseline: false
changes:
  - root: "event:team/task/transaction"
    previous: null
    after: "0990b3ba41e06a452ae5c52336fdff12aab1b887c2f6e929362cfde38ee203bf"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing team/task version-two events remain valid and the default Team writer keeps emitting them without a Task extension. The team/task/transaction event carries complete Task snapshots, expected previous revisions, an opaque extension-owned JSON string, and optional mailbox notices. The native projection folds the Task snapshots and notices and validates the final DAG; an installed extension can derive its own review projection from the same event. The V4 Session header does not change. A reader unaware of this required event may reject a log that contains it.

<a id="verification"></a>
## Verification

Focused native Team identity and projection Vitest run passed 88 tests across 2 files. The tests exercise default native writes, extension routing, a two-Task atomic commit, same-event mailbox admission, stale revision rejection, final-graph validation, replay, malformed payload rejection, and extension disposal. Host and Client TypeScript project checks passed.

<a id="dev-note"></a>
## Dev Note

None.
