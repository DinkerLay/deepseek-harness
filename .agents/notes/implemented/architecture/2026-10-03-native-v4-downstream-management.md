# Agent Note: Native V4 extensions for downstream management

Status: implemented

English | [中文](2026-10-03-native-v4-downstream-management.zh.md)

## Problem

A downstream Product manager needs exact resource ownership and admission across ordinary Session APIs, Agent creation, persistence and browser views. Stock DSH 0.2.0-rc.2 supplies native V4 execution but lacks several public contracts needed by those consumers. Replacing native lifecycle implementations would lose upstream behavior and obscure which delta a deployment executes.

## Decision

The fork retains official V4 Session and Agent lifecycle implementations and adds bounded public extensions. Creation middleware owns its accepted work through teardown; idle and deletion reservations exclude competing work; publication checks reject stale creation or derived-state writes. Persistence deletion commits before cache, query and Workspace invalidation. Recoverable forks retain caller-reserved identity, directory and exact closed prefix, including an empty prefix, while ordinary native event cuts retain their own behavior.

Effective execution directories are durable facts owned by the exact Session, independently of immutable creation cwd. Directory consumers use the public resolver. Title policy and generation state are branch-owned; a public sizing helper permits Product excerpt selection over native auxiliary execution. Native V4 validates these required extension events. Custom pre-upgrade reader and coordinate-migration extensions are absent; downstream starts a separate native V4 generation and keeps legacy data inactive.

Prompt preparation is awaited before providers and schemas. Deployment constraints apply to resolved policy and approved escalation. Trusted execution environment contributors remain separate from model Tool input and process environment. Gateway policy covers lookup and invocation; per-channel loopback authority supplements browser authentication. Parent delivery policy preserves admitted content while controlling wakeups, and messages retain parent-Turn attribution.

Browser library exports load without activating default plugins. Page reconciliation materializes library exports but creates Loader fibers only for active plugin rows; changing a row back to a library disposes its plugin lifecycle. Conversation decorators preserve grouping and publication hooks; logical Chat navigation and counts can exclude retired presentation Turns. Markdown local-link resolution is caller-owned. The model catalog exposes registered execution providers separately from available catalog groups.

The PiAi bridge maps resolved historical Tool additions onto transcript system messages and offers native additive capability only for explicitly supported protocol/model flags. The prepared snapshot binds capability and dispatch. Unsupported routes keep the native compatibility projection; a remote gateway still requires actual protocol verification.

## Alternatives considered

**Copy native services into a downstream package.** That would create a competing authority for execution, persistence or transport. Generic missing contracts belong on the current native owners.

**Replay the prior fork bytes.** Prior interfaces and message representation do not describe native V4. Required behavior is integrated into current implementations and old compatibility-specific code is retired.

**Use visible schemas as authorization.** Direct and alternate execution paths can bypass presentation. Scoped lookup, guards and policy remain authoritative when a schema is deferred or searched.

**Preserve old logs through custom migration.** The downstream release explicitly excludes legacy Session import. Current V4 persistence and replay are verified independently; old data is retained rather than erased or silently rebound.

## Consequences

Downstream management can consume public execution and resource contracts without owning DSH core state. The cost is an exact source delta and atomic fork artifact installation. Native System locks, race-focused deletion/fork tests, scoped policy tests and Client library tests cover the current behaviors. Host compilation and local SDK payload tests verify the current type and serialization paths. Remote-provider support and Product Web/Desktop acceptance remain separate evidence; this record does not claim those downstream flows pass.

Failed TypeScript projects suppress emission so an incomplete build cannot leave executable artifacts beside source. Source tests resolve a single module identity and do not mix generated JavaScript with TypeScript registrations.

The machine-readable fork manifest records the exact official commit required by downstream binding. Maintained prose cites its release tag. Reference validation permits only that structured commit field; other references remain subject to the prose rule.
