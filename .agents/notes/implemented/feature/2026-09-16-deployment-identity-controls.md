# Agent Note: Deployment identity controls

Status: implemented

English | [中文](2026-09-16-deployment-identity-controls.zh.md)

## Problem

Downstream products need their own instruction-path labels, MCP client identity, and shell environment facts without changing Harness storage identities or copying service implementations.

## Decision

The instruction loader accepts `userGlobalDisplayPath` while discovery retains an explicit logical directory for the global file. Baseline state and subsequent reconciliation keep the existing `user-global` scope. Display configuration participates in baseline identity so a resumed session can replace an obsolete label through normal logged context updates.

MCP clients accept `clientInfo` for both transports and every reconnect generation. Omission retains the Harness client identity. The shell environment registry accepts `includeBuiltins`, defaulting to true; disabling it omits only registry-owned facts. Explicit contributors retain ownership and disposal. Shell tool descriptions do not prescribe a deployment namespace.

The [single home resolver](../architecture/2026-07-24-single-harness-home-resolver.md) and [MCP client design](2026-07-07-mcp-client-plugin.md) remain authoritative for path resolution and transport lifecycle. Products select their branding through configuration and existing environment contributions.

## Alternatives considered

Globally renaming packages, environment constants, or the home resolver would change unrelated consumers and historical identities. A separate brand service would add a cross-package dependency for three independently configurable consumers. Both are unnecessary for the current deployment requirements.

## Consequences

Defaults remain compatible. No Session format or persisted scope-key migration is introduced. Tests cover custom global labels, stable scope identity, omitted built-ins, contributor disposal, and custom MCP identity across reconnects.
