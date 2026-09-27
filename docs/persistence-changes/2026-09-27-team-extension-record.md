---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-team-extension-record

English | [中文](2026-09-27-team-extension-record.zh.md)

## Summary

Record extension-owned Team facts and optional mailbox notices without inventing a Task update.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-team-extension-record
baseline: false
changes:
  - root: "event:team/extension"
    previous: null
    after: "3728c6204af7e7dd3dd0d016ca34ac0249a239221b8b3cd0017d58a3b4c71d61"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Official Teams do not emit this event. An installed extension may append a writer-scoped record id, opaque JSON, and optional Team notices in one Lead Session event. Replay indexes record identities for duplicate rejection and folds notices into the native mailbox; no Task is created or changed. Earlier Team logs remain readable. Older readers that do not recognize this required event may reject newer logs.

<a id="verification"></a>
## Verification

The focused native Team tests cover atomic append, no Task mutation, same-event notices, concurrent idempotency, and duplicate rejection. Host and Client TypeScript checks passed.

<a id="dev-note"></a>
## Dev Note

None.
