# Agent Note: Runtime extensions over official rc1

Status: implemented

English | [中文](2026-09-09-rc1-runtime-extensions.zh.md)

## Problem

The reviewed Product runtime needs permanent deletion, exact fork placement, recorded execution directories, scoped policy and branch naming while adopting rc1's Session metadata, controllers and Subagent messages. Old asynchronous observations must not publish a branch or cache row after their source lifecycle was deleted. Historical SQLite logs also need an executable conversion path after upstream removes that provider.

## Decision

The fork uses official `dsh-v0.1.5-rc.1` at `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`. The [maintenance guide](../../../../FORK.md) and [manifest](../../../../fork-manifest.json) bind the complete delta. The [deletion decision](2026-08-20-dsh-session-deletion-plugin.md), [trusted environment decision](2026-08-31-trusted-shell-execution-environment.md), [execution-directory decision](2026-09-07-session-execution-directory.md) and [provisioning/attribution decision](2026-09-07-session-provisioning-and-delivery-attribution.md) remain active for their independent behavior and ownership.

`SessionStorageMetadata` carries the exact inherited cut separately from the Header. Backend deletion returns those coordinates; the public persistence service still returns the removed Header and includes the cut in its post-commit event. The projection cache drains writes and retains deleted lifecycle identities, so a delayed cold observation cannot recreate the same checkpoint. A reused id with different lifecycle metadata remains independent.

`SessionStore.capturePublicationCheck()` captures a source deletion epoch before asynchronous observation. Exact Controller fork composes the check into the official Agent setup commit, together with caller setup; releasing a completed deletion reservation cannot make an older source valid again. Reserved destinations reconcile their exact prefix, preset and creation directory. The Controller owns the public fork endpoint and removal notifications; APIProxy is absent.

The official `send_message` path owns adjacent-Agent delivery. The fork adds per-message parent-Turn attribution and an effect-owned parent-delivery restriction. Quiet delivery retains content without waking; it does not suppress content or restore the removed report tool. Title input and generation projections carry the inherited cut so branches exclude inherited input and attempt state while keeping their inherited title provisional.

The JSONL package's public `./legacy-sqlite` helper creates a consistent read-only backup and opens only that copy with the recorded rc2 fork runtime in a separate process. The prior reader and JSONL writer use public package APIs and emit portable uncompressed V0 JSONL. When an rc2 final Assistant message immediately follows one exact contiguous same-Turn and same-step chunk attempt, the export adds the missing `sourceEventSeqs` to the new artifact. It validates the final model source, assembled content, usage and replay state, and refuses gaps, cross-step chunks or conflicting provenance. Explicit JSONL delegation depth zero preserves the prior optional field's meaning. The original database remains byte-identical.

`migrationCoordinates(id).source.revision` is a `content-v1` SHA-256 identity over the retained predecessor bytes, source format generation and Session id. It survives a byte-identical data-home copy and changes when any of those inputs changes. `stat()` and `list()` keep their native device/inode/size/time revisions, and target revisions remain physical tokens. An existing current successor must retain the migrated predecessor prefix; valid later V3 appends do not invalidate the mapping.

Session Query resolves cold execution directories once per persistence revision and immutable header identity. The corpus cache retains only the derived string and a shared in-flight Promise, so repeated or concurrent `listSessions()` calls do not replay unchanged long histories or retain their events. Session removal, revision change and persistence replacement invalidate the corresponding observation.

Canonical message-feedback events retain write authority while the service reads matching released version-zero sidecar rows below that event fold. Strict schema, Session identity, message target and item-count checks reject malformed rows; canonical delete prevents an old sidecar rating from returning after restart. The [sidecar read-through decision](../bug-fix/2026-09-10-message-feedback-sidecar-read-through.md) owns this compatibility boundary.

Gateway invocation policies keep Product admission around the complete unary lookup and operation, replacing APIProxy method replacement for history-only Agent revisions. Connection RPC channel authority remains an explicit optional restriction in addition to rc1 browser authentication; Product administrative channels can retain loopback-only access. Both capabilities report version 1 and fail Product activation when unavailable.

The Client module registry exposes explicitly configured library factories without activating their default UI plugins. This lets a Product consume published UI classes through the same module identity while choosing one presentation and service provider. Library rows retain artifact provenance and HMR; ordinary active rows keep their existing activation behavior. Host and Client halves must be updated together.

## Alternatives considered

**Keep the old APIProxy or Client Runtime alongside the controllers.** Parallel owners would duplicate state and require old protocol adapters to remain executable. The retained behavior belongs on the new public owners.

**Match cache deletion by Header alone.** The inherited cut is part of the log identity in rc1. Omitting it can erase or revive the wrong lifecycle under a reused id.

**Check source deletion only when a fork request starts.** Composition awaits can outlive the deletion reservation. The captured epoch must be checked at publication.

**Copy the old SQLite codec or retain its writable runtime provider.** The prior public reader already owns the compressed schema and its validation. Isolating it over a backup preserves that interpretation without another active persistence owner or original-database mutation.

**Use filesystem stat identity for persisted migration markers.** Device, inode and timestamps identify one physical observation but change across a byte-identical copy. They remain appropriate for local `stat()` and `list()` snapshots, while durable migration markers require content identity.

## Consequences

The runtime retains Product-required extension points while using rc1 metadata, public controllers and messaging. Exact package overrides follow the source diff rather than a target package count. New type-only/public-subpath consumers must compile against the matching fork artifacts and never import a Product implementation into DSH.

Package regressions cover lifecycle reservations, late cache writes, exact forks, execution consumers, title ownership, parent delivery, feedback sidecars and copy-stable migration markers. The legacy artifact integration uses the real recorded runtime and checks compressed SQLite events, exact reconstructed chunk coordinates, unchanged source bytes, metadata normalization, empty corpora, output collision, cancellation, resumed execution and a subsequent fork. The integration requires `DSH_LEGACY_RUNTIME_ROOT`; absence is a skipped prerequisite, not passing compatibility evidence. The headless replay corpus requires its optional patch packages in the root test dependencies so materialized profiles can resolve them; Python scenarios require CPython 3.10 or later. Cross-platform execution and the Product Web composition remain separate acceptance evidence.
