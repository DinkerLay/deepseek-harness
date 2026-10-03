---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-02-lead-execution-identity

English | [中文](2026-10-02-lead-execution-identity.zh.md)

## Summary

Adds the version-one team/lead/execution identity event for an ordinary, unseeded execution. Session format 4 is unchanged.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-02-lead-execution-identity
baseline: false
changes:
  - root: "event:team/lead/execution"
    previous: null
    after: "54241acd2b3a944145e378c351ea5f68cdc8fbfc2e3ba80e844734f4a2bc0e9a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing event definitions are unchanged and existing sessions need no identity event. The event records an anchor, term and immutable Preset binding; its presence grants no Lead authority. A host-only projection excludes inherited records and rejects malformed, duplicate or late identities. Older harnesses refuse the unknown event rather than interpreting the execution as an implicit Team.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/agent-team/tests: 160 tests passed. The identity fold's 21 tests achieved 100% statements, branches, functions and lines; four Agent Loop and JSONL integration cases verify official and controlled identity before publication, persisted resume, ordinary fork isolation and Team reload. This evidence does not establish input admission or a completed Handoff.

<a id="dev-note"></a>
## Dev Note

None.
