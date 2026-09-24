---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-23-team-preset-retirement

English | [中文](2026-09-23-team-preset-retirement.zh.md)

## Summary

Adds durable explicit Preset binding for continuable children, configured Team membership, Task-linked peer messages, and atomic managed Task attempts, results, acceptance, and rework invalidation.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-team-preset-retirement
baseline: false
changes:
  - root: "event:subagent/continuable-preset"
    previous: null
    after: "20d13228022fd1275ca30056c9b3726bef9a8c052f2971fe63a76671f4cba246"
    decision: same-version
  - root: "event:team/member/configured"
    previous: null
    after: "0aad63be083774f083a1f394dc0c64eb49129a92ca30500e843fb5848f5ff666"
    decision: same-version
  - root: "event:team/message/queued-task"
    previous: null
    after: "79fc87c57c40611e4905d9620cc195b90c6cf6a814863d5d045b9a29d74c38b2"
    decision: same-version
  - root: "event:team/task/managed"
    previous: null
    after: "3cec05fdb02396d846fe09461f08da316f4f8995371acc04600c2053e8561702"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing version-two Team member, Task, and unlinked message events retain their original readers; children without explicit Presets retain inherited composition. New events are required for correct Preset recovery, retired-member admission, Task linkage, and managed Task acceptance, so older readers reject those Sessions as unknown rather than silently reconstructing a wrong Team. No existing payload type changes and no second Team state is introduced.

<a id="verification"></a>
## Verification

Focused native Team, continuable-Preset, Task-result, tool, UI, persistence, and projection tests passed; the persistence classifier reports additive same-version roots and no breaking change to accepted roots.

<a id="dev-note"></a>
## Dev Note

None.
