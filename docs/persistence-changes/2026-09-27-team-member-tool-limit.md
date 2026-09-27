---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-team-member-tool-limit

English | [中文](2026-09-27-team-member-tool-limit.zh.md)

## Summary

Adds an optional persisted Team-wide member tool ceiling to the controlled-mode event, covering allow and deny lists without changing the official Team default.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-team-member-tool-limit
baseline: false
changes:
  - root: "event:team/mode"
    previous: "2026-09-26-controlled-message-cap"
    after: "13c2093d78a82a5a34827fb879328abaaf068464e2e2780117a89ad63b21194f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing mode events omit memberToolLimit and retain their prior member catalog and direct-call behavior. New controlled Teams may pin an allow and/or deny list in the Lead Session before tools open; the same value is replayed after restart. The event version stays one because the field is optional and older records remain valid.

<a id="verification"></a>
## Verification

Agent Team and Team-tool focused suites passed 118 tests, including the unchanged official combination, inherited-tool intersection, a hidden scoped Team tool, and direct-call denial. Product Task tests passed 33 tests, including a hidden product Team tool.

<a id="dev-note"></a>
## Dev Note

None.
