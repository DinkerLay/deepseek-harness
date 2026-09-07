# Agent Note: Session provisioning and delivery attribution

Status: implemented

English | [中文](2026-09-07-session-provisioning-and-delivery-attribution.zh.md)

## Problem

A history fork that always inherits cwd cannot represent an independently writable execution directory. A resident child can accept inputs from several parent Turns, so its activation identity cannot identify each delegated task. Inherited title pins also prevent a branch from naming its own work.

## Decision

The Host fork API accepts an exact balanced seed length and an optional reserved destination identity and cwd. Repeating the same destination reconciles the existing prefix, preset and placement; a conflicting identity or open Turn prefix is rejected. The existing atSeq behavior remains available. DSH creates no Git repositories and owns no Product directory cleanup.

AgentRegistry creation interceptors run before the factory creates a Session. Trusted deployment plugins own their allocation, metadata and rollback; effect disposal prevents new calls and drains admitted creations. Sandbox policy constraints run after explicit mode overrides, allowing an execution-directory ceiling to apply to filesystem and shell consumers without changing their implementations.

Continuable child inputs persist their delegating parent Session and open Turn in source.delegation, alongside their exact inbox message ID. Each followup carries its own attribution even while the same activation remains resident. Calls made outside an open parent Turn omit parentTurn.

Fork title providers receive only post-seed human input. The first-prompt cadence names that input, while inherited titles remain provisional. A user rename pins only the Session where it was accepted. Explicit refresh appends a title-policy event releasing a user pin; title-generation events record generating, ready and failed outcomes without opening a task Turn or discarding the last usable title.

Naming cadence does not select or shorten messages. The title helper honors the provider selector and exposes the exact framed byte count; deployment providers own retention and excerpt policy. Shortened inputs carry `inputTruncated` in the auxiliary request and accepted title. User-stopped parents retain late child reports quietly; the stop frontier accounts for input arriving during cancellation convergence.

Explicit fork destinations resolve Workspace attachment from the destination directory. Source ancestry is retained independently, because assigning the original Workspace to a different immutable cwd violates its ownership contract.

## Alternatives considered

**Change cwd after Session creation.** Immutable cwd is part of execution and persistence identity; provisioning chooses it before publication.

**Use one activation ID as every child's task ID.** A later followup can belong to another parent Turn; accepted inbox message identity provides the exact correlation.

**Rename every branch through the user API.** That records an explicit pin and prevents automatic naming. Product aliases remain outside this API.

## Consequences

Products can allocate isolated execution resources while DSH retains composition, identity and history authority. The generic hooks carry no Git or Product policy. Provisioning consumers must retain recovery intents and must not describe a worktree as a sandbox. A sandbox constraint applies only to consumers which enforce the resolved policy; unrestricted external actors remain outside it.

The [stopped-parent ACP composition](../../../../examples/acp-agent/subagent-stopped-parent.cordis.yml) replays cancellation before child reporting and pins the absence of another parent model request. The title and continuation application snapshots preserve the same log and message ownership used by the public APIs.
