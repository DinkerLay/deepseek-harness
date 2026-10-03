import { SessionId } from '@deepseek-ai/dsh-session'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TeamId, TeamMessageId, type TeamMemberSnapshot, type TeamMessageSnapshot } from '../src/index.ts'
import { teamMessageDeliveryBytes } from '../src/mailbox.ts'
import { nativeHarness, nativeInternals, nativeState } from './native-lifecycle-harness.ts'

afterEach(() => { vi.restoreAllMocks() })

function notice(id: string, targetId = SessionId('native-lifecycle-lead')): TeamMessageSnapshot {
  return { id: TeamMessageId(id), senderId: SessionId('native-lifecycle-lead'), senderName: 'lead', targetId,
    content: [{ type: 'text', text: 'durable lifecycle notice' }] }
}

describe('native mailbox custody', () => {
  it('keeps held Lead input queued and reuses its identity until non-waking preload is confirmed', async () => {
    const test = await nativeHarness()
    test.policy.admission = 'hold'
    const message = notice('held-team-input')
    await test.queue(message)
    const mailbox = nativeInternals(test.ctx).mailbox
    expect(await mailbox.tryDispatch(test.lead, message, test.signal)).toBe(false)
    expect(await mailbox.tryDispatch(test.lead, message, test.signal)).toBe(false)
    const custody = test.ctx.agents.inputControlState(test.lead.session).records
      .filter(record => record.input.message.source.kind === 'team-message')
    expect(custody).toHaveLength(1)
    expect(custody[0]?.input).toMatchObject({ target: 'next-step', wakeup: true })
    expect(test.lead.inbox.nextStep).toEqual([])
    expect(nativeState(test.ctx, test.lead).delivered).toEqual([])
    await test.controller.preload(test.lead, custody[0]!.input)
    expect(await mailbox.tryDispatch(test.lead, message, test.signal)).toBe(true)
    expect(nativeState(test.ctx, test.lead).delivered).toEqual([message.id])
    expect(test.lead.inbox.nextStep).toEqual([custody[0]!.input.message])
    expect(test.adapter.requests).toEqual([])
    expect(test.lead.session.snapshotEvents().filter(event => event.type === 'agent/input/held')).toHaveLength(1)
  })

  it.each(['false', 'throw'] as const)('retains uncertain Lead custody after flush %s and checkpoints without reinsertion', async (failure) => {
    const test = await nativeHarness()
    const message = notice(`uncertain-${failure}`)
    await test.queue(message)
    const mailbox = nativeInternals(test.ctx).mailbox
    const flush = vi.spyOn(test.ctx.sessions, 'flush')
    if (failure === 'false') flush.mockResolvedValueOnce(false)
    else flush.mockRejectedValueOnce(new Error('target checkpoint unavailable'))
    expect(await mailbox.tryDispatch(test.lead, message, test.signal)).toBe(false)
    expect(nativeState(test.ctx, test.lead).delivered).toEqual([])
    expect(test.lead.inbox.nextStep).toHaveLength(1)
    flush.mockRestore()
    expect(await mailbox.tryDispatch(test.lead, message, test.signal)).toBe(true)
    expect(test.lead.inbox.nextStep).toHaveLength(1)
    expect(nativeState(test.ctx, test.lead).delivered).toEqual([message.id])
    expect(test.adapter.requests).toEqual([])
  })

  it('retries one rejected target on a clock, emits one durable exhaustion notice, and preserves the original mail', async () => {
    const test = await nativeHarness({ script: [textResponse('first work')], config: { messageRetryDelayMs: 20, maxMessageRetries: 1 } })
    const member = await test.spawn('retry-worker', { presetId: 'reviewer' })
    await test.ctx.agentTeams.sendMessage(test.lead, { target: member.member.name,
      content: [{ type: 'text', text: 'First work' }], signal: test.signal })
    await vi.waitFor(() => { expect(test.ctx.agents.get(member.member.id)).toBeUndefined() })
    await test.removeReviewer?.()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const message = notice('retry-original', member.member.id)
    await test.queue(message)
    const mailbox = nativeInternals(test.ctx).mailbox
    expect(await mailbox.tryDispatch(test.lead, message, test.signal)).toBe(false)
    expect(await mailbox.tryDispatch(test.lead, message, test.signal)).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(20)
    await Promise.all(mailbox.pendingDispatches())
    const id = TeamMessageId(`team-start-incomplete-${message.id}`)
    expect(nativeState(test.ctx, test.lead).messages.filter(item => item.id === id)).toHaveLength(1)
    expect(nativeState(test.ctx, test.lead).delivered).toContain(id)
    expect(nativeState(test.ctx, test.lead).delivered).not.toContain(message.id)
    expect(await mailbox.tryDispatch(test.lead, message, test.signal)).toBe(false)
    await Promise.all(mailbox.pendingDispatches())
    expect(nativeState(test.ctx, test.lead).messages.filter(item => item.id === id)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains an exhaustion-notice persistence failure and retries the same notice identity', async () => {
    const test = await nativeHarness({ script: [textResponse('first work')], config: { messageRetryDelayMs: 20, maxMessageRetries: 1 } })
    const member = await test.spawn('retry-worker', { presetId: 'reviewer' })
    await test.ctx.agentTeams.sendMessage(test.lead, { target: member.member.name,
      content: [{ type: 'text', text: 'First work' }], signal: test.signal })
    await vi.waitFor(() => { expect(test.ctx.agents.get(member.member.id)).toBeUndefined() })
    await test.removeReviewer?.()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const message = notice('retry-checkpoint-failure', member.member.id)
    await test.queue(message)
    const mailbox = nativeInternals(test.ctx).mailbox
    expect(await mailbox.tryDispatch(test.lead, message, test.signal)).toBe(false)
    const flush = test.ctx.sessions.flush.bind(test.ctx.sessions)
    let failed = false
    vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (!failed && session === test.lead.session
        && nativeState(test.ctx, test.lead).messages.some(item => item.id === `team-start-incomplete-${message.id}`)) {
        failed = true
        throw new Error('notification checkpoint unavailable')
      }
      return flush(session)
    })
    const warning = vi.spyOn(test.ctx.logger, 'warn')
    await vi.advanceTimersByTimeAsync(20)
    await Promise.all(mailbox.pendingDispatches())
    expect(warning.mock.calls.some(call => String(call[0]).includes('Team delivery retry notification failed'))).toBe(true)
    expect(await mailbox.tryDispatch(test.lead, message, test.signal)).toBe(false)
    await Promise.all(mailbox.pendingDispatches())
    const id = TeamMessageId(`team-start-incomplete-${message.id}`)
    expect(nativeState(test.ctx, test.lead).messages.filter(item => item.id === id)).toHaveLength(1)
    expect(nativeState(test.ctx, test.lead).delivered).toContain(id)
  })

  it('does not retry through a detached Lead identity and clears pending timers on runtime disposal', async () => {
    const test = await nativeHarness({ config: { messageRetryDelayMs: 20 } })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const mailbox = nativeInternals(test.ctx).mailbox
    const service = test.ctx.agentTeams
    const first = notice('detached-retry')
    test.policy.rejectMessageId = first.id
    await test.queue(first)
    expect(await mailbox.tryDispatch(test.lead, first, test.signal)).toBe(false)
    await test.leadHandle.dispose()
    await vi.advanceTimersByTimeAsync(20)
    expect(mailbox.pendingDispatches()).toEqual([])
    expect(test.ctx.agents.get(test.lead.id)).toBeUndefined()
    await test.fiber.dispose()
    mailbox.scheduleRetry(test.lead, first)
    expect(vi.getTimerCount()).toBe(0)
    expect(await mailbox.tryDispatch(test.lead, first, test.signal)).toBe(false)
    await expect(service.cancelPendingMessages(test.lead, 'anything', 'closed'))
      .rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
  })

  it('does not mark an already-started member failed when its Preset disappears before mailbox acknowledgement', async () => {
    const test = await nativeHarness({ script: ['hang'] })
    const member = await test.spawn('started-reviewer', { presetId: 'reviewer', group: 'reviewers' })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let held: Promise<void> | undefined
    test.ctx.on('session/event', (session, event) => {
      if (session.id === member.member.id && event.type === 'user/message') {
        held = test.ctx.agentTeams.readCompositionLocked(test.lead, async () => {
          entered.resolve(undefined)
          await release.promise
        })
      }
    })
    const deliver = test.ctx.subagents.deliverContinuableInput.bind(test.ctx.subagents)
    vi.spyOn(test.ctx.subagents, 'deliverContinuableInput').mockImplementationOnce(async (...args) => {
      await deliver(...args)
      throw new Error('response lost after child custody')
    })
    try {
      const first = await test.ctx.agentTeams.sendMessage(test.lead, {
        target: member.member.name, content: [{ type: 'text', text: 'First actual work' }], signal: test.signal,
      })
      expect(first.status).toBe('queued')
      await entered.promise
      const child = test.ctx.agents.get(member.member.id)!
      expect(test.ctx.sessionProjections.stateOf(child.session, 'subagentInputReceipts')?.length).toBeGreaterThan(0)
      await test.removeReviewer?.()
      const mailbox = nativeInternals(test.ctx).mailbox
      expect(await mailbox.tryDispatch(test.lead, nativeState(test.ctx, test.lead).messages[0]!, test.signal)).toBe(false)
      expect(nativeState(test.ctx, test.lead).members[0]?.phase).toBe('active')
      expect(nativeState(test.ctx, test.lead).messages.some(item => item.id === `team-start-failed-${member.member.id}`)).toBe(false)
      expect(child.session.snapshotEvents().some(event => event.type === 'subagent/descriptor')).toBe(true)
    } finally {
      release.resolve(undefined)
      await held
      await Promise.all(nativeInternals(test.ctx).mailbox.pendingDispatches())
    }
  })

  it('bounds the complete first input independently of ordinary message bytes', async () => {
    const sizing = await nativeHarness()
    const sized = await sizing.spawn('limit-worker')
    const prototype = { ...notice(`team-message-${'a'.repeat(36)}`, sized.member.id),
      content: [{ type: 'text' as const, text: 'ordinary' }] }
    const limit = teamMessageDeliveryBytes(prototype, nativeState(sizing.ctx, sizing.lead))
    expect(limit).toBeGreaterThan(teamMessageDeliveryBytes(prototype))
    const test = await nativeHarness({ script: [textResponse('accepted')], config: { maxMessageBytes: limit } })
    const member = await test.spawn('limit-worker')
    await expect(test.ctx.agentTeams.sendMessage(test.lead, {
      target: member.member.name, content: [{ type: 'text', text: 'ordinaryx' }], signal: test.signal,
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_TOO_LARGE' })
    expect(nativeState(test.ctx, test.lead).messages).toEqual([])
    expect((await test.ctx.agentTeams.sendMessage(test.lead, {
      target: member.member.name, content: prototype.content, signal: test.signal,
    })).status).toBe('accepted')
  })

  it('keeps non-text content as facts and preserves supplied sender attribution in controlled notices', async () => {
    const test = await nativeHarness({ script: [textResponse('received facts'), textResponse('legacy facts'), textResponse('later facts')] })
    const member = await test.spawn('attributed-worker')
    const message = { ...notice('attributed-notice', member.member.id), content: [{ type: 'reasoning' as const, text: 'reference facts' }],
      contentParts: ['sender' as const] }
    await test.queue(message)
    expect(await nativeInternals(test.ctx).mailbox.tryDispatch(test.lead, message, test.signal)).toBe(true)
    const stored = await test.ctx.sessionPersistence.open(member.member.id, 'read')
    try {
      const input = (await stored.read()).events.find(event => event.type === 'user/message')
      expect(input?.data).toMatchObject({ source: { kind: 'team-message', contentParts: ['fact', 'fact', 'sender'] } })
    } finally {
      await stored.close()
    }
    const legacy = { ...notice('legacy-facts', member.member.id), content: [{ type: 'text' as const, text: 'Legacy facts' }] }
    await test.queue(legacy)
    expect(await nativeInternals(test.ctx).mailbox.tryDispatch(test.lead, legacy, test.signal)).toBe(true)
    const legacyStored = await test.ctx.sessionPersistence.open(member.member.id, 'read')
    try {
      const input = (await legacyStored.read()).events.find(event => event.type === 'user/message'
        && event.data.source.kind === 'team-message' && event.data.source.messageId === legacy.id)
      expect(input?.data).toMatchObject({ source: { kind: 'team-message', contentParts: ['fact', 'fact'] } })
    } finally {
      await legacyStored.close()
    }
    expect((await test.ctx.agentTeams.sendMessage(test.lead, { target: member.member.name,
      content: [{ type: 'reasoning', text: 'later facts' }], signal: test.signal })).status).toBe('accepted')
  })

  it('reclaims cancelled mailbox capacity, excludes cancelled dispatch, and refuses a late acknowledgement', async () => {
    const test = await nativeHarness({ script: [textResponse('restored provider')], config: { maxPendingMessagesPerMember: 1 } })
    const member = await test.spawn('capacity-worker')
    await test.spawnFiber.dispose()
    const first = await test.ctx.agentTeams.sendMessage(test.lead, { target: member.member.name,
      content: [{ type: 'text', text: 'Await provider' }], signal: test.signal })
    expect(first.status).toBe('queued')
    await expect(test.ctx.agentTeams.sendMessage(test.lead, { target: member.member.name,
      content: [{ type: 'text', text: 'Mailbox full' }], signal: test.signal })).rejects.toMatchObject({ code: 'TEAM_MAILBOX_FULL' })
    expect(await test.ctx.agentTeams.cancelPendingMessages(test.lead, member.member.name, 'Superseded input')).toEqual([first.messageId])
    await test.ctx.plugin(Spawn, { providerName: 'spawn' })
    const second = await test.ctx.agentTeams.sendMessage(test.lead, { target: member.member.name,
      content: [{ type: 'text', text: 'Replacement input' }], signal: test.signal })
    expect(second.status).toBe('accepted')
    const mailbox = nativeInternals(test.ctx).mailbox
    await mailbox.markDelivered(test.lead, first.messageId, member.member.id)
    expect(nativeState(test.ctx, test.lead).delivered).not.toContain(first.messageId)
    expect(nativeState(test.ctx, test.lead).delivered).toContain(second.messageId)
  })

  it('keeps ordinary message bytes independent of task-notice and startup limits', async () => {
    const sizing = await nativeHarness()
    const member = await sizing.spawn('ordinary-worker')
    const prototype = { ...notice(`team-message-${'a'.repeat(36)}`, member.member.id),
      content: [{ type: 'text' as const, text: 'é' }] }
    const ordinary = teamMessageDeliveryBytes(prototype)
    const test = await nativeHarness({ script: [textResponse('accepted ordinary')], config: { controlledMode: {
      kind: 'controlled', requiredTaskExtensionId: 'lifecycle-writer', permissionTableId: 'table',
      permissionRevision: 'revision', maxOrdinaryMessageBytes: ordinary,
    } } })
    const target = await test.spawn('ordinary-worker')
    await expect(test.ctx.agentTeams.sendMessage(test.lead, { target: target.member.name,
      content: [{ type: 'text', text: 'éx' }], signal: test.signal })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_TOO_LARGE' })
    expect((await test.ctx.agentTeams.sendMessage(test.lead, { target: target.member.name,
      content: prototype.content, signal: test.signal })).status).toBe('accepted')
  })

  it.each(['missing-preset', 'missing-registry', 'changed-revision'] as const)('records startup failure for a registered member with %s', async (kind) => {
    const test = await nativeHarness({ presets: kind !== 'missing-registry' })
    let member: Pick<TeamMemberSnapshot, 'id' | 'name'>
    if (kind === 'changed-revision') {
      const registered = await test.spawn('invalid-startup', { presetId: 'reviewer' })
      member = registered.member
      await test.removeReviewer?.()
      const plugin = new URL('../../../subagent/subagent-in-process-driver/tests/fixtures/plugins/preset-tool.js', import.meta.url).href
      await test.ctx.agentPresets.register({ id: 'reviewer', plugins: [{ name: plugin, config: { tool: 'changed-tool' } }] })
    } else {
      const row = { id: SessionId('invalid-startup'), name: 'invalid-startup', description: 'Recovery fixture',
        provider: 'spawn', context: 'fresh' as const, phase: 'provisioning' as const,
        ...kind === 'missing-preset' ? {} : { preset: { id: 'reviewer', revision: 'a'.repeat(64) } } }
      test.lead.session.append('team/member/configured', { version: 3, teamId: TeamId(test.lead.id), member: row })
      test.lead.session.append('team/member/configured', { version: 3, teamId: TeamId(test.lead.id), member: { ...row, phase: 'active' } })
      member = row
    }
    const sent = await test.ctx.agentTeams.sendMessage(test.lead, { target: member.name,
      content: [{ type: 'text', text: 'First work' }], signal: test.signal })
    expect(sent.status).toBe('queued')
    expect(nativeState(test.ctx, test.lead).members[0]?.phase).toBe('failed')
    expect(await test.ctx.sessionPersistence.stat(member.id)).toBeUndefined()
    expect(nativeState(test.ctx, test.lead).messages.some(item => item.id === `team-start-failed-${member.id}`)).toBe(true)
  })
})
