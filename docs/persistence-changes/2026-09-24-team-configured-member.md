---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-team-configured-member

English | [中文](2026-09-24-team-configured-member.zh.md)

## Summary

Record an explicitly configured Team member with a pinned Preset declaration revision and lifecycle phase.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-team-configured-member
baseline: false
changes:
  - root: "event:team/member/configured"
    previous: null
    after: "0aad63be083774f083a1f394dc0c64eb49129a92ca30500e843fb5848f5ff666"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing team/member version 2 records remain valid and retain their original shape. Team creation writes team/member/configured version 3 only when a Preset is explicitly selected or an extended lifecycle phase is recorded. The Team projection replays both event forms without changing the V4 Session header. Older readers unaware of this required event may reject a Team log containing it.

<a id="verification"></a>
## Verification

Focused Vitest run for the native Team service, Team tools, and Team client UI passed 144 tests across 7 files. The tests cover version 2 replay, version 3 Preset binding, cold continuation, changed-declaration refusal, and tool forwarding. Host and Client TypeScript project checks passed.

<a id="dev-note"></a>
## Dev Note

None.
