---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-team-message-cancellation

English | [中文](2026-09-24-team-message-cancellation.zh.md)

## Summary

Record Lead-authorized cancellation of queued Team messages that cannot be delivered before teammate retirement.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-team-message-cancellation
baseline: false
changes:
  - root: "event:team/message/cancelled"
    previous: null
    after: "7e9638f6cd7c05e5251ad9379fe114fb7d62524031a332b7ea47f23fef25680c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The new team/message/cancelled event stores one target, its remaining undelivered message ids, and a reason. Existing queued and delivered events retain their released version-two form. The Team projection replays old logs without cancellation and new logs with it under the same V4 Session format. Older readers unaware of the new required event may reject a log containing a cancellation.

<a id="verification"></a>
## Verification

Focused native Team service, tool, and client tests passed 154 cases across 7 files. They cover cancellation replay, duplicate and delivered-message rejection, changed-Preset recovery refusal, cancellation, and retirement. Host and Client TypeScript project checks passed.

<a id="dev-note"></a>
## Dev Note

None.
