import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { TeamId, TeamMessageId } from '../src/index.ts'
import type { TeamWaitResult } from '../src/index.ts'
import { leadCoordinatorHarness } from './lead-coordinator-harness.ts'

const user = (text: string): UserMessage => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** Team mail as the mailbox delivers it to the Lead. */
async function harness() {
  const test = await leadCoordinatorHarness()
  const notice = (id: string): UserMessage => createUserMessage({ content: [{ type: 'text', text: `Notice ${id}` }],
    source: { kind: 'team-message', teamId: TeamId(test.lead.id), messageId: TeamMessageId(id), senderId: test.lead.id,
      senderName: 'lead' } })
  return { ...test, notice }
}

/** Observe whether a wait settled within a short real-time window. */
async function settledSoon(wait: Promise<TeamWaitResult>): Promise<boolean> {
  let settled = false
  void wait.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  return settled
}

describe('waiting with pending input', () => {
  it('returns at once for a message already waiting for the next step, and leaves it for that step to claim', async () => {
    const test = await harness()
    const notice = test.notice('sealed-1')
    test.lead.inbox.append('next-step', notice)
    await expect(test.ctx.agentTeams.waitForChange(test.lead, 10_000, new AbortController().signal, { pendingInput: true }))
      .resolves.toEqual({ timedOut: false, pendingInput: true })
    expect(test.lead.inbox.nextStep).toEqual([notice])
    // Once the next step has claimed it, a new wait stays until another change.
    test.lead.inbox.remove(notice.id)
    const parked = test.ctx.agentTeams.waitForChange(test.lead, 10_000, new AbortController().signal, { pendingInput: true })
    expect(await settledSoon(parked)).toBe(false)
    await test.ctx.agentTeams.createTask(test.lead, { subject: 'Change', description: 'A Team change ends the wait' })
    await expect(parked).resolves.toEqual({ timedOut: false })
  })

  it('wakes for a message entering the next-step list, including one that arrives while the wait registers', async () => {
    const test = await harness()
    const waiting = test.ctx.agentTeams.waitForChange(test.lead, 10_000, new AbortController().signal, { pendingInput: true })
    expect(await settledSoon(waiting)).toBe(false)
    test.lead.inbox.append('next-step', test.notice('sealed-2'))
    await expect(waiting).resolves.toEqual({ timedOut: false, pendingInput: true })
    test.lead.inbox.clear()
    // The observer registers after the inbox listener and before the first inbox read.
    const removeObserver = test.ctx.agentTeams.installWaitObserver({ watch: () => {
      test.lead.inbox.append('next-step', test.notice('sealed-3'))
      return () => {}
    } })
    await expect(test.ctx.agentTeams.waitForChange(test.lead, 10_000, new AbortController().signal, { pendingInput: true }))
      .resolves.toEqual({ timedOut: false, pendingInput: true })
    removeObserver()
  })

  it('does not end for next-turn input, for a user message, or without the option', async () => {
    const test = await harness()
    const abort = new AbortController()
    const waiting = test.ctx.agentTeams.waitForChange(test.lead, 10_000, abort.signal, { pendingInput: true })
    test.lead.inbox.append('next-turn', test.notice('queued-1'))
    test.lead.inbox.append('next-step', user('A user message keeps its own option'))
    expect(await settledSoon(waiting)).toBe(false)
    await test.ctx.agentTeams.createTask(test.lead, { subject: 'Change', description: 'A Team change ends the wait' })
    await expect(waiting).resolves.toEqual({ timedOut: false })
    await expect(test.ctx.agentTeams.waitForChange(test.lead, 10_000, abort.signal, { userInput: true }))
      .resolves.toEqual({ timedOut: false, userInput: 'next-step' })
    test.lead.inbox.clear()
    test.lead.inbox.append('next-step', test.notice('steer-1'))
    const plain = test.ctx.agentTeams.waitForChange(test.lead, 10_000, abort.signal)
    const userOnly = test.ctx.agentTeams.waitForChange(test.lead, 10_000, abort.signal, { userInput: true })
    expect(await settledSoon(plain)).toBe(false)
    expect(await settledSoon(userOnly)).toBe(false)
    await test.ctx.agentTeams.createTask(test.lead, { subject: 'Another change', description: 'A Team change ends both waits' })
    await expect(Promise.all([plain, userOnly])).resolves.toEqual([{ timedOut: false }, { timedOut: false }])
  })

  it('reports a user message and other pending input together when both options are set', async () => {
    const test = await harness()
    test.lead.inbox.append('next-step', test.notice('sealed-4'))
    test.lead.inbox.append('next-turn', user('Queued question'))
    await expect(test.ctx.agentTeams.waitForChange(test.lead, 10_000, new AbortController().signal,
      { userInput: true, pendingInput: true })).resolves.toEqual({ timedOut: false, userInput: 'next-turn', pendingInput: true })
  })

  it('reads whether pending input would end a wait without reading or claiming it', async () => {
    const test = await harness()
    expect(test.ctx.agentTeams.pendingInputEndsWait(test.lead)).toBe(false)
    test.lead.inbox.append('next-turn', test.notice('queued-2'))
    test.lead.inbox.append('next-step', user('A user message is not pending Team input'))
    expect(test.ctx.agentTeams.pendingInputEndsWait(test.lead)).toBe(false)
    const notice = test.notice('sealed-5')
    test.lead.inbox.append('next-step', notice)
    expect(test.ctx.agentTeams.pendingInputEndsWait(test.lead)).toBe(true)
    expect(test.lead.inbox.nextStep).toEqual([expect.objectContaining({ source: { kind: 'user' } }), notice])
    await test.freeze()
    expect(test.ctx.agentTeams.pendingInputEndsWait(test.lead)).toBe(false)
  })

  it('ignores pending input once a Lead handoff has frozen the Team', async () => {
    const test = await harness()
    test.lead.inbox.append('next-step', test.notice('before-freeze'))
    await test.freeze()
    const abort = new AbortController()
    const waiting = test.ctx.agentTeams.waitForChange(test.lead, 10_000, abort.signal, { pendingInput: true })
    expect(await settledSoon(waiting)).toBe(false)
    test.lead.inbox.append('next-step', test.notice('during-freeze'))
    expect(await settledSoon(waiting)).toBe(false)
    abort.abort(new Error('handoff continues'))
    await expect(waiting).rejects.toThrow('handoff continues')
  })

  it('wakes once the caller can claim the message, or after the confirmation window in any case', async () => {
    const test = await harness()
    const claimable = { value: false }
    vi.spyOn(test.ctx.agents, 'canClaimInput').mockImplementation(() => claimable.value)
    const confirming = test.ctx.agentTeams.waitForChange(test.lead, 10_000, new AbortController().signal, { pendingInput: true })
    test.lead.inbox.append('next-step', test.notice('confirming-1'))
    expect(await settledSoon(confirming)).toBe(false)
    claimable.value = true
    await expect(confirming).resolves.toEqual({ timedOut: false, pendingInput: true })
    claimable.value = false
    vi.useFakeTimers()
    try {
      const late = test.ctx.agentTeams.waitForChange(test.lead, 10_000, new AbortController().signal, { pendingInput: true })
      await vi.advanceTimersByTimeAsync(999)
      expect(await Promise.race([late.then(() => 'settled'), Promise.resolve('pending')])).toBe('pending')
      await vi.advanceTimersByTimeAsync(20)
      await expect(late).resolves.toEqual({ timedOut: false, pendingInput: true })
    } finally {
      vi.useRealTimers()
    }
  })
})
