# Agent Note: Recorded Session execution directories

Status: implemented

English | [中文](2026-09-07-session-execution-directory.zh.md)

## Problem

A host can retain one conversation while moving its execution into a managed directory. Creation cwd also identifies persisted logs, so rewriting the header would relocate history or collide with an existing identity. Resolving only file mutations against a different root leaves reads, searches, shell commands and instructions looking at another tree.

## Decision

The required log-only `session/execution-directory` event records an absolute physical cwd and its owning Session id. `Session.executionDirectory` incrementally folds only its own bindings; `resolveSessionCwd()` falls back to immutable creation cwd. `executionDirectoryFromEvents()` resolves detached and historical prefixes. Fork seed bindings remain attributed to their original Session; an explicit fork destination or the selected prefix determines the child's initial directory.

File and search tools, shell and persistent-shell creation, LSP, skills, instructions, file references, hook processes and external subagent directory inheritance use this resolved value. The sandbox canonicalizes the effective directory before applying restrictions, so a host binding supplies the execution boundary and restrictions can only narrow it. Persistence location, Session identity, grouping and ancestry continue to use creation metadata.

Trusted hosts own directory allocation, active-consumer coordination, input-version selection and cleanup. They append and flush the binding before starting effects. Existing processes keep their captured directory until they stop; this capability does not relocate a live shell. Workspace-relative tool resolution changes with the binding, while explicit paths still follow each tool's existing path and sandbox rules. File-reference caches are rebuilt when the directory changes.

This extends [per-Session filesystem resolution](2026-07-02-fs-per-session-cwd.md), preserving caller-owned path resolution, provider independence and canonical filesystem identity. It does not add Git or Product policy to DSH. The [Session contract](../../../../packages/core/session/README.md) owns public usage.

## Alternatives considered

**Rewrite SessionHeader.cwd.** Persisted log locations and immutable creation identity would change with execution; replay and same-id checks would disagree.

**Change only a tool's write path.** Reads, search, shell, instructions and confinement would resolve different trees.

**Keep a volatile directory map only.** Restart would resume a different execution directory without durable evidence of the binding.

**Adopt every inherited directory event.** Forked transcripts would overwrite the child's selected directory with a parent-owned execution binding.

## Consequences

The binding is required-on-read: builds without its event type cannot safely reconstruct execution. Session validates its persisted shape and live owner. A host must preserve referenced resources and coordinate directory changes with active work; this generic event neither creates directories nor authorizes Git cleanup. It also does not map remote filesystem namespaces or rewrite arbitrary absolute paths.

Model context derives the current cwd and sandbox policy through ordinary logged prompt/context assembly. Tool arguments and results retain their existing output formats. Changing a cwd-bearing prompt changes its cache prefix; directory state adds one small durable event per actual binding change.

Core tests cover restore, own-session attribution, invalid paths and post-commit observation. Real filesystem and AgentLoop shell tests verify write/read consistency without changing shared files. The [Loader snapshot](../../../../examples/headless-agent/tests/execution-directory.snapshot.ts) records one Session reading shared input and then using real file, search and shell tools in its recorded execution directory.
