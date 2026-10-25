# Agent Note: Scoped PTC tool filters

Status: implemented

English | [中文](2026-10-25-scoped-ptc-tool-filters.zh.md)

## Problem

A consumer can retain native tools while exposing a smaller set to programs. Restricting the agent's entire tool view removes legitimate native capabilities; hiding names only in generated SDK text leaves nested execution broader than the advertised interface.

## Decision

`tools.presentAs(mode, { ptcFilter })` owns an effect-scoped filter. SDK generation, binding enumeration and execution under a live PTC parent token use the same intersection of visible tools and inherited filters. Native calls and unrelated composite transports retain their original tool view. A child cannot widen its parent's filter; disposing the parent removes that parent's contribution.

An explicitly empty PTC subset hides its transport without requiring a backend. Unfiltered compositions retain their pure-computation transport. The mask contains no product vocabulary and changes no Session event or persisted type.

The [scope resolver](2026-07-12-agent-scope-runtime-design.md) and [executor collapse](../bug-fix/2026-08-07-ptc-executor-collapse.md) retain their ownership. The [PTC foundation](../feature/2026-06-15-ptc.md) remains active; this decision adds a separate PTC subset without replacing its presentation and settlement rules.

## Alternatives considered

An agent-wide restriction removes native tools as well. A presentation-only filter leaves an execution bypass. Applying the PTC mask to every nested call changes unrelated composite transports, so the registry tracks live PTC parent tokens until the bridge has drained.

## Consequences

Consumers declare eligibility and policy outside the registry. Registration, output contracts, scheduling, guards and settlement remain shared. Tests exercise SDK/binding parity, native calls, unknown/reserved declarations, empty subsets, inherited restrictions, disposal and a nested-call bypass. Downstream adopts the reviewed fork through its existing pin workflow.
