import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PendingToolCall } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { InterruptedToolQuery } from '@deepseek-ai/dsh-agent'

const sessionId = SessionId('interrupted-owner-session')

function call(id: string, name: string, started = true): PendingToolCall {
  return { callId: ToolCallId(id), name, arguments: '{}', started }
}

async function registry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  return ctx
}

describe('interrupted tool owners', () => {
  it('asks only the owner of each started call and leaves other calls without an outcome', async () => {
    const ctx = await registry()
    const resolve = vi.fn((_query: InterruptedToolQuery, _signal: AbortSignal) => Promise.resolve({ kind: 'absent' as const }))
    ctx.agents.registerInterruptedToolOwner({ tools: ['owned_write'], resolve })
    const outcomes = await ctx.agents.interruptedToolOutcomes(sessionId, [],
      [call('owned', 'owned_write'), call('unstarted', 'owned_write', false), call('other', 'other_write')],
      new AbortController().signal)
    expect([...outcomes]).toEqual([[ToolCallId('owned'), { kind: 'absent' }]])
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0]?.[0]).toEqual({ sessionId, events: [], call: call('owned', 'owned_write') })
  })

  it('keeps a failed owner report unknown, but propagates resume cancellation', async () => {
    const ctx = await registry()
    ctx.agents.registerInterruptedToolOwner({ tools: ['owned_write'], resolve: () => Promise.reject(new Error('log read failed')) })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- an owner may reject with a non-Error value.
    ctx.agents.registerInterruptedToolOwner({ tools: ['other_write'], resolve: () => Promise.reject('store offline') })
    const outcomes = await ctx.agents.interruptedToolOutcomes(sessionId, [],
      [call('owned', 'owned_write'), call('other', 'other_write')], new AbortController().signal)
    expect(outcomes.size).toBe(0)
    const aborted = new AbortController()
    aborted.abort(new Error('resume cancelled'))
    await expect(ctx.agents.interruptedToolOutcomes(sessionId, [], [call('owned', 'owned_write')], aborted.signal))
      .rejects.toThrow('resume cancelled')
  })

  it('refuses a second owner for the same tool and forgets an owner once its registration is disposed', async () => {
    const ctx = await registry()
    const fiber = await ctx.plugin({ name: 'owner-fixture', inject: ['agents'], apply: (scope: Context) => {
      scope.effect(() => scope.agents.registerInterruptedToolOwner({ tools: ['owned_write'],
        resolve: () => Promise.resolve({ kind: 'recorded', text: 'done' }) }))
    } })
    expect(() => ctx.agents.registerInterruptedToolOwner({ tools: ['owned_write'], resolve: () => Promise.resolve({ kind: 'absent' }) }))
      .toThrow('interrupted tool outcome already owned: owned_write')
    await fiber.dispose()
    const outcomes = await ctx.agents.interruptedToolOutcomes(sessionId, [], [call('owned', 'owned_write')], new AbortController().signal)
    expect(outcomes.size).toBe(0)
    const remove = ctx.agents.registerInterruptedToolOwner({ tools: ['owned_write'], resolve: () => Promise.resolve({ kind: 'absent' }) })
    remove()
    const replacement = ctx.agents.registerInterruptedToolOwner({ tools: ['owned_write'], resolve: () => Promise.resolve({ kind: 'absent' }) })
    // A stale disposer never removes a later owner of the same tool.
    remove()
    expect(await ctx.agents.interruptedToolOutcomes(sessionId, [], [call('owned', 'owned_write')], new AbortController().signal))
      .toEqual(new Map([[ToolCallId('owned'), { kind: 'absent' }]]))
    replacement()
  })
})
