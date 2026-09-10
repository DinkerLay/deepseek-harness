# Agent Note: Retained memory and workspace interactions

Status: implemented

English | [中文](2026-09-10-retained-memory-and-workspace-interactions.zh.md)

## Problem

Released Product Sessions contain versioned memory and retry provenance. Frozen source validation rejects those ordinary conversations. Workspace consumers also need explicit Markdown file navigation and terminal resize without replacing native rendering or subprocess ownership.

## Decision

Adjacent migrations admit only the released local-memory snapshot descriptor and version-one user retry descriptor. Memory content, message identity and source generations remain intact. Local retry endpoints follow each stage's coordinate map; captures of another Session remain unchanged. Unknown descriptor versions and unrelated source fields still fail. Persistence retains predecessor files and publishes a successor only after validation.

Markdown callers may supply a file-link resolver. Approved destinations render callback buttons; ordinary links retain URL sanitization, and no resolver means no local-file navigation. Subprocess terminal handles expose resize in both local node-pty and E2B providers. E2B tracks resize with other in-flight operations so termination waits for quiescence.

## Alternatives considered

**Discarding provenance** loses retry identity and memory revocation information. **Allowing arbitrary source fields** hides unsupported protocols. **DOM rewriting** conflicts with React ownership. **Resizing only the terminal emulator** leaves the shell wrapping to stale dimensions.

## Consequences

The fork retains a narrow released-data compatibility delta and two reusable UI/process capabilities. Product still owns file authorization, icon design, panel placement and retry presentation. None of these changes enables experimental orchestration or rewrites a predecessor generation.
