---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-team-task-extension-transaction

English | [中文](2026-09-24-team-task-extension-transaction.zh.md)

## Summary

Record a native Team Task batch and its extension-owned data in one Lead Session event.

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
    after: "78b661dae712c5a32ccef3b4dcc88883a1de46d6f592a1d63445c8649ddcdea6"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing team/task version-two events remain valid and the default Team writer keeps emitting them without a Task extension. The new team/task/transaction event carries complete Task snapshots, their expected previous revisions, and one opaque extension-owned JSON string. The native projection folds only the Task snapshots and validates the final DAG; an installed extension can derive its own review projection from the same event. The V4 Session header does not change. A reader unaware of this required event may reject a log that contains it.

<a id="verification"></a>
## Verification

Focused native Team identity and projection Vitest run passed 87 tests across 2 files. The tests exercise default native writes, extension routing, a two-Task atomic commit, stale revision rejection, final-graph validation, replay, malformed payload rejection, and extension disposal. Host and Client TypeScript project checks passed.

<a id="dev-note"></a>
## Dev Note

None.
