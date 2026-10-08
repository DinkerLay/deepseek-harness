# Agent Note: Terminal launch policy and independent surfaces

Status: implemented

English | [中文](2026-10-08-terminal-launch-policy-and-surfaces.zh.md)

## Problem

A deployment may require workspace preparation, process confinement or external writer leases for a user terminal. Reimplementing terminal identities and output transport to apply those rules duplicates the native screen and attachment lifecycle. Several UI surfaces also need independent window holds and detachable view instances.

## Decision

TerminalController calls an optional `terminalSpawnPolicy(agent, request, spec)` at allocation, after shell selection. The policy returns a subprocess handle and actual cwd; the native controller retains identity, allocation deduplication, limits, attachment ownership, screen serialization and cleanup. `terminalSpawnPolicyVersion: 1` identifies this boundary. Native default behavior remains an unrestricted user shell. Deployments set `requireSpawnPolicy: true` to refuse creation when their policy is unavailable.

The policy owns any external resources associated with its returned handle and releases them only after process-range cleanup succeeds. Failed allocation must release acquired resources; failed cleanup remains retryable. The preparation signal carries allocation cancellation. A policy does not replace native write, resize, follow or close semantics.

Client `terminalSurfaceVersion: 1` adds `retainTabsFor(surface, tabs)` and `releaseView(sessionId, key)`. Surface holds are combined; the existing `retainTabs` call owns the Sidebar contribution. Releasing one view disposes its stream without closing the Host process or deleting its content binding. Explicit close remains authoritative.

## Alternatives considered

**A separate deployment terminal service.** It would repeat process identity, snapshot ordering, backpressure and reconnect handling merely to change allocation policy.

**Always apply the Agent sandbox to native user terminals.** The existing human-shell contract is deliberate. Deployment policy is explicit and optional.

**One replaceable window retention list.** A second surface could unintentionally release the first surface's terminals. Named contributions preserve independent ownership.

## Consequences

Policy providers must own cancellation, failed spawn and retryable cleanup correctly. Tests cover optional/default behavior, required-policy refusal, idempotent creation, resource cleanup, independent holds and view release without process termination. Session events and the terminal Remote wire protocol are unchanged.
