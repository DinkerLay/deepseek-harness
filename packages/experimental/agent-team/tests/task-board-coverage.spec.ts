import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import { SubagentRunId, type SubagentSettlementNoticeFacts } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import { TeamId, TeamMessageId, TeamTaskId } from '../src/index.ts'
import type { TeamExtensionNotice, TeamTaskExtension, TeamTaskSnapshot, TeamTaskTransactionUpdate } from '../src/index.ts'
import { facadeControlledMode, nativeFacadeHarness } from './native-facade-harness.ts'
import { leadMailHarness } from './lead-mail-harness.ts'

function task(id = 'task-1', extra: Partial<TeamTaskSnapshot> = {}): TeamTaskSnapshot {
  return { id: TeamTaskId(id), revision: 1, subject: 'verified Task', description: 'transaction fixture',
    status: 'pending', blockedBy: [], writeScopes: [], ...extra }
}

function extension(id = 'coverage-writer', extra: Partial<TeamTaskExtension> = {}): TeamTaskExtension {
  const unavailable = async (): Promise<never> => { throw new Error('Task policy is outside this commit test') }
  return { id, create: unavailable, update: unavailable, ...extra }
}

function state(test: Awaited<ReturnType<typeof nativeFacadeHarness>>) {
  const value = test.ctx.sessionProjections.stateOf(test.lead.session, 'agentTeam')
  if (value === undefined || value.failure !== undefined) throw new Error('fixture requires a valid Team projection')
  return value
}

function writes(test: Awaited<ReturnType<typeof nativeFacadeHarness>>) {
  return test.lead.session.snapshotEvents().filter(event => event.type === 'team/task/transaction' || event.type === 'team/extension')
}

async function locked(test: Awaited<ReturnType<typeof nativeFacadeHarness>>) {
  const entered = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  const barrier = test.ctx.agentTeams.readCompositionLocked(test.lead, async () => {
    entered.resolve(undefined)
    await finish.promise
  })
  await entered.promise
  return { finish, barrier }
}

