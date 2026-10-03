---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-03-captured-input-order

English | [中文](2026-10-03-captured-input-order.zh.md)

## Summary

Adds an optional captured marker to held input so pending-queue order remains distinct from later arrivals.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-captured-input-order
baseline: false
changes:
  - root: "event:agent/input/held"
    previous: "2026-10-03-input-custody"
    after: "dbe949135ae111cf9ee0a0c0d1bf327482ae6b8e0e4a40277bf30606cff24659"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing held records omit the marker and retain arrival ordering. Newly captured pending input carries captured true; the fold keeps captured queue order before later held arrivals across checkpoint failures and restart. The executable Inbox is unchanged and the marker confers no authority. The change is an optional field and keeps Session format four.

<a id="verification"></a>
## Verification

Focused input-control, Inbox, instruction-context and input-projection regression passed 221 tests. input-control.ts, input-control-projection.ts and inbox.ts reached 100 percent statements, branches, functions and lines. A persisted-directory restart and failed-flush retry retained prepended and replaced input ahead of later held arrivals.

<a id="dev-note"></a>
## Dev Note

None.
