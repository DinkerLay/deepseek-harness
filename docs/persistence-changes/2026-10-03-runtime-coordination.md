---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-03-runtime-coordination

English | [中文](2026-10-03-runtime-coordination.zh.md)

## Summary

Records native V4 execution-directory bindings, title policy and generation state, exact title input truncation, and optional parent delegation location.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-runtime-coordination
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "c88423d41455e57935ae51e4857cf3682f85cdd5887ea59d987419f384f95ce0"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "b97998b628079a8a7535bea10223b5ee49130298953899ff1e8c0a1d97bb51ca"
    decision: same-version
  - root: "event:session/execution-directory"
    previous: null
    after: "ae3b11d0f44715ba8cdaa1a23c8cf970a86986b70dd901c76bce6b4049dca04e"
    decision: same-version
  - root: "event:session/title"
    previous: "2026-09-11-initial"
    after: "e3266875dcdc30f2a848a770dab7e9dcf376f8571a58b452b36c329a698a2354"
    decision: same-version
  - root: "event:session/title-generation"
    previous: null
    after: "ba5b6bd42e37395fe5f5aee06a01c1c3d934258ee1ad72a8d7ae18f0982e5e69"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "7ea0c34f507656299c22fd742e17a757d130c06a6d73aff02640d49b60974476"
    decision: same-version
  - root: "event:session/title-policy"
    previous: null
    after: "af16d0311fd822ebf024070bd3413e4cb5de712224188e074b755dfa51a2ffba"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "37c01bfae9769b626b6da2111eed30778d394f3c63df21788ad086dc2c07ceed"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The classifier permits this same-version transition: three log-only event roots are added, and existing title and agent-message fields gain optional information. Existing V4 payloads remain structurally valid. Session execution-directory, title-policy and title-generation records require their declared event implementations; an older build must refuse an unknown non-ignorable event. First-prompt titles use the child-owned suffix, while all-prompts providers retain eligible inherited input. This acknowledgement does not add pre-upgrade Session imports or alter frozen format history.

<a id="verification"></a>
## Verification

The V4 execution-state, Session title LLM and continuation-message focused suites passed 3 files and 24 tests. Cold Controller projection/search, all-prompts titles, title lifecycle, projection-cache format fixtures and Session Query suites passed 16 files and 242 tests. The persistence classifier reported nine same-version changes and no required header-version increase.

<a id="dev-note"></a>
## Dev Note

None.
