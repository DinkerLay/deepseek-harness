---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-03-native-lead-seat

English | [中文](2026-10-03-native-lead-seat.zh.md)

## Summary

Adds a version-one native Lead seat transaction containing the new execution binding, opaque Task-writer data, Lead Task releases and mailbox notices.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-native-lead-seat
baseline: false
changes:
  - root: "event:team/lead/transaction"
    previous: null
    after: "9ceba5d411831606155013c14275b97bf0f90afa3b2836182903cec5f7f1a558"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

This is a new required-on-read event. Existing records and their fields are unchanged. Teams without the event keep the initial anchor at term one; the optional runtime provider leaves official composition unchanged. Readers validate contiguous terms and apply the seat, release snapshots and notices atomically. Session format stays at version four.

<a id="verification"></a>
## Verification

Native Lead identity and seat projection tests exercised matching, stale and reused executions and atomic release snapshots. The prepared-Lead runtime tests passed 23 selected cases; lead-runtime.ts reached 100 percent statements, branches, functions and lines. Host and Client TypeScript builds passed after using browser-safe type imports. This does not claim the product Handoff coordinator or real-model acceptance is complete.

<a id="dev-note"></a>
## Dev Note

None.
