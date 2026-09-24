---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-22-host-owned-delegation

English | [中文](2026-09-22-host-owned-delegation.zh.md)

## Summary

Records Host-owned delegated execution identity, captured Preset declaration revision and permanent retirement.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-22-host-owned-delegation
baseline: false
changes:
  - root: "event:subagent/host-owned"
    previous: null
    after: "1f5d5a6d2db94a159e6d1bafe3f265601853a223d05996693ee6c33fd4333886"
    decision: same-version
  - root: "event:subagent/host-retired"
    previous: null
    after: "0bf0aa8b33b45cd153d76a9730d91b53f10370201b787e74fb145413616ddd31"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Adds two required Session event types without changing existing payloads or the MessageSource union. Existing logs remain readable. Older builds refuse new Host-owned logs because they do not recognize the required owner events; they must not resume these executions as ordinary children. The Session writer format remains 4.

<a id="verification"></a>
## Verification

The consuming AgentHandoff workspace runs real Loader, Agent loop, JSONL persistence and control-journal tests covering old-Lead disposal, cold recovery without a Lead, owner mismatch, idempotent messages and awaited retirement. The focused Agent loop and Preset lease suites pass 15 tests.

<a id="dev-note"></a>
## Dev Note

None.
