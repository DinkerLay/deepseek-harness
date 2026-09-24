---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-continuable-preset-binding

English | [中文](2026-09-24-continuable-preset-binding.zh.md)

## Summary

Record an optional explicit Preset binding for continuable child Sessions.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-continuable-preset-binding
baseline: false
changes:
  - root: "event:subagent/continuable-preset"
    previous: null
    after: "20d13228022fd1275ca30056c9b3726bef9a8c052f2971fe63a76671f4cba246"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The new subagent/continuable-preset event is written only for an explicitly bound child before its first model request. Existing child logs contain no such event and continue to inherit their parent's composition. Current readers accept both histories without changing the V4 Session header; an older reader that does not know this required event may reject a new explicitly bound child log.

<a id="verification"></a>
## Verification

Focused Vitest run for Preset composition leases, registry revisions, continuable child binding and recovery, and Typert declarations: 5 files and 239 tests passed. Host and Client TypeScript project checks passed.

<a id="dev-note"></a>
## Dev Note

None.
