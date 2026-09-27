---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-team-composition-profile

English | [中文](2026-09-27-team-composition-profile.zh.md)

## Summary

Persists user-managed Team composition transitions, optional Profile slot identities on configured members, and an optional marker for permission-binding extension records.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-team-composition-profile
baseline: false
changes:
  - root: "event:team/composition"
    previous: null
    after: "96904f95f276e854cd7c497097245922f1f1e434a63a2281020580dbdedad822"
    decision: same-version
  - root: "event:team/extension"
    previous: "2026-09-27-team-extension-record"
    after: "df46177a437d5c73ed354fdd8f866d489f197e801abf74f84b76a1ef6cbb4058"
    decision: same-version
  - root: "event:team/member/configured"
    previous: "2026-09-26-controlled-team-mode"
    after: "981ea5b7f8722edd4e591e409003011119f6f718460ccbb98804185e9174d8c1"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Team records omit the optional slot and composition-change fields and replay unchanged. A Team without a composition event remains dynamic. New composition events keep the current Session header format, but a reader that does not know this required event refuses that newer log instead of inventing a roster policy. The native projection rebuilds lock and application state from the Lead Session events.

<a id="verification"></a>
## Verification

Focused Agent Team composition and projection Vitest files passed 37 tests; Team lifecycle tests covered lock admission, matching applications and Preset revision refusal. Outer Task Management passed 31 tests, including one-event permission rebind and replay. A Web QA Team applied a seven-member Profile and retained historical Tasks.

<a id="dev-note"></a>
## Dev Note

None.
