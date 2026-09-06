/**
 * Fence a real parent cancellation before its child can report or settle.
 * @module subagent-stopped-parent-fence
 */
import type { Context } from '@deepseek-ai/cordis'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'

/** Snapshot-only Loader plugin identity. */
export const name = 'subagent-stopped-parent-fence'
/** Install cancellation and settlement fences in the actual app.
 * @param ctx - Loader-owned snapshot context.
 */
export function apply(ctx: Context): void {
  const parentEnded = Promise.withResolvers<undefined>()
  ctx.on('session/event', (session, event) => {
    if (session.header.parentSession === undefined && event.type === 'turn/end') parentEnded.resolve(undefined)
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    if (agent.session.header.parentSession !== undefined) await parentEnded.promise
    else if (turn === 1 && step === 2) {
      const cwd = agent.session.header.cwd
      if (cwd === undefined) throw new Error('snapshot parent has no cwd')
      writeFileSync(join(cwd, 'parent-ready'), 'ready')
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      signal.throwIfAborted()
    }
    return next()
  })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent.session.header.parentSession === undefined && message.source.kind === 'subagent-settled') {
      const cwd = agent.session.header.cwd
      if (cwd === undefined) throw new Error('snapshot parent has no cwd')
      writeFileSync(join(cwd, 'child-settled'), 'settled')
    }
  })
  ctx.effect(() => () => { parentEnded.resolve(undefined) }, 'stopped-parent-fence')
}
