---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-26-controlled-message-cap

English | [中文](2026-09-26-controlled-message-cap.zh.md)

## Summary

Adds an optional ordinary-message byte limit to a controlled Team's persisted mode.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-26-controlled-message-cap
baseline: false
changes:
  - root: "event:team/mode"
    previous: "2026-09-26-controlled-team-mode"
    after: "00b787c699b0d246df4d82b410d8b8c6ae616193420546e14792f3f543097a77"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Earlier mode records omit the field and continue to use only the deployment-wide message limit. New controlled Teams may pin a lower ordinary-message limit. An older runtime with strict mode validation may reject a new record carrying this field; downgrading an active controlled Team is not supported.

<a id="verification"></a>
## Verification

The Agent Team controlled-message tests passed with an oversized ordinary message rejected and a Task notice delivered under the same mode.

<a id="dev-note"></a>
## Dev Note

None.
