# Agent Note: Message-feedback sidecar read-through

Status: implemented

English | [中文](2026-09-10-message-feedback-sidecar-read-through.zh.md)

## Problem

Released DSH runtimes persist per-message ratings and notes in the `message_feedback` version-zero storage domain. The canonical Session-event implementation does not contain those records, so opening the same storage root can hide historical feedback. Copying records into a Session log during startup would mutate user history, need cross-store recovery, and risk restoring feedback that a later canonical delete intentionally removed.

## Decision

`dsh-message-feedback` opens the released storage domain read-only and uses a valid row as the initial value for its current-state fold. Canonical `feedback/message-put` and `feedback/message-delete` events apply afterward in log order. A canonical value therefore overrides its sidecar value, and a canonical delete continues to suppress that item after restart.

The compatibility row must match the inspected Session's `{createdAt, cwd}` identity. Its closed schema rejects unknown fields, duplicate message ids, duplicate versions, invalid timestamps, and malformed items. Every retained message id must name a finalized append-origin assistant message in the owning log. `maxLegacyItemsPerSession`, which defaults to 1000, rejects oversized rows before they enter service results.

The service never writes, rewrites, removes, or truncates the sidecar. New mutations remain canonical Session events, so the sidecar bytes stay available to older runtimes and recovery tools while the Session log remains the only current write authority.

## Alternatives considered

**Import the row into canonical events.** An automatic import would modify Session history during a read or startup, require a durable cross-store completion marker, and make interruption recovery part of the feedback write protocol. It could also append a released rating after a canonical delete unless the importer reconstructed both histories first.

**Ignore the released domain.** This keeps the canonical implementation smaller but makes valid ratings and notes disappear when a storage root is opened by the current runtime.

**Continue writing both stores.** Dual writes keep older runtimes current only while every mutation succeeds in both independent persistence systems. There is no atomic transaction spanning them, and the sidecar would remain a competing authority.

## Consequences

Historical feedback stays visible without changing its source bytes. Canonical edits and withdrawals have deterministic precedence across restart. Mounting this package requires `storageDomain`, and an operation for a Session with a compatibility row performs strict row and message-target validation. Malformed or oversized released data fails explicitly instead of being partially accepted.

The [service tests](../../../../packages/feedback/message-feedback/tests/message-feedback.spec.ts) copy released-format documents, verify byte preservation, pin canonical put/delete precedence across restart, and cover stale Session identity, unknown messages, closed-schema rejection, and the item bound. The [package reference](../../../../packages/feedback/message-feedback/README.md#released-sidecar-read-through) defines the operational contract.
