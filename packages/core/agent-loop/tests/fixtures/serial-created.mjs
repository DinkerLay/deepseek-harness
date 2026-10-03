/** Awaited creation context shared by TypeScript and Python SDK snapshots. */
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'

export const name = 'serial-created-fixture'
export const inject = ['agents']

/** Install ordered creation listeners whose context must precede the first turn. */
export function apply(ctx) {
  const ready = new WeakSet()
  ctx.on('agent/created', async ({ agent }) => {
    await setImmediate()
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: 'Serial agent creation completed.' }],
      source: { kind: `plugin:${name}` },
    }
    const receipt = ctx.agents.sendInput(agent, { message, target: 'next-step', wakeup: false })
    if (receipt !== undefined) await receipt
    ready.add(agent)
  })
  ctx.on('agent/created', ({ agent }) => {
    if (!ready.has(agent)) throw new Error('creation listeners ran out of order')
  })
}
