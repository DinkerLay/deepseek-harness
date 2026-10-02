/** Package-private continuation owners used to place deterministic lifecycle races. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Activation, ContinuableActivationRegistry } from '../src/continuation-activation.ts'
import type SubagentContinuationManager from '../src/continuation.ts'

/** Return the service's bound continuation manager. */
export function continuationManager(ctx: Context): SubagentContinuationManager {
  const manager = (ctx.subagents as unknown as {
    continuations?: SubagentContinuationManager
  }).continuations
  if (manager === undefined) throw new Error('expected a bound continuation manager')
  return manager
}

/** Return the manager's sole process-local Activation owner. */
export function continuationActivations(ctx: Context): ContinuableActivationRegistry {
  return (continuationManager(ctx) as unknown as {
    activations: ContinuableActivationRegistry
  }).activations
}

/** Remove only the registry entry, leaving its Agent live for collision coverage. */
export function dropContinuationActivation(ctx: Context, childId: SessionId): void {
  const registry = continuationActivations(ctx) as unknown as {
    resident: Map<SessionId, Activation>
  }
  registry.resident.delete(childId)
}

/** Invoke the owner's receipt watcher to isolate residency changes before its recheck. */
export async function waitForInputReceipt(ctx: Context, childId: SessionId, messageId: MessageId, signal: AbortSignal): Promise<void> {
  const manager = continuationManager(ctx)
  const wait: unknown = Reflect.get(manager, 'waitForReceiptProgress')
  if (typeof wait !== 'function') throw new Error('expected the continuation receipt watcher')
  const pending: unknown = Reflect.apply(wait, manager, [childId, messageId, signal])
  if (!(pending instanceof Promise)) throw new Error('expected an asynchronous receipt watcher')
  await pending
}
