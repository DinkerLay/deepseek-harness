---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-03-input-custody

English | [中文](2026-10-03-input-custody.zh.md)

## Summary

Adds optional provider-owned input-controller binding, held custody and release facts, and optional inbox audit fields for wake intent, abort-time queue classification and custody removal.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-input-custody
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-30-controlled-message-approval-route"
    after: "5feaf7fefe67167bd1c47614fb6f63a828f81081bd82384ece83759ce09ddced"
    decision: same-version
  - root: "event:agent/input/controller-bound"
    previous: null
    after: "63822f0ed36e10e64973ac8af1a67ad7db4fcbdae3486d0ec400e453244611ed"
    decision: same-version
  - root: "event:agent/input/held"
    previous: null
    after: "495e083bf50f9ca10c78da6c290f92052d03ebc851f4a24df73fdd074fffe9ae"
    decision: same-version
  - root: "event:agent/input/released"
    previous: null
    after: "f8135734a85b589bd26e4e9b20c2435a1ceaf6ee0daaaae495903f41fb9cbd40"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The changes add new event roots and optional inbox fields without changing existing field types or closed enum alternatives. Unbound Sessions retain their synchronous driver path. A missing wake-intent field stays unknown and cannot be guessed during custody capture. Held removal is not a claim or cancellation. Existing events and Session format 4 remain unchanged; no old product-data migration is implemented.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/core/agent-loop/tests/input-control.spec.ts packages/core/agent/tests/input-control-projection.spec.ts packages/core/agent/tests/consumed-work.spec.ts packages/api/session-controller/tests/commands-queue-attachment.host.spec.ts: 76 tests passed. Related regression before subsequent consumer additions: 87 files, 2202 tests passed. Coverage and complete Handoff acceptance remain pending.

<a id="dev-note"></a>
## Dev Note

None.
