# Agent Note: Session creation receipts and lazy prompt preparation

Status: implemented

English | [中文](2026-09-17-session-receipts-and-lazy-prompt-inputs.zh.md)

## Problem

External controllers can create a Host Session while coordinating their own metadata. Their Client consumers need to address the confirmed Session without another Host create or whole-list read. Separately, lazy capability setup must finish before prompt providers read Tool schemas; `agent/pre-step` and the assembly waterfall both occur after that collection.

## Decision

The Session Client exposes version-one creation receipt adoption. A validated Host receipt creates a local blank summary only when the identity is absent. The manager records it through its existing mutation journal and synchronously projects the list, preserving it across an in-flight baseline. Repeated receipts preserve richer existing state, and adoption does not select or create a Host Session.

System Prompt exposes a version-one, scope-aware `system-prompt/prepare` serial event before reading any provider. It awaits preparation and checks the assembly cancellation signal before and after dispatch. Providers own their resources and cancellation; the later assembly waterfall retains its existing transformation role. Neither capability changes Session persistence or introduces business policy.

## Alternatives considered

**Refresh the entire list or repeat creation.** Both add an unrelated round trip to confirmed creation; private list mutation would bypass the manager's in-flight baseline journal.

**Initialize capabilities during Agent creation.** That blocks empty Session creation on network readiness. Initializing at `agent/pre-step` instead is too late for the first request's schema collection.

## Consequences

The public receipt trusts a typed, already validated Host response and cannot prove the Host operation itself. Lazy preparation failures prevent that model assembly, while empty Sessions remain available. Focused Client and prompt tests cover synchronous addressability, repeated receipts, preparation ordering, cancellation and listener disposal. Existing Session lifecycle and prompt-assembly contracts remain active; these entry points supplement rather than supersede their ownership.
