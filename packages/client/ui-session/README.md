---
description: "React and Slot adapters for Session Controller lists, interaction state, and per-session context."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-session

English | [中文](README.zh.md)

## Summary

Use this package to expose Session catalog, retain information, and unified UI status through standard Slot hooks. It materializes per-`SessionBinding` hooks and props, while `SessionProvider` can inherit an outer binding or bind an explicit `SessionReference`. It owns process-local pending-interaction and completion-reminder policy without owning Controller transport, history, or references.

Running status comes from Host list baselines or status events. Subagent catalog rows and retained subagent fallback rows do not establish running status; main view references still acknowledge completions.

## Table of Contents

- [Execution presentation](#execution-presentation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="execution-presentation"></a>
## Execution presentation

`SessionProvider` accepts an owned `SessionReference` and optional `presentationOptions`. `addressSessionId` supplies the stable navigation address; it never changes the execution's scope, observable sources, or commands. Without an override, `sessionAddressId` is the actual `sessionId`. Session-scoped entries that render Factory occurrences obtain this seat through `PropsRenderFactories<true>` without declaring an ordinary child Slot.

`readOnly: true` suppresses mutation presentation. The standard `sessionReadOnly` also follows the actual Session snapshot's read-only state, including a later downgrade of a shared generation; inherited read-only presentation cannot be cleared by setting the option to false. The adapter keeps binding-source identity and publishes changed props through that source. It neither acquires nor releases the caller's reference. These presentation options grant no Host authority; historical consumers acquire the Controller's [read-only target](../../api/session-controller/README.md) separately.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package adapts browser-side Session state and registers nothing model-facing.

#### KV Cache effect

None; Session selectors and Slot scopes do not assemble model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Pending interactions are process-local projections** — the owning Remote waterfall must replay an outstanding request after a browser reconnect.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The adapter materialization path enforces Session binding consistency.
