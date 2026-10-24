---
kind: upgrade-guide
description: "Direct Host calls to interruptByParent now return an asynchronous acknowledgement."
---

# Await direct subagent UI interrupts

English | [中文](guide.zh.md)

## Change

`SubagentRuntime.interruptByParent()` returns `Promise<SubagentInterruptReceipt>` so an optional authenticated Host owner can persist its stop before cancellation. This affects direct TypeScript callers. The browser Remote client already awaits results; its endpoint, arguments and `{ accepted: true }` wire result are unchanged. Model/ancestor `interrupt()` remains synchronous.

## Migration

1. Await direct calls to `interruptByParent()` before reading the receipt, and handle rejected promises instead of synchronous throws.
2. Rebuild plugins against the updated `@deepseek-ai/dsh-subagent` declarations. A successful call resolves to `{ accepted: true }`; it does not promise that cancellation has reached quiescence.
