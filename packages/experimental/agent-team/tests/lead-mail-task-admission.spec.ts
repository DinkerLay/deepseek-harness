/** Actual Lead receivers recheck durable Task scheduling before cancellation, acknowledgement and input custody. */
import type { Agent, AgentInput } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { TeamId, TeamMessageId, TeamTaskId } from '../src/index.ts'
import type { TeamLeadDeliveryReceipt, TeamMessageSnapshot } from '../src/index.ts'
import { leadMailHarness } from './lead-mail-harness.ts'
import { facadeControlledMode } from './native-facade-harness.ts'

type Harness = Awaited<ReturnType<typeof leadMailHarness>>

/** This registered writer associates only its exact durable queued notice, not text or a name prefix. */
function taskWriter(test: Harness, noticeId: string) {
  const taskId = TeamTaskId('task-1')
  const messageId = TeamMessageId(noticeId)
  const unavailable = async (): Promise<never> => { throw new Error('model Task commands are outside this receiver fixture') }
  const writer = test.ctx.agentTeams.installTaskExtension({ id: facadeControlledMode.requiredTaskExtensionId,
    requireDurableAcknowledgement: true, create: unavailable, update: unavailable,
    classifyInput: (_anchor, input: AgentInput) => {
      const source = input.message.source
      if (source.kind !== 'team-message' || source.teamId !== TeamId(test.lead.id) || source.messageId !== messageId) return undefined
      const recorded = test.state().messages.find(message => message.id === source.messageId)
      return recorded?.senderId === source.senderId ? { taskId, current: true } : undefined
    },
  })
  const create = (caller: Agent) => writer.commit(caller, () => ({ updates: [{ previousRevision: null,
    task: { id: taskId, revision: 1, subject: 'Lead-owned work', description: 'Receiver must obey actual scheduling facts',
      status: 'in_progress', ownerId: test.lead.id, blockedBy: [], writeScopes: [] } }], dataJson: '{}' }))
  const block = (caller: Agent) => writer.commit(caller, (snapshot) => {
    const task = snapshot.tasks.find(task => task.id === taskId)
    if (task === undefined) throw new Error('the actual native Task must exist')
    return { updates: [{ previousRevision: task.revision, task: { ...task, revision: task.revision + 1, dispatchBlocked: true } }], dataJson: '{}' }
  })
  return { writer, create, block, taskId, messageId }
}

/** A persisted legacy queue is legitimate recovery input; every sender is a real bound Lead execution. */
async function queued(test: Harness, sender: Agent, id: string): Promise<TeamMessageSnapshot> {
  const message: TeamMessageSnapshot = { id: TeamMessageId(id), senderId: sender.id, senderName: 'lead', targetId: test.lead.id,
    content: [{ type: 'text', text: `Formal queued work ${id}` }], contentParts: ['fact'] }
  test.lead.session.append('team/message/queued', { version: 2, teamId: TeamId(test.lead.id), message })
  expect(await test.ctx.sessions.flush(test.lead.session)).toBe(true)
  return message
}

it('cancels a durably queued obsolete Lead assignment before creating any recipient custody or receipt', async () => {
  const test = await leadMailHarness()
  const work = taskWriter(test, 'lead-precheck-obsolete')
  try {
    test.readiness.ready = true
    await work.create(test.lead)
    await work.block(test.lead)
    test.readiness.ready = false
    const message = await queued(test, test.lead, work.messageId)
    await expect(test.owner.preloadLeadMail(test.lead, { executionId: test.lead.id, term: 1 }))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_ANCHOR_INVALID' })
    expect(test.state().cancelled).toContainEqual({ messageId: message.id, targetId: test.lead.id, reason: 'Task work input is no longer schedulable' })
    expect(test.state().leadDeliveries).toBeUndefined()
    expect(test.lead.inbox.nextStep).toEqual([])
    expect(test.ctx.agents.inputControlState(test.lead.session).records).toEqual([])
    using stored = await test.ctx.sessionQuery.observeSession(test.lead.id)
    expect(stored.events.filter(event => event.type === 'team/message/cancelled' && event.data.messageIds.includes(message.id))).toHaveLength(1)
    expect(await test.owner.preloadLeadMail(test.lead, { executionId: test.lead.id, term: 1 })).toEqual([])
    expect(test.adapter.requests).toHaveLength(0)
  } finally { work.writer.dispose(); await test.owner.dispose() }
})

