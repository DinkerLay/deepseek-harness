import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { TeamId, TeamMessageId } from '../src/index.ts'
import type { TeamWaitResult } from '../src/index.ts'
import { TeamActivity } from '../src/activity.ts'
import { leadCoordinatorHarness } from './lead-coordinator-harness.ts'

const user = (text: string): UserMessage => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** Observe whether a wait settled within a short real-time window. */
async function settledSoon(wait: Promise<TeamWaitResult>): Promise<boolean> {
  let settled = false
  void wait.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  return settled
}

describe('waiting with user input', () => {
  it('ends the wait for a user message entering the caller\'s own inbox, and returns at once while one is pending', async () => {
    const test = await leadCoordinatorHarness()
    const abort = new AbortController()
    const plain = test.ctx.agentTeams.waitForChange(test.lead, 10_000, abort.signal)
    const waiting = test.ctx.agentTeams.waitForChange(test.lead, 10_000, abort.signal, { userInput: true })
    test.lead.inbox.append('next-turn', createUserMessage({ content: [{ type: 'text', text: 'Teammate note' }],
      source: { kind: 'team-message', teamId: TeamId(test.lead.id), messageId: TeamMessageId('note-1'), senderId: test.lead.id,
        senderName: 'lead' } }))
    expect(await settledSoon(waiting)).toBe(false)
    test.lead.inbox.append('next-turn', user('Where does the work stand?'))
    await expect(waiting).resolves.toEqual({ timedOut: false, userInput: 'next-turn' })
    // A wait without the option still ends only on Team activity.
    expect(await settledSoon(plain)).toBe(false)
    await expect(test.ctx.agentTeams.waitForChange(test.lead, 10_000, abort.signal, { userInput: true }))
      .resolves.toEqual({ timedOut: false, userInput: 'next-turn' })
    test.lead.inbox.append('next-step', user('Use the newer figures'))
    await expect(test.ctx.agentTeams.waitForChange(test.lead, 10_000, abort.signal, { userInput: true }))
      .resolves.toEqual({ timedOut: false, userInput: 'next-step' })
    abort.abort(new Error('test finished'))
    await expect(plain).rejects.toThrow('test finished')
  })

  it('ignores user input once a Lead handoff has frozen the Team, pending or arriving', async () => {
    const test = await leadCoordinatorHarness()
    test.lead.inbox.append('next-turn', user('Queued before the handoff'))
    await test.freeze()
    const abort = new AbortController()
    const waiting = test.ctx.agentTeams.waitForChange(test.lead, 10_000, abort.signal, { userInput: true })
    expect(await settledSoon(waiting)).toBe(false)
    test.lead.inbox.append('next-step', user('Arrives during the freeze'))
    expect(await settledSoon(waiting)).toBe(false)
    abort.abort(new Error('handoff continues'))
    await expect(waiting).rejects.toThrow('handoff continues')
  })

  it('ignores a user message for another agent and still ends on Team activity', async () => {
    const test = await leadCoordinatorHarness()
    const other = await test.create('wait-other-lead', 2)
    const waiting = test.ctx.agentTeams.waitForChange(test.lead, 10_000, new AbortController().signal, { userInput: true })
    other.agent.inbox.append('next-turn', user('For someone else'))
    expect(await settledSoon(waiting)).toBe(false)
    await test.ctx.agentTeams.createTask(test.lead, { subject: 'Change', description: 'A Team change ends the wait' })
    await expect(waiting).resolves.toEqual({ timedOut: false })
  })

  it('validates the wait before answering from pending user input', async () => {
    const test = await leadCoordinatorHarness()
    test.lead.inbox.append('next-turn', user('Pending'))
    await expect(test.ctx.agentTeams.waitForChange(test.lead, 5_000, new AbortController().signal, { userInput: true }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_TIMEOUT' })
    const aborted = new AbortController()
    aborted.abort(new Error('already cancelled'))
    await expect(test.ctx.agentTeams.waitForChange(test.lead, 10_000, aborted.signal, { userInput: true }))
      .rejects.toThrow('already cancelled')
  })

  it('wakes once the caller can claim the new input, or after the confirmation window in any case', async () => {
    const test = await leadCoordinatorHarness()
    const claimable = { value: false }
    vi.spyOn(test.ctx.agents, 'canClaimInput').mockImplementation(() => claimable.value)
    const confirming = test.ctx.agentTeams.waitForChange(test.lead, 10_000, new AbortController().signal, { userInput: true })
    test.lead.inbox.append('next-step', user('Steer while the receipt is confirmed'))
    test.lead.inbox.append('next-step', user('A second steer joins the same confirmation'))
    expect(await settledSoon(confirming)).toBe(false)
    claimable.value = true
    await expect(confirming).resolves.toEqual({ timedOut: false, userInput: 'next-step' })
    test.lead.inbox.clear()
    claimable.value = false
    // A Team change during confirmation ends the wait as Team activity and stops the recheck.
    const changed = test.ctx.agentTeams.waitForChange(test.lead, 10_000, new AbortController().signal, { userInput: true })
    test.lead.inbox.append('next-turn', user('Queued while a Task changes'))
    await test.ctx.agentTeams.createTask(test.lead, { subject: 'Change', description: 'Team activity first' })
    await expect(changed).resolves.toEqual({ timedOut: false })
    vi.useFakeTimers()
    try {
      const late = test.ctx.agentTeams.waitForChange(test.lead, 10_000, new AbortController().signal, { userInput: true })
      await vi.advanceTimersByTimeAsync(999)
      expect(await Promise.race([late.then(() => 'settled'), Promise.resolve('pending')])).toBe('pending')
      await vi.advanceTimersByTimeAsync(20)
      await expect(late).resolves.toEqual({ timedOut: false, userInput: 'next-turn' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a wait whose extra trigger cannot register, leaving later notifications intact', async () => {
    const activity = new TeamActivity()
    const id = TeamId('activity-team')
    await expect(activity.wait(id, 10_000, new AbortController().signal, () => { throw new Error('trigger unavailable') }))
      .rejects.toThrow('trigger unavailable')
    await expect(activity.wait(id, 10_000, new AbortController().signal, () => {
      throw 'closed'
    })).rejects.toMatchObject({ code: 'TEAM_WAIT_ABORTED', message: 'wait_agent trigger failed: closed' })
    const next = activity.wait(id, 10_000, new AbortController().signal)
    activity.notify(id)
    await expect(next).resolves.toEqual({ timedOut: false })
  })
})
