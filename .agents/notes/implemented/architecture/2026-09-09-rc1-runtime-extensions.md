# Agent Note: Runtime extensions over official rc1

Status: implemented

English | [中文](2026-09-09-rc1-runtime-extensions.zh.md)

## Problem

The reviewed Product runtime needs permanent deletion, exact fork placement, recorded execution directories, scoped policy and branch naming while adopting rc1's Session metadata, controllers and Subagent messages. Old asynchronous observations must not publish a branch or cache row after their source lifecycle was deleted. Historical SQLite logs also need an executable conversion path after upstream removes that provider.

## Decision

The fork uses official `dsh-v0.1.2-rc.1` at `a66e4702047846cdaa10c66c9d3df3951f5ea70d`. The [maintenance guide](../../../../FORK.md) and [manifest](../../../../fork-manifest.json) bind the complete delta. The [deletion decision](2026-08-20-dsh-session-deletion-plugin.md), [trusted environment decision](2026-08-31-trusted-shell-execution-environment.md), [execution-directory decision](2026-09-07-session-execution-directory.md) and [provisioning/attribution decision](2026-09-07-session-provisioning-and-delivery-attribution.md) remain active for their independent behavior and ownership.

`SessionStorageMetadata` carries the exact inherited cut separately from the Header. Backend deletion returns those coordinates; the public persistence service still returns the removed Header and includes the cut in its post-commit event. The projection cache drains writes and retains deleted lifecycle identities, so a delayed cold observation cannot recreate the same checkpoint. A reused id with different lifecycle metadata remains independent.

`SessionStore.capturePublicationCheck()` captures a source deletion epoch before asynchronous observation. Exact Controller fork composes the check into the official Agent setup commit, together with caller setup; releasing a completed deletion reservation cannot make an older source valid again. Reserved destinations reconcile their exact prefix, preset and creation directory. The Controller owns the public fork endpoint and removal notifications; APIProxy is absent.

The official `send_message` path owns adjacent-Agent delivery. The fork adds per-message parent-Turn attribution and an effect-owned parent-delivery restriction. Quiet delivery retains content without waking; it does not suppress content or restore the removed report tool. Title input and generation projections carry the inherited cut so branches exclude inherited input and attempt state while keeping their inherited title provisional.

The JSONL package's public `./legacy-sqlite` helper creates a consistent read-only backup and opens only that copy with a compatible prior rc2 fork runtime in a separate process. The prior reader and JSONL writer use public package APIs, verify event equality and emit portable uncompressed JSONL. Explicit JSONL delegation depth zero preserves the prior optional field's meaning. The new runtime reads the result without importing the old runtime into its service world. Existing output is rejected, child cancellation waits for process close, and original source data is never deleted. Output already published before a reporting failure remains available for inspection. The helper does not switch application profiles.

Gateway invocation policies keep Product admission around the complete unary lookup and operation, replacing APIProxy method replacement for history-only Agent revisions. Connection RPC channel authority remains an explicit optional restriction in addition to rc1 browser authentication; Product administrative channels can retain loopback-only access. Both capabilities report version 1 and fail Product activation when unavailable.

The Client module registry exposes explicitly configured library factories without activating their default UI plugins. This lets a Product consume published UI classes through the same module identity while choosing one presentation and service provider. Library rows retain artifact provenance and HMR; ordinary active rows keep their existing activation behavior. Host and Client halves must be updated together.

## Alternatives considered

**Keep the old APIProxy or Client Runtime alongside the controllers.** Parallel owners would duplicate state and require old protocol adapters to remain executable. The retained behavior belongs on the new public owners.

**Match cache deletion by Header alone.** The inherited cut is part of the log identity in rc1. Omitting it can erase or revive the wrong lifecycle under a reused id.

**Check source deletion only when a fork request starts.** Composition awaits can outlive the deletion reservation. The captured epoch must be checked at publication.

**Copy the old SQLite codec or retain its writable runtime provider.** The prior public reader already owns the compressed schema and its validation. Isolating it over a backup preserves that interpretation without another active persistence owner or original-database mutation.

## Consequences

The runtime retains Product-required extension points while using rc1 metadata, public controllers and messaging. Exact package overrides follow the source diff rather than a target package count. New type-only/public-subpath consumers must compile against the matching fork artifacts and never import a Product implementation into DSH.

Package regressions cover lifecycle reservations, late cache writes, exact forks, execution consumers, title ownership and parent delivery. The legacy artifact integration uses a real prior runtime and checks compressed SQLite events, unchanged source bytes, metadata normalization, empty corpora, output collision, cancellation, rc1 resume and a subsequent fork. The legacy integration requires `DSH_LEGACY_RUNTIME_ROOT`; absence is a skipped prerequisite, not passing compatibility evidence. The headless replay corpus requires its optional patch packages in the root test dependencies so materialized profiles can resolve them; Python scenarios require CPython 3.10 or later. Cross-platform execution and the Product Web composition remain separate acceptance evidence.