it('does not confirm or preload an unacknowledged native queue item and delivers it once after explicit confirmation', async () => {
  const test = await leadMailHarness()
  const work = taskWriter(test, 'unused-association')
  const id = TeamMessageId('lead-unconfirmed-ordinary')
  const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
  let failing = true
  const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (failing && session.id === test.lead.id && test.state().messages.some(message => message.id === id)) return false
    return await original(session)
  })
  try {
    test.readiness.ready = true
    await expect(work.writer.commitRecord(test.lead, () => ({ recordId: 'unconfirmed-Lead-item', dataJson: '{}', notices: [{
      id, senderId: test.lead.id, senderName: 'lead', targetId: test.lead.id,
      content: [{ type: 'text', text: 'Ordinary coordination must keep its unconfirmed queue' }], contentParts: ['fact'],
    }] }))).rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
    test.readiness.ready = false
    const calls = checkpoint.mock.calls.length
    await expect(test.owner.preloadLeadMail(test.lead, { executionId: test.lead.id, term: 1 }))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_ANCHOR_INVALID' })
    expect(checkpoint).toHaveBeenCalledTimes(calls)
    expect(test.state().cancelled).toEqual([])
    expect(test.state().leadDeliveries).toBeUndefined()
    expect(test.lead.inbox.nextStep).toEqual([])
    expect(test.ctx.agents.inputControlState(test.lead.session).records).toEqual([])
    failing = false
    await work.writer.read(test.lead, () => undefined)
    expect(await test.owner.preloadLeadMail(test.lead, { executionId: test.lead.id, term: 1 })).toEqual([
      { messageId: id, targetId: test.lead.id, executionId: test.lead.id, term: 1 },
    ])
    expect(test.lead.inbox.nextStep).toHaveLength(1)
    expect(test.state().leadDeliveries).toHaveLength(1)
    expect(await test.owner.preloadLeadMail(test.lead, { executionId: test.lead.id, term: 1 })).toHaveLength(1)
    expect(test.lead.inbox.nextStep).toHaveLength(1)
    expect(test.state().leadDeliveries).toHaveLength(1)
    expect(test.adapter.requests).toHaveLength(0)
  } finally { checkpoint.mockRestore(); work.writer.dispose(); await test.owner.dispose() }
})

it('rejects work under the final Team lock when a real Task pause wins during cold recipient resolution', async () => {
  const test = await leadMailHarness()
  const current = await test.create('lead-final-admission-current', 2)
  await test.commit(current, 1)
  const work = taskWriter(test, 'lead-final-admission-work')
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  const original = test.provider.resolveExecution?.bind(test.provider)
  if (original === undefined) throw new Error('the fixture must have its actual owned restoration provider')
  let live: Agent | undefined
  let delivery: Promise<readonly TeamLeadDeliveryReceipt[]> | undefined
  try {
    test.readiness.ready = true
    await work.create(current.agent)
    test.readiness.ready = false
    const message = await queued(test, current.agent, work.messageId)
    await current.dispose()
    await test.replaceProvider({ resolveExecution: async (id, signal) => {
      entered.resolve(undefined); await resume.promise
      return await original(id, signal)
    } })
    delivery = test.owner.preloadLeadMail(test.lead, { executionId: current.agent.id, term: 2 })
    const rejected = expect(delivery).rejects.toMatchObject({ code: 'TEAM_LEAD_ANCHOR_INVALID' })
    await entered.promise
    // Restore through the real Preset/descriptor owner; the pending mail still owns target-local order.
    live = await original(current.agent.id, new AbortController().signal)
    test.readiness.ready = true
    await work.block(live)
    resume.resolve(undefined)
    await rejected
    expect(live.inbox.nextStep).toEqual([])
    expect(test.ctx.agents.inputControlState(live.session).records).toEqual([])
    expect(test.state().leadDeliveries?.some(receipt => receipt.messageId === message.id)).not.toBe(true)
    expect(test.adapter.requests).toHaveLength(0)
    await test.owner.preloadLeadMail(test.lead, { executionId: current.agent.id, term: 2 })
    expect(test.state().cancelled).toContainEqual({ messageId: message.id, targetId: test.lead.id, reason: 'Task work input is no longer schedulable' })
    using stored = await test.ctx.sessionQuery.observeSession(live.id)
    expect(stored.events.some(event => event.type === 'user/message' && event.data.source.kind === 'team-message'
      && event.data.source.messageId === message.id)).toBe(false)
  } finally {
    resume.resolve(undefined); await delivery?.catch(() => undefined)
    work.writer.dispose(); await test.owner.dispose()
  }
})
