# Agent Note: Provider-owned prompt provenance

Status: implemented

English | [中文](2026-09-16-provider-owned-prompt-provenance.zh.md)

## Problem

The Agent Loop stamped one built-in package name onto every system prompt and runtime-context snapshot. Replacing the public systemPrompt provider could therefore produce records naming a provider that did not own the active deployment. A label change also affects restoration because runtime-context ownership is recovered from durable source metadata.

## Decision

SystemPrompt exposes source identity version 1, `sourcePlugin`, and immutable `legacySourcePlugins`. Configuration supplies the current package identity and the explicit previous identities accepted during restoration. Defaults preserve the native package name and no aliases. The loop captures the selected provider's identity for its system and runtime-context projections.

System prompt reconciliation publishes a normal surface replacement when the provider changes, even if text is identical. Runtime contexts recognize configured legacy snapshots but publish the current source once before suppressing identical updates. Foreign snapshots remain unowned. No committed event or migration generation is rewritten, and new messages remain reconstructable from the Session log.

Sandbox guidance accepts a deployment `runtimeName`, defaulting to DSH; permissions and escalation behavior are unchanged. Product packages select their own provider, persona, and environment instructions through composition.

## Alternatives considered

A frontend alias would display a different producer from the one recorded in the log. Copying the Agent Loop into a Product package would duplicate persistence and execution semantics. Changing a source constant without historical ownership handling would lose snapshot restoration and could duplicate or fail to clear context. Provider-owned identity preserves one implementation and an explicit restoration rule.

## Consequences

Consumers that recognize prompt-originated data accept the current provider and their supported historical identities. The public capability version lets downstream providers reject an older runtime before serving requests. Tests cover native defaults, actual loop-emitted provenance, same-text provider changes, legacy restoration, foreign-source isolation, and unchanged permission semantics.
