import { expect, it, vi } from 'vitest'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { nativeHarness, nativeInternals, nativeState } from './native-lifecycle-harness.ts'

it('does not publish a startup failure when an independent receipt lets retirement finish during Preset preflight', async () => {
  const test = await nativeHarness({ script: [textResponse('Actual input completed')], config: { messageRetryDelayMs: 10_000 } })
  const member = await test.spawn('retiring-during-preflight', { presetId: 'reviewer' })
  const acknowledgementEntered = Promise.withResolvers<undefined>()
  const releaseAcknowledgement = Promise.withResolvers<undefined>()
  const preflightEntered = Promise.withResolvers<undefined>()
  const releasePreflight = Promise.withResolvers<undefined>()
  let held: Promise<void> | undefined
  let retry: Promise<boolean> | undefined
  test.ctx.on('session/event', (session, event) => {
    if (session.id === member.member.id && event.type === 'user/message') {
      held = test.ctx.agentTeams.readCompositionLocked(test.lead, async () => {
        acknowledgementEntered.resolve(undefined)
        await releaseAcknowledgement.promise
      })
    }
  })
  const deliver = test.ctx.subagents.deliverContinuableInput.bind(test.ctx.subagents)
  const delivery = vi.spyOn(test.ctx.subagents, 'deliverContinuableInput').mockImplementationOnce(async (...args) => {
    await deliver(...args)
    throw new Error('delivery response lost after target custody')
  })
  try {
    const first = await test.ctx.agentTeams.sendMessage(test.lead, { target: member.member.name,
      content: [{ type: 'text', text: 'First actual work' }], signal: test.signal })
    expect(first.status).toBe('queued')
    await acknowledgementEntered.promise
    await vi.waitFor(() => { expect(test.ctx.agents.get(member.member.id)).toBeUndefined() })
    const acquire = test.ctx.agentPresets.acquireComposition.bind(test.ctx.agentPresets)
    const preflight = vi.spyOn(test.ctx.agentPresets, 'acquireComposition').mockImplementationOnce(async (id) => {
      preflightEntered.resolve(undefined)
      await releasePreflight.promise
      return acquire(id)
    })
    const mailbox = nativeInternals(test.ctx).mailbox
    const original = nativeState(test.ctx, test.lead).messages.find(message => message.id === first.messageId)!
    retry = mailbox.tryDispatch(test.lead, original, test.signal)
    await preflightEntered.promise
    releaseAcknowledgement.resolve(undefined)
    await held
    await vi.waitFor(() => { expect(nativeState(test.ctx, test.lead).delivered).toContain(first.messageId) })
    expect((await test.ctx.agentTeams.retireTeammate(test.lead, member.member.name)).status).toBe('retired')
    await test.removeReviewer?.()
    releasePreflight.resolve(undefined)
    expect(await retry).toBe(false)
    expect(nativeState(test.ctx, test.lead).members[0]?.phase).toBe('retired')
    expect(nativeState(test.ctx, test.lead).messages.some(message => message.id === `team-start-failed-${member.member.id}`)).toBe(false)
    preflight.mockRestore()
  } finally {
    releaseAcknowledgement.resolve(undefined)
    releasePreflight.resolve(undefined)
    await held
    await retry
    delivery.mockRestore()
    vi.restoreAllMocks()
  }
})
