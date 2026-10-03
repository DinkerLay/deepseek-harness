---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-03-native-lead-coordination

English | [中文](2026-10-03-native-lead-coordination.zh.md)

## Summary

Adds optional native Lead transition and coordinator-operation facts to extension records, independent coordinator audit and initialization-material ordering to Lead transactions, and one log-only interrupted approval rejection event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-native-lead-coordination
baseline: false
changes:
  - root: "event:approval/interrupted-rejected"
    previous: null
    after: "a57d2d97b9a04472e1bf489a6aaf4796e76f8562ce0d2d1eb67ee71e0c48ecba"
    decision: same-version
  - root: "event:team/extension"
    previous: "2026-10-03-native-lead-mail"
    after: "6f0ee24b137470c294d0f3b19ddf8f47450793d5e4ddc0ad7b5e49ae3d0ed27b"
    decision: same-version
  - root: "event:team/lead/transaction"
    previous: "2026-10-03-native-lead-mail"
    after: "155b5354bec57e47bfef91341021268a6d14d0c61db6923006333b95e1fe5059"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing event fields, versions and outcome values remain unchanged. The new fields are optional; transactions without initialization-order metadata retain their previous queue order. The new version-one approval event is required on read and settles only its original routed question after its turn has ended. The bound Task writer still owns the transaction's Task audit; coordinator material has a separate namespace. Session format remains version four. No stored Session or accepted type acknowledgement is migrated, replaced or rewritten.

<a id="verification"></a>
## Verification

Focused real Loader, Agent Loop, JSONL and public-export Task writer tests exercise frozen admission, Profile exclusion, expired maintenance authority, exact-effect retries, atomic releases, two Lead transitions and non-waking cold delivery. The keyless headless recorded-session case retains the original denied tool result and blocked turn, and rejects unrelated failures or Task writes. Approval tests exercise one-shot rejection, late answers and interrupted original-question recovery. These engineering checks do not establish real-model product Handoff acceptance; final commands and scoped coverage are recorded separately in the outer H3 evidence.

<a id="dev-note"></a>
## Dev Note

None.
