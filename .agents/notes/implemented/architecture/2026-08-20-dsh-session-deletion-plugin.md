# Agent Note: Provide permanent Session deletion as a DSH plugin

Status: implemented

English | [中文](2026-08-20-dsh-session-deletion-plugin.zh.md)

## Problem

A permanent-delete action must remove one Session lineage from live Agent ownership, durable persistence, Workspace accounting, query indexes, persisted projection checkpoints, Host projections, and lifecycle-bound sidecars. Deleting a file or one catalog row can leave a live Agent, descendants, search results, or reload-visible state behind. Product authorization cannot own the generic lifecycle operation without coupling reusable DSH behavior to one UI.

## Decision

`@deepseek-ai/dsh-session-deletion` is an optional Host-only service that provides `ctx.sessionDeletion`. It exposes `preview(rootSessionId)` and `deleteTree(rootSessionId)` to an authorized same-process Consumer, and registers no generic browser Remote, command, model tool, prompt section, or Session event. Stock bundles do not mount it.

`SessionPersistence` publishes `supportsDeletion`, `delete(id)`, and `listDeletionHeaders()`. Callers test the explicit capability before mutation. Coordinator-backed providers serialize deletion with append, preparation, lazy materialization, and retirement. A materialized or lazy identity removed by `delete()` returns its header and publishes the awaited `session-persistence/deleted` event; an already absent identity returns `undefined`. JSONL unlinks the exact artifact and removes only an empty backend-owned directory. Legacy SQLite records are converted through the JSONL provider's public exporter before Runtime adoption.

`SessionStore.reserveForDeletion()` fences a non-shrinking set of Session ids and their new descendants against publication. A commit advances per-id deletion epochs so Session objects prepared before deletion cannot publish after the fence releases; a fresh same-id lifecycle remains valid. Overlapping reservations reject.

`AgentRegistry` retains the exact `AgentHandle` returned by `create()` and `resume()` without exposing it. `reserveIdleDisposal(id)` claims only an AgentLoop instance in its exact idle phase with an empty inbox and no maintenance operation. The claim blocks new input and maintenance, then either follows ordinary quiescent handle disposal or releases unused. Directly registered and configuration-owned Agents are not claimable and keep deletion from starting while live.

## Deletion lifecycle

`preview()` merges durable and live headers, rejects conflicting or cyclic lineage, and returns descendants before their root. `deleteTree()` first rejects a persistence provider without deletion support, reserves the current closure, repeatedly extends it until discovery converges, and claims every live member before disposing any of them. One busy or unowned member releases every earlier claim without touching persistence.

After Agent disposal, the original reserved plan remains authoritative even while persistence retirement moves a lazy header between live and cold state; a reservation may extend but never shrink. Persistence deletion runs child-first and advances the SessionStore epoch after each successful per-id settlement, including an already absent zero-event identity. `deletedSessionIds` contains only ids for which persistence returned a removed header. A partial failure can leave deleted children with an existing ancestor; retry rediscovers the remaining tree and converges on root removal.

## Derived cleanup

`session-persistence/deleted` is the commit notification for durable Consumers. Workspace removes the id from every account and the archive set. Session Query removes persisted and live index rows. Session Projection Cache waits earlier writes and cold reads, blocks matching writes during cleanup, and removes only the checkpoint bound to the deleted header identity. Message Feedback joins its per-Session mutation queue and removes the matching lifecycle sidecar. Session Controller emits one `api-session/removed` notification, deduplicated against ordinary live disposal.

Listener failure cannot reverse a committed storage deletion. The parallel event still invokes every Consumer, logs the aggregate failure, and later startup or catalog reconciliation derives from the remaining persistence state.

## Alternatives considered

**Delete directly from a Product Catalog.** A Product package cannot own both persistence providers, Agent handles, Session publication, and every derived Consumer without duplicating DSH lifecycle behavior.

**Infer backend support from `delete()` method presence.** The Service Definition supplies a rejecting default for third-party providers, so method presence does not prove capability. `supportsDeletion` fails before any Agent is reserved or disposed.

**Expose a generic browser `session.delete` endpoint.** Ambient browser deletion would bypass product ownership and confirmation. An authorized Product Remote remains the Consumer of the Host service.

**Delete only leaf Sessions.** Root conversations can own subagents and other descendants. Bottom-up subtree deletion preserves lineage consistency and provides a useful product operation.

**Cancel running Agents automatically.** Cancellation may discard queued work or conceal tool side effects. Deletion rejects before persistence mutation unless every live subtree member is truly idle and claimable.

**Delete Project directories with Project Chats.** A Session does not own a Project directory. Session deletion removes Workspace accounting but never source files or Workspace registration.

## Consequences

Permanent deletion spans several durable owners rather than one storage transaction. The reservation, non-shrinking plan, child-first ordering, explicit provider capability, idempotent persistence return, and product-owned journal are all required for convergence. The operation is irreversible after persistence and product allocation cleanup commit.

The generic package deliberately owns no browser authorization, archive policy, Project-file deletion, or Product allocation cleanup. Those decisions remain with the Consumer. Focused contracts cover JSONL, legacy SQLite export, lazy identities, preparation refusal, true-idle AgentLoop disposal, all-or-nothing live claims, lineage cycles, partial-failure retry, Loader composition, and the derived cleanup Consumers.
