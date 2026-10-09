# Agent Note: Scoped Markdown syntax preferences

Status: implemented

English | [中文](2026-10-09-scoped-markdown-math-delimiters.zh.md)

## Problem

Single-dollar TeX can consume currency-bearing prose between two dollar signs, including Chinese text and Markdown emphasis. Streaming renders use GFM without math, so a readable financial paragraph can become a formula only when it settles. Single-tilde deletion can also consume text and citations between numeric ranges while streaming or after settlement. Other Markdown owners rely on native `$x$` and `~text~` syntax.

## Decision

[UI primitives](../../../../packages/client/ui-primitives/README.md#component-catalog) owns `MarkdownSyntaxProvider`, a pure React scope with explicit `singleDollarTextMath` and `singleTildeStrikethrough` booleans. Both default to true outside a provider. The nearest provider selects the preferences independently of parallel views and navigation callbacks. `markdownSyntaxOptionsVersion` identifies this public capability. The compatible Math provider retains its version and changes only dollar syntax, inheriting the enclosing tilde preference through the same React Context.

Both rendering arms pass the tilde preference to the existing GFM extension. False preserves numeric ranges while explicit double-tilde deletion remains enabled. Settled Markdown also passes the dollar preference to the existing math extension; false preserves currency while retaining backslash delimiters, double-dollar math and math fences. Changed preferences invalidate the settled render for the same source text. Tilde changes rebuild the frozen streaming grammar; dollar-only changes retain it. Formulas still render only after settlement.

The browser shell statically seeds the UI-primitives namespace. The [fork ledger](../../../../fork-manifest.json) therefore records `@deepseek-ai/dsh-web-frontend` as a rebuilt artifact at `apps/web`, with UI primitives as its input. Packing runs `build:web` before collecting the frontend `dist`. Source changes and generated-artifact dependencies remain separate, and the Provider shares the exact instance used by the native Markdown renderer.

## Alternatives considered

**Disable single-character syntax globally.** This changes documents whose authors rely on native mathematical or deletion syntax.

**Infer punctuation from model wording.** Financial notation overlaps mathematical and deletion syntax. Explicit owner preferences avoid guessing which numeric span is literal.

**Escape punctuation in stored messages.** This changes source content and replay-visible text to implement a presentation preference.

**Load a second primitives library at runtime.** Its React Context would not control a Markdown renderer using the shell's preloaded instance. Rebuilding the static shell preserves one shared namespace.

## Consequences

Financial prose owners choose false for both preferences, using explicit TeX delimiters for formulas and double tildes for deletion. The provider does not rewrite Session text, change typography or navigation, or enable trusted TeX commands. Tests cover currency, numeric ranges, citations, explicit syntax, old-provider compatibility, parallel views, same-text changes and frozen streaming grammar. Installed-browser acceptance checks the public version and actual rendering; source tests alone do not establish that the browser received the rebuilt namespace.
