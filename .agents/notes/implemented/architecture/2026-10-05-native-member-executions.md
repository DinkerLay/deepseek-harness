# Agent Note: Native member identity and execution custody

Status: implemented

English | [中文](2026-10-05-native-member-executions.zh.md)

## Problem

A teammate's original Session address identifies Task ownership and message recipients. Replacing that address everywhere for a fresh context would rewrite historical producers and confuse delayed callbacks. Recreating a roster member for every context change would also consume permanent names and historical capacity.

Public idle status does not exclude maintenance work, and an in-memory appended event does not prove checkpoint success. Neither observation alone permits enabling a replacement execution.

## Decision

The [native Team](../../../../packages/experimental/agent-team/README.md) keeps the original member identity and execution generations in its existing journal. An optional Host owner restricts one member's collaboration admission and attaches opaque progress to the same control or binding effect. Current callers resolve from their real executions; historical authors and old delivery receipts remain unchanged. Ordinary compositions do not install the owner.

The [continuation manager](../../../../packages/subagent/subagent/README.md) provides input-free preparation and quiet Host maintenance, preserving parent, descriptor, Preset and catalog ownership without a model request. Binding and release occupy the predecessor before their serialized Team checks. Waiting never holds the Team lock. A runtime occupation lasts until maintenance handback even when release has already committed.

A dormant predecessor uses Core's exclusive stored-input custody instead of mounting its old Preset. Core validates the source before repairing interrupted input and owns the original writer; Subagent reserves the child and verifies its lineage and descriptor. An absent stored source is only an uncreated execution when no parent catalog entry exists. A lost existing log, live execution or unresolved external effect remains a blocker. The ordinary resume path still requires the original Preset revision.

Acknowledgement requires a successful checkpoint. Retry identities cover candidates, roster reservations and exact cancelled message sets; later messages are not cancelled by a retry. Profile slot effects update current associations without rewriting the original application target. Bounded references preserve source attribution as data, not old approval or instruction authority.

## Alternatives considered

**Retire and recreate for every context change.** This is suitable for a different member, not for keeping the same immutable configuration, identity and attribution with a fresh execution.

**Keep execution bindings only in the product.** Native mailbox, roster, Task admission and cold recovery would need a second authority. Native Team owns bindings; the product owns workflow intent and progress.

**Treat idle or generation rejection as quiescence.** Neither excludes maintenance, background jobs or external effects. Real occupation and caller-owned blocker observations remain necessary.

## Consequences

Consumers distinguish member addresses from producing executions. Renewal does not erase Sessions, return permanent names, widen ordinary tools or replay old approvals. Unloading the optional owner does not silently reopen its bound executions.

Projection, real-JSONL and continuation tests cover checkpoint failure, old-generation rejection, candidate retries, cold custody and maintenance races. Client tests distinguish changing from ready and preserve request identities after uncertain responses. Product workflow and real-model acceptance remain separate from native mechanism tests.