describe('native Task Board transaction boundaries', () => {
  it('keeps a replacement writer installed when the old disposer repeats and reads only current release hints', async () => {
    const test = await nativeFacadeHarness()
    expect(test.ctx.agentTeams.releaseHints(test.lead)).toEqual([])
    const first = test.ctx.agentTeams.installTaskExtension(extension('first-writer'))
    expect(test.ctx.agentTeams.releaseHints(test.lead)).toEqual([])
    first.dispose()
    const replacement = test.ctx.agentTeams.installTaskExtension(extension('replacement-writer', {
      releaseHints: caller => [`Tasks remain on ${caller.id}`],
    }))
    first.dispose()
    expect(test.ctx.agentTeams.releaseHints(test.lead)).toEqual([`Tasks remain on ${test.lead.id}`])
    expect(await replacement.commitRecord(test.lead, () => ({ recordId: 'replacement-active', dataJson: '{}' })))
      .toEqual({ recordId: 'replacement-active', committed: true })
    expect(state(test).extensionRecords[0]?.writerId).toBe('replacement-writer')
    replacement.dispose()
    expect(test.ctx.agentTeams.releaseHints(test.lead)).toEqual([])
  })

  it('passes detached locked composition to both Task and record planners', async () => {
    const test = await nativeFacadeHarness()
    await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'lock' }))
    const writer = test.ctx.agentTeams.installTaskExtension(extension())
    await writer.commit(test.lead, (snapshot) => {
      expect(snapshot.composition).toEqual({ phase: 'fixed' })
      if (snapshot.composition === undefined) throw new Error('fixed composition was not passed to the Task planner')
      Object.assign(snapshot.composition, { phase: 'dynamic' })
      return { updates: [{ previousRevision: null, task: task() }], dataJson: '{}' }
    })
    await writer.commitRecord(test.lead, (snapshot) => {
      expect(snapshot.composition).toEqual({ phase: 'fixed' })
      if (snapshot.composition === undefined) throw new Error('fixed composition was not passed to the record planner')
      Object.assign(snapshot.composition, { phase: 'dynamic' })
      return { recordId: 'fixed-board-record', dataJson: '{}' }
    })
    expect(test.ctx.agentTeams.composition(test.lead)).toEqual({ phase: 'fixed' })
    expect(writes(test)).toHaveLength(2)
    writer.dispose()
  })

  it('excludes cancelled notices from pending limits and stamps only sender-authored controlled text', async () => {
    const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode, maxPendingMessagesPerMember: 1 } })
    const controller = test.ctx.agents.registerInputController(InputControllerId('task-notice-custody'), {
      admit: () => ({ kind: 'hold' }), canStart: () => false, canClaim: () => false,
      initialize: (session) => { controller.bind(session) },
    })
    const writer = test.ctx.agentTeams.installTaskExtension(extension(facadeControlledMode.requiredTaskExtensionId, {
      validateMemberGroup: () => {},
    }))
    const { member } = await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'notice-custodian', description: 'holds pending notices',
      group: 'readers', presetId: 'reviewer', context: 'fresh', provider: 'spawn', prompt: [], signal: new AbortController().signal })
    const notice = (id: string): TeamExtensionNotice => ({ id: TeamMessageId(id), senderId: test.lead.id,
      senderName: 'lead', targetId: member.id, content: [{ type: 'text', text: 'verified result' }, { type: 'text', text: 'external fact' }],
      contentParts: ['sender', 'fact'] })
    await writer.commitRecord(test.lead, () => ({ recordId: 'cancelled-notice-record', dataJson: '{}',
      notices: [notice('cancelled-task-notice')] }))
    expect(await test.ctx.agentTeams.cancelPendingMessages(test.lead, member.name, 'superseded notice'))
      .toEqual([TeamMessageId('cancelled-task-notice')])
    await writer.commitRecord(test.lead, () => ({ recordId: 'replacement-notice-record', dataJson: '{}',
      notices: [notice('replacement-task-notice')] }))
    expect(state(test).messages[1]?.contentAuthors).toEqual([{ executionId: test.lead.id, term: 1 }, null])
    expect(state(test).messages[1]?.senderTerm).toBe(1)
    await expect(writer.commitRecord(test.lead, () => ({ recordId: 'overflow-notice-record', dataJson: '{}',
      notices: [notice('overflow-task-notice')] }))).rejects.toMatchObject({ code: 'TEAM_MAILBOX_FULL' })
    expect(state(test).extensionRecords.map(record => record.recordId)).toEqual(['cancelled-notice-record', 'replacement-notice-record'])
    expect(state(test).cancelled).toEqual([{ messageId: TeamMessageId('cancelled-task-notice'), targetId: member.id, reason: 'superseded notice' }])
    expect(test.adapter.requests).toHaveLength(0)
    writer.dispose()
  })

  it('preserves a real non-domain graph failure without committing any oversized deep-DAG update', async () => {
    const test = await nativeFacadeHarness()
    const writer = test.ctx.agentTeams.installTaskExtension(extension())
    const count = 15_000
    const updates: TeamTaskTransactionUpdate[] = Array.from({ length: count }, (_, index) => ({
      previousRevision: null,
      task: task(`task-${index + 1}`, { blockedBy: index + 1 === count ? [] : [TeamTaskId(`task-${index + 2}`)] }),
    }))
    await expect(writer.commit(test.lead, () => ({ updates, dataJson: '{}' }))).rejects.toBeInstanceOf(RangeError)
    expect(test.ctx.agentTeams.listTasks(test.lead)).toEqual([])
    expect(writes(test)).toEqual([])
    writer.dispose()
  })

  it('refuses extension installation and Task commits after runtime closure', async () => {
    const test = await nativeFacadeHarness()
    const service = test.ctx.agentTeams
    const writer = service.installTaskExtension(extension())
    await test.fiber.dispose()
    expect(() => service.installTaskExtension(extension('late-writer')))
      .toThrow(expect.objectContaining({ code: 'TEAM_DISPOSED' }))
    await expect(writer.commit(test.lead, () => ({ updates: [], dataJson: '{}' })))
      .rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
    await expect(writer.commitRecord(test.lead, () => ({ recordId: 'late', dataJson: '{}' })))
      .rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    expect(writes(test)).toEqual([])
  })

  it('does not let the default writer update a controlled Task after its product writer leaves', async () => {
    const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode } })
    test.lead.session.append('team/task', { version: 2, teamId: TeamId(test.lead.id), task: task() })
    await test.ctx.sessions.flush(test.lead.session)
    await expect(test.ctx.agentTeams.updateTask(test.lead, { taskId: TeamTaskId('task-1'), expectedRevision: 1,
      action: 'edit', subject: 'bypass product policy' })).rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    expect(test.ctx.agentTeams.getTask(test.lead, TeamTaskId('task-1')).subject).toBe('verified Task')
    expect(writes(test)).toEqual([])
  })

  it.each(['Task', 'record'] as const)('rechecks the installed writer after a queued %s commit acquires the lock', async (kind) => {
    const test = await nativeFacadeHarness()
    const writer = test.ctx.agentTeams.installTaskExtension(extension())
    const gate = await locked(test)
    const build = vi.fn(() => ({ updates: [{ previousRevision: null, task: task() }], dataJson: '{}' }))
    const record = vi.fn(() => ({ recordId: 'queued-record', dataJson: '{}' }))
    const pending = kind === 'Task' ? writer.commit(test.lead, build) : writer.commitRecord(test.lead, record)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    writer.dispose()
    gate.finish.resolve(undefined)
    await gate.barrier
    await rejected
    expect(build).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
    expect(writes(test)).toEqual([])
  })

  it.each(['Task', 'record'] as const)('rechecks runtime closure after a queued %s commit acquires the lock', async (kind) => {
    const test = await nativeFacadeHarness()
    const writer = test.ctx.agentTeams.installTaskExtension(extension())
    const gate = await locked(test)
    const pending = kind === 'Task'
      ? writer.commit(test.lead, () => ({ updates: [{ previousRevision: null, task: task() }], dataJson: '{}' }))
      : writer.commitRecord(test.lead, () => ({ recordId: 'queued-record', dataJson: '{}' }))
    const rejected = expect(pending).rejects.toMatchObject({ code: kind === 'Task' ? 'TEAM_DISPOSED' : 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    await test.fiber.dispose()
    gate.finish.resolve(undefined)
    await gate.barrier
    await rejected
    expect(writes(test)).toEqual([])
  })

  it.each(['Task', 'record'] as const)('rejects a %s writer whose id differs from the durable controlled mode', async (kind) => {
    const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode } })
    const writer = test.ctx.agentTeams.installTaskExtension(extension())
    const pending = kind === 'Task'
      ? writer.commit(test.lead, () => ({ updates: [{ previousRevision: null, task: task() }], dataJson: '{}' }))
      : writer.commitRecord(test.lead, () => ({ recordId: 'wrong-writer', dataJson: '{}' }))
    await expect(pending).rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    expect(writes(test)).toEqual([])
    writer.dispose()
  })

  it.each([{ existingTaskIds: [] }, { existingTaskIds: [TeamTaskId('task-1'), TeamTaskId('task-1')] }])(
    'requires distinct nonempty existing ids: $existingTaskIds', async ({ existingTaskIds }) => {
      const test = await nativeFacadeHarness()
      const writer = test.ctx.agentTeams.installTaskExtension(extension())
      await expect(writer.commit(test.lead, () => ({ existingTaskIds }))).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
      expect(writes(test)).toEqual([])
      writer.dispose()
    },
  )

  it('does not let a writer return an existing Task owned by the default native writer', async () => {
    const test = await nativeFacadeHarness()
    const native = await test.ctx.agentTeams.createTask(test.lead, { subject: 'native Task', description: 'not extension-owned' })
    const writer = test.ctx.agentTeams.installTaskExtension(extension())
    await expect(writer.commit(test.lead, () => ({ existingTaskIds: [native.id] })))
      .rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    expect(test.ctx.agentTeams.getTask(test.lead, native.id).subject).toBe('native Task')
    expect(writes(test)).toEqual([])
    writer.dispose()
  })

  const rejectedBatches: { name: string; code: string; updates: TeamTaskTransactionUpdate[] }[] = [
    { name: 'empty', code: 'TEAM_INVALID_ARGUMENT', updates: [] },
    { name: 'duplicate', code: 'TEAM_INVALID_ARGUMENT', updates: [{ previousRevision: null, task: task() }, { previousRevision: null, task: task() }] },
    { name: 'wrong numeric id', code: 'TEAM_TASK_LIMIT', updates: [{ previousRevision: null, task: task('task-2') }] },
    { name: 'noninitial revision', code: 'TEAM_INVALID_ARGUMENT', updates: [{ previousRevision: null, task: task('task-1', { revision: 2 }) }] },
    { name: 'stale revision', code: 'TEAM_TASK_STALE_REVISION', updates: [{ previousRevision: 1, task: task('task-1', { revision: 2 }) }] },
    { name: 'missing prerequisite', code: 'TEAM_TASK_NOT_FOUND', updates: [{ previousRevision: null, task: task('task-1', { blockedBy: [TeamTaskId('task-404')] }) }] },
    { name: 'duplicate prerequisite', code: 'TEAM_INVALID_ARGUMENT', updates: [{ previousRevision: null, task: task() },
      { previousRevision: null, task: task('task-2', { blockedBy: [TeamTaskId('task-1'), TeamTaskId('task-1')] }) }] },
    { name: 'dependency cycle', code: 'TEAM_TASK_DEPENDENCY_CYCLE', updates: [{ previousRevision: null, task: task('task-1', { blockedBy: [TeamTaskId('task-2')] }) },
      { previousRevision: null, task: task('task-2', { blockedBy: [TeamTaskId('task-1')] }) }] },
    { name: 'missing in-progress owner', code: 'TEAM_INVALID_ARGUMENT', updates: [{ previousRevision: null, task: task('task-1', { status: 'in_progress' }) }] },
    { name: 'missing owner', code: 'TEAM_MEMBER_NOT_FOUND', updates: [{ previousRevision: null, task: task('task-1', { ownerId: SessionId('absent-owner') }) }] },
  ]
  it.each(rejectedBatches)('rejects $name without appending an atomic Task event', async ({ code, updates }) => {
    const test = await nativeFacadeHarness()
    const writer = test.ctx.agentTeams.installTaskExtension(extension())
    await expect(writer.commit(test.lead, () => ({ updates, dataJson: '{}' }))).rejects.toMatchObject({ code })
    expect(test.ctx.agentTeams.listTasks(test.lead)).toEqual([])
    expect(writes(test)).toEqual([])
    writer.dispose()
  })

  it('enforces the active Task count on one atomic batch', async () => {
    const test = await nativeFacadeHarness({ config: { maxTasks: 1 } })
    const writer = test.ctx.agentTeams.installTaskExtension(extension())
    await expect(writer.commit(test.lead, () => ({ dataJson: '{}', updates: [
      { previousRevision: null, task: task() }, { previousRevision: null, task: task('task-2') },
    ] }))).rejects.toMatchObject({ code: 'TEAM_TASK_LIMIT' })
    expect(test.ctx.agentTeams.listTasks(test.lead)).toEqual([])
    expect(writes(test)).toEqual([])
    writer.dispose()
  })

  it('does not assign a new Task to a retired roster member', async () => {
    const test = await nativeFacadeHarness()
    const member = { id: SessionId('retired-task-owner'), name: 'retired-owner', description: 'retired owner',
      provider: 'spawn', context: 'fresh' as const, phase: 'provisioning' as const }
    test.lead.session.append('team/member', { version: 2, teamId: TeamId(test.lead.id), member })
    test.lead.session.append('team/member', { version: 2, teamId: TeamId(test.lead.id), member: { ...member, phase: 'active' } })
    await test.ctx.sessions.flush(test.lead.session)
    await test.ctx.agentTeams.retireTeammate(test.lead, member.name)
    const writer = test.ctx.agentTeams.installTaskExtension(extension())
    await expect(writer.commit(test.lead, () => ({ dataJson: '{}', updates: [
      { previousRevision: null, task: task('task-1', { ownerId: member.id, status: 'in_progress' }) },
    ] }))).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    expect(state(test).members[0]?.phase).toBe('retired')
    expect(writes(test)).toEqual([])
    writer.dispose()
  })

  it('validates record identity, JSON, byte limits and idempotent existing/skip results', async () => {
    const test = await nativeFacadeHarness({ config: { maxTaskExtensionBytes: 8 } })
    const writer = test.ctx.agentTeams.installTaskExtension(extension())
    expect(await writer.commitRecord(test.lead, () => ({ skip: true }))).toEqual({ recordId: '', committed: false })
    await expect(writer.commitRecord(test.lead, () => ({ existingRecordId: 'missing-record' })))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(writer.commitRecord(test.lead, () => ({ recordId: 'large-record', dataJson: '123456789' })))
      .rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_TOO_LARGE' })
    await expect(writer.commitRecord(test.lead, () => ({ recordId: 'malformed-record', dataJson: 'no-json' })))
      .rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_INVALID' })
    expect(writes(test)).toEqual([])
    expect(await writer.commitRecord(test.lead, () => ({ recordId: 'once', dataJson: '{}' })))
      .toEqual({ recordId: 'once', committed: true })
    expect(await writer.commitRecord(test.lead, () => ({ existingRecordId: 'once' })))
      .toEqual({ recordId: 'once', committed: false })
    await expect(writer.commitRecord(test.lead, () => ({ recordId: 'once', dataJson: '{}' })))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    expect(state(test).extensionRecords).toEqual([{ writerId: 'coverage-writer', recordId: 'once', dataJson: '{}' }])
    expect(writes(test)).toHaveLength(1)
    writer.dispose()
  })

  it.each(['duplicate batch', 'duplicate persisted', 'inactive target', 'missing target', 'bytes'] as const)(
    'rejects %s notices without committing their record', async (failure) => {
      const test = await nativeFacadeHarness({ config: { maxMessageBytes: 512 } })
      const writer = test.ctx.agentTeams.installTaskExtension(extension())
      const base: TeamExtensionNotice = { id: TeamMessageId('record-notice'), senderId: test.lead.id,
        senderName: 'lead', targetId: test.lead.id, content: [{ type: 'text', text: 'read-only notice' }] }
      let proposed: TeamExtensionNotice[]
      let code: string
      if (failure === 'duplicate batch') { proposed = [base, base]; code = 'TEAM_INVALID_ARGUMENT' }
      else if (failure === 'duplicate persisted') {
        await writer.commitRecord(test.lead, () => ({ recordId: 'first-notice', dataJson: '{}', notices: [base] }))
        proposed = [base]; code = 'TEAM_INVALID_ARGUMENT'
      } else if (failure === 'bytes') {
        proposed = [{ ...base, content: [{ type: 'text', text: 'x'.repeat(600) }] }]; code = 'TEAM_MESSAGE_TOO_LARGE'
      } else {
        const id = SessionId('unavailable-notice-target')
        if (failure === 'inactive target') {
          test.lead.session.append('team/member', { version: 2, teamId: TeamId(test.lead.id), member: {
            id, name: 'inactive-target', description: 'not yet active', provider: 'spawn', context: 'fresh', phase: 'provisioning',
          } })
          await test.ctx.sessions.flush(test.lead.session)
        }
        proposed = [{ ...base, targetId: id }]; code = 'TEAM_MEMBER_NOT_FOUND'
      }
      const before = writes(test).length
      await expect(writer.commitRecord(test.lead, () => ({ recordId: 'invalid-notice', dataJson: '{}', notices: proposed })))
        .rejects.toMatchObject({ code })
      expect(writes(test)).toHaveLength(before)
      expect(state(test).extensionRecords.some(record => record.recordId === 'invalid-notice')).toBe(false)
      writer.dispose()
    },
  )

  it('lets a missing or mismatched controlled settlement writer abstain without altering default wording', async () => {
    const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode } })
    const member = { id: SessionId('settlement-member'), name: 'settlement-member', description: 'flushed child',
      provider: 'spawn', context: 'fresh' as const, phase: 'provisioning' as const }
    test.lead.session.append('team/member', { version: 2, teamId: TeamId(test.lead.id), member })
    await test.ctx.sessions.flush(test.lead.session)
    const facts: SubagentSettlementNoticeFacts = { runId: SubagentRunId('settlement-activation'),
      parentSessionId: test.lead.id, childSessionId: member.id, stopReason: 'completed',
      startSeq: SessionLogOffset(0), endSeq: SessionLogOffset(0), parentStartSeq: SessionLogOffset(0), events: [], firstInputOnly: true }
    expect(await test.policy(facts)).toEqual({ action: 'send', subject: 'Teammate settlement-member' })
    const wrong = test.ctx.agentTeams.installTaskExtension(extension())
    expect(await test.policy(facts)).toEqual({ action: 'send', subject: 'Teammate settlement-member' })
    wrong.dispose()
    const matching = test.ctx.agentTeams.installTaskExtension(extension(facadeControlledMode.requiredTaskExtensionId))
    expect(await test.policy(facts)).toEqual({ action: 'send', subject: 'Teammate settlement-member' })
    matching.dispose()
  })

  it.each(['Task', 'record'] as const)('rejects the original root identity after a queued %s caller follows its resumed anchor', async (kind) => {
    const test = await leadMailHarness()
    const root = await test.ctx.agents.create({ sessionId: SessionId(`task-lock-root-${kind}`),
      agentOptions: { provider: 'mock', model: 'mock' } })
    await test.owner.prepareAnchor(root.agent)
    await using composition = await test.ctx.agentPresets.acquireComposition('reviewer')
    if (composition.revision === undefined) throw new Error('fixture requires its real Preset revision')
    const current = await test.owner.create(root.agent, { sessionId: SessionId(`task-lock-execution-${kind}`),
      term: 2, presetId: composition.id, revision: composition.revision, agentOptions: { provider: 'mock', model: 'mock' } })
    root.agent.session.append('team/lead/transaction', { version: 1, teamId: TeamId(root.agent.id), previousTerm: 1,
      binding: { executionId: current.agent.id, term: 2, presetId: composition.id, revision: composition.revision },
      extension: { id: facadeControlledMode.requiredTaskExtensionId, dataJson: '{}' }, releases: [] })
    await test.ctx.sessions.flush(root.agent.session)
    test.readiness.ready = true
    const writer = test.ctx.agentTeams.installTaskExtension(extension(facadeControlledMode.requiredTaskExtensionId))
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const barrier = test.ctx.agentTeams.readCompositionLocked(current.agent, async () => {
      entered.resolve(undefined)
      await finish.promise
    })
    await entered.promise
    const pending = kind === 'Task'
      ? writer.commit(current.agent, () => ({ updates: [{ previousRevision: null, task: task() }], dataJson: '{}' }))
      : writer.commitRecord(current.agent, () => ({ recordId: 'old-root', dataJson: '{}' }))
    const rejected = expect(pending).rejects.toMatchObject({ code: kind === 'Task' ? 'TEAM_NOT_MEMBER' : 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    await root.dispose()
    const resumed = await test.ctx.agents.resume({ resumeSessionId: root.agent.id, agentOptions: { provider: 'mock', model: 'mock' } })
    try {
      expect(test.ctx.agentTeams.membership(current.agent).root).toBe(resumed.agent)
      finish.resolve(undefined)
      await barrier
      await rejected
      expect(resumed.agent.session.snapshotEvents().filter(event => event.type === 'team/task/transaction' || event.type === 'team/extension')).toEqual([])
    } finally { finish.resolve(undefined); writer.dispose(); await current.dispose(); await resumed.dispose(); await test.owner.dispose() }
  })
})
