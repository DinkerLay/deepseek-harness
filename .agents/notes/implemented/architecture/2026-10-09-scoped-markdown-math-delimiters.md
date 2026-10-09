# Agent Note: Scoped Markdown math delimiters

Status: implemented

English | [中文](2026-10-09-scoped-markdown-math-delimiters.zh.md)

## Problem

Single-dollar TeX can consume currency-bearing prose between two dollar signs, including Chinese text and Markdown emphasis. Streaming renders use GFM without math, so a readable financial paragraph can become a formula only when it settles. Other Markdown owners rely on native `$x$` syntax.

## Decision

[UI primitives](../../../../packages/client/ui-primitives/README.md#component-catalog) owns `MarkdownMathProvider`, a pure React scope with an explicit `singleDollarTextMath` boolean. Without a provider, single-dollar math remains enabled. The nearest provider selects the preference for each renderer, independently of parallel views and navigation callbacks. `markdownMathOptionsVersion` identifies this public capability.

Settled Markdown passes the preference to the existing micromark math extension. False leaves single-dollar sequences as ordinary Markdown while retaining backslash delimiters, double-dollar math and math fences. A changed preference invalidates the settled render for the same source text. Streaming keeps its existing GFM parser and frozen-block cache; formulas still render only after settlement.

The browser shell statically seeds the UI-primitives namespace. The [fork ledger](../../../../fork-manifest.json) therefore records `@deepseek-ai/dsh-web-frontend` as a rebuilt artifact at `apps/web`, with UI primitives as its input. Packing runs `build:web` before collecting the frontend `dist`. Source changes and generated-artifact dependencies remain separate, and the Provider shares the exact instance used by the native Markdown renderer.

## Alternatives considered

**Disable single-dollar math globally.** This changes mathematical documents whose authors rely on the native default.

**Guess whether each dollar sign denotes currency.** Financial notation and mathematical expressions overlap. Explicit owner policy avoids inference from model wording.

**Escape dollar signs in stored messages.** This changes source content and replay-visible text to implement a presentation preference.

**Load a second primitives library at runtime.** Its React Context would not control a Markdown renderer using the shell's preloaded instance. Rebuilding the static shell preserves one shared namespace.

## Consequences

Currency-oriented owners choose false and use explicit TeX delimiters for formulas. The provider does not rewrite Session text, change typography or navigation, or enable trusted TeX commands. Focused tests cover exact monetary text, emphasis, explicit math, provider isolation, same-text changes, frozen streaming blocks and settlement. Installed-browser acceptance also checks the public version and actual currency rendering; source tests alone do not establish that the browser received the rebuilt namespace.
