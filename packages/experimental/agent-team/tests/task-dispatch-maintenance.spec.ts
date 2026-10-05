/** Task dispatchability over the actual native controllers, Loader, driver and JSONL. */
import type { AgentInput, AgentHandle, InputControllerHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { TeamExecutionMaintenanceScope, TeamTaskId as TaskId,
  TeamTaskSnapshot, LeadExecutionHandle, TeamMessageId as MailId } from '../src/index.ts'
import { TeamId, TeamTaskId, TeamMessageId, TeamLeadOperationId } from '../src/index.ts'
import { nativeFacadeHarness, facadeControlledMode } from './native-facade-harness.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { TeamJournal } from '../src/journal.ts'
import { maintainExecution } from '../src/execution-maintenance.ts'

const signal = new AbortController().signal
const text = (value: string) => [{ type: 'text' as const, text: value }]
const gate = () => Promise.withResolvers<undefined>()

async function setup(script: NonNullable<Parameters<typeof nativeFacadeHarness>[0]>['script'] = [],
  maxTaskExtensionBytes?: number) {
  let leadOwner: LeadExecutionHandle | undefined
  let removeMemberPreset: (() => Promise<void>) | undefined
  const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode, messageRetryDelayMs: 5,
    ...maxTaskExtensionBytes === undefined ? {} : { maxTaskExtensionBytes } }, script,
  beforeLead: async (ctx) => {
    removeMemberPreset = await ctx.agentPresets.register({ id: 'task-maintenance-preset', plugins: [] })
    leadOwner = ctx.agentTeams.installLeadExecutions({ isReady: () => true, resolveAnchor: async (id) => {
      const anchor = ctx.agents.get(id)
      if (anchor === undefined) throw new Error('fixture anchor is not resident')
      return anchor
    } })
  } })
  if (leadOwner === undefined || removeMemberPreset === undefined) throw new Error('native owners did not initialize')
  await leadOwner.prepareAnchor(test.lead)
  vi.spyOn(test.ctx.sessionQuery, 'observeSession').mockImplementation((id, options) =>
    SessionQuery.prototype.observeSession.call(test.ctx.sessionQuery, id, options))
  const associations = new Map<MailId, { taskId: TaskId; current: boolean }>()
  const unavailable = async (): Promise<never> => { throw new Error('model Task commands are outside this fixture') }
  const extension = { id: facadeControlledMode.requiredTaskExtensionId, requireDurableAcknowledgement: true,
    create: unavailable, update: unavailable, validateMemberGroup: () => undefined,
    classifyInput: (anchor: import('@deepseek-ai/dsh-agent').Agent, input: AgentInput) => {
      if (input.message.source.kind !== 'team-message') return undefined
      const association = associations.get(input.message.source.messageId)
      if (association === undefined) return undefined
      const obsolete = test.ctx.sessionProjections.stateOf(anchor.session, 'agentTeam')?.extensionRecords.some(record =>
        record.writerId === facadeControlledMode.requiredTaskExtensionId
        && record.dataJson === JSON.stringify({ obsoleteInputId: input.message.id }))
      return { ...association, current: association.current && obsolete !== true }
    } }
  let writer = test.ctx.agentTeams.installTaskExtension(extension)
  const memberOwner = test.ctx.agentTeams.installMemberExecutions({ id: 'task-maintenance-member-owner' })
  const member = (await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'shared-worker', context: 'fresh',
    provider: 'spawn', presetId: 'task-maintenance-preset', prompt: text('Registration is not work'), signal })).member
  const tasks: TeamTaskSnapshot[] = [1, 2].map(number => ({ id: TeamTaskId(`task-${number}`), revision: 1,
    subject: `Work ${number}`, description: 'independent shared execution work', status: 'in_progress',
    ownerId: member.id, blockedBy: [], writeScopes: [] }))
  await writer.commit(test.lead, () => ({ updates: tasks.map(task => ({ previousRevision: null, task })), dataJson: '{}' }))
  const taskId = (index = 0) => {
    const id = tasks[index]?.id
    if (id === undefined) throw new Error('fixture Task index is absent')
    return id
  }
  const setBlocked = async (index = 0, blocked = true) => {
    await writer.commit(test.lead, (snapshot) => {
      const task = snapshot.tasks.find(task => task.id === taskId(index))
      if (task === undefined) throw new Error('fixture Task disappeared')
      const { dispatchBlocked: _old, ...ordinary } = task
      return { updates: [{ previousRevision: task.revision, task: { ...ordinary, revision: task.revision + 1,
        ...blocked ? { dispatchBlocked: true as const } : {} } }], dataJson: '{}' }
    })
  }
  const work = (id: string, index = 0, target: AgentInput['target'] = 'next-step', wakeup = false): AgentInput => {
    const messageId = TeamMessageId(id)
    associations.set(messageId, { taskId: taskId(index), current: true })
    return { message: Object.freeze({ ...createUserMessage({ content: text(id), source: { kind: 'team-message',
      teamId: TeamId(test.lead.id), messageId, senderId: test.lead.id, senderName: 'lead' } }), id: MessageId(id) }), target, wakeup }
  }
  const ordinary = (id: string, target: AgentInput['target'] = 'next-step', wakeup = false): AgentInput => ({
    message: createUserMessage({ content: text(id), source: { kind: 'user' } }), target, wakeup })
  let live: AgentHandle | undefined
  const resident = async () => {
    if (member.preset === undefined) throw new Error('member Preset is absent')
    await test.ctx.subagents.prepareContinuable({ childId: member.id, provider: 'spawn',
      label: 'shared-worker', preset: member.preset, request: { parent: test.lead }, signal })
    live = await test.ctx.agents.resume({ resumeSessionId: member.id, agentOptions: { provider: 'mock', model: 'mock' },
      setup: async (scoped) => {
        const presets = scoped.get('agentPresets')
        if (presets === undefined) throw new Error('fixture Preset registry is absent')
        await presets.mount(scoped, 'task-maintenance-preset')
      } })
    onTestFinished(async () => { await live?.dispose() })
    return live.agent
  }
  const target = { kind: 'member' as const, memberId: member.id, executionId: member.id, generation: 1 }
  return { ...test, member, memberOwner, leadOwner, removeMemberPreset, tasks, taskId, associations,
    setBlocked, work, ordinary, resident, target,
    get writer() { return writer },
    replaceWriter: () => { writer.dispose(); writer = test.ctx.agentTeams.installTaskExtension(extension); return writer },
    closeResident: async () => { await live?.dispose(); live = undefined } }
}

describe('native Task dispatch maintenance', () => {
  it.each([undefined, 8])('validates generic JSON against the configured byte budget %s without IO, acknowledgement or publication', async (limit) => {
    const test = await setup([], limit)
    const bytes = limit ?? 262144, before = test.lead.session.seq
    const flush = vi.spyOn(test.ctx.sessions, 'flush'), notified = vi.spyOn(test.ctx, 'emit')
    test.writer.validateDataJson('null')
    test.writer.validateDataJson(`"${'a'.repeat(bytes - 2)}"`)
    expect(() =>{  test.writer.validateDataJson(`"${'a'.repeat(bytes - 1)}"`) }).toThrow(/exceeds/)
    expect(() =>{  test.writer.validateDataJson('not JSON') }).toThrow(/valid JSON/)
    if (limit !== undefined) expect(() =>{  test.writer.validateDataJson('"🙂🙂"') }).toThrow(/exceeds/)
    expect(test.lead.session.seq).toBe(before)
    expect(flush).not.toHaveBeenCalled(); expect(notified).not.toHaveBeenCalled()
    const old = test.writer
    test.replaceWriter()
    expect(() =>{  old.validateDataJson('{}') }).toThrow(/unavailable/)
    test.writer.validateDataJson('{}')
    flush.mockRestore(); notified.mockRestore()
  })
  it('retains verified never-created absence and rejects unknown selected custody rather than inventing input', async () => {
    const test = await setup()
    await test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
      expect(scope.source).toBe('absent'); expect(scope.read()).toBeUndefined()
      expect(await scope.capture()).toEqual([])
      expect(await scope.capture([])).toEqual([])
      await scope.restore([]); await scope.release([])
    })
    await expect(test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
      await scope.release([MessageId('no-source-input')])
    })).rejects.toThrow(/disposition was not confirmed/)
    await expect(test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
      await scope.capture([MessageId('no-source-input')])
    })).rejects.toThrow(/disposition was not confirmed/)
    expect(await test.ctx.sessionPersistence.stat(test.member.id)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it.each(['lead', 'member'] as const)('rejects concurrent %s occupation and drains owner disposal before closing', async (kind) => {
    const test = await setup()
    const execution = kind === 'lead' ? test.lead : await test.resident()
    const target = kind === 'lead' ? { kind: 'lead' as const, executionId: test.lead.id, term: 1 } : test.target
    const entered = gate(), resume = gate()
    let scopeSignal: AbortSignal | undefined
    const first = test.writer.withExecutionMaintenance(test.lead, { target }, signal, async (scope) => {
      scopeSignal = scope.signal; entered.resolve(undefined); await resume.promise; scope.signal.throwIfAborted()
    })
    const rejection = expect(first).rejects.toThrow(/closed/)
    await entered.promise
    await expect(test.writer.withExecutionMaintenance(test.lead, { target }, signal, async () => {}))
      .rejects.toMatchObject({ code: kind === 'lead' ? 'TEAM_LEAD_NOT_READY' : 'TEAM_MEMBER_HELD' })
    let disposed = false
    const closing = (kind === 'lead' ? test.leadOwner.dispose() : test.memberOwner.dispose()).then(() => { disposed = true })
    await vi.waitFor(() => { expect(scopeSignal?.aborted).toBe(true) })
    expect(disposed).toBe(false)
    resume.resolve(undefined); await rejection; await closing
    expect(test.ctx.agents.get(execution.id)).toBe(execution)
    await expect(test.writer.withExecutionMaintenance(test.lead, { target }, signal, async () => {}))
      .rejects.toMatchObject({ code: kind === 'lead' ? 'TEAM_LEAD_PROVIDER_CLOSED' : 'TEAM_MEMBER_OWNER_CLOSED' })
  })

  it('rejects wrong member identity, member authors and disposed or differently registered Task capabilities', async () => {
    const test = await setup()
    const execution = await test.resident()
    await expect(test.writer.withExecutionMaintenance(test.lead,
      { target: { ...test.target, memberId: SessionId('not-in-the-roster') } }, signal, async () => {}))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
    await expect(test.writer.withExecutionMaintenance(execution, { target: test.target }, signal, async () => {}))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    const old = test.writer
    test.replaceWriter()
    expect(() => old.recordsConfirmed(test.lead)).toThrow(/no longer owns/)
    await expect(old.withExecutionMaintenance(test.lead, { target: test.target }, signal, async () => {}))
      .rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    test.writer.dispose()
    const unavailable = async (): Promise<never> => { throw new Error('unrelated writer') }
    const wrong = test.ctx.agentTeams.installTaskExtension({ id: 'another-writer', create: unavailable, update: unavailable })
    expect(() => wrong.recordsConfirmed(test.lead)).toThrow(/no longer owns/)
    await expect(wrong.withExecutionMaintenance(test.lead, { target: test.target }, signal, async () => {}))
      .rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
  })

  it('offers explicit original restore/release while rejecting settled, consumed, missing and obsolete identities', async () => {
    const test = await setup()
    const execution = await test.resident()
    const old = test.work('explicit-old-A'), note = test.ordinary('explicit restore'), consumed = test.ordinary('consumed earlier')
    await test.ctx.agents.receiveInput(execution, old)
    await test.ctx.agents.receiveInput(execution, note)
    await test.ctx.agents.receiveInput(execution, consumed)
    await test.ctx.agents.mutateInput(execution, { kind: 'remove', messageId: consumed.message.id })
    await test.setBlocked()
    await test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
      await scope.capture([note.message.id, old.message.id])
      await scope.restore([note.message.id]); await scope.restore([note.message.id])
      await scope.release([old.message.id])
    })
    expect(execution.inbox.nextStep).toEqual([note.message])
    for (const id of [MessageId('missing-restore'), old.message.id, consumed.message.id]) {
      await expect(test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
        await scope.restore([id])
      })).rejects.toThrow(/disposition was not confirmed/)
    }
    expect(execution.inbox.nextStep).toEqual([note.message])
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('drains a mutation not awaited by its callback and exposes uncertain source writes rather than successful completion', async () => {
    const test = await setup()
    const execution = await test.resident(), note = test.ordinary('recoverable non-awaited capture')
    await test.ctx.agents.receiveInput(execution, note)
    const flush = test.ctx.sessions.flush.bind(test.ctx.sessions)
    let sourceWrites = 0
    const faulty = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === execution.session && ++sourceWrites === 2) return false
      return await flush(session)
    })
    await expect(test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
      void scope.capture([note.message.id])
    })).rejects.toThrow(/disposition was not confirmed/)
    faulty.mockRestore()
    expect(execution.inbox.nextStep).toEqual([note.message])
    expect(test.ctx.agents.canStartInput(execution)).toBe(true)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it.each(['lead', 'member'] as const)('restores held original input before an actual %s claim, settling only obsolete work', async (kind) => {
    const test = await setup([textResponse('eligible original batch')])
    const execution = kind === 'lead' ? test.lead : await test.resident()
    const target = kind === 'lead' ? { kind: 'lead' as const, executionId: test.lead.id, term: 1 } : test.target
    if (kind === 'lead') await test.writer.commit(test.lead, snapshot => ({ dataJson: '{}', updates: snapshot.tasks.map(task => ({
      previousRevision: task.revision, task: { ...task, revision: task.revision + 1, ownerId: test.lead.id },
    })) }))
    const old = test.work(`held-${kind}-A`), eligible = test.work(`held-${kind}-B`, 1), note = test.ordinary(`held-${kind}-ordinary`)
    for (const input of [old, eligible, note]) await test.ctx.agents.receiveInput(execution, input)
    const maintaining = test.writer.withExecutionMaintenance(test.lead, { target }, signal, async (scope) => {
      await scope.capture()
      await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'begin', applicationId: `claim-${kind}-profile`,
        profileId: 'profile', profileVersion: 1, targetJson: '{}', retiringMemberIds: [], previousPhase: 'dynamic' }))
    })
    await expect(maintaining).rejects.toThrow(/changed/)
    await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'finish', applicationId: `claim-${kind}-profile` }))
    await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'unlock' }))
    await test.setBlocked()
    // A real wake enters prepareClaim even when every earlier receipt remains held.
    await test.ctx.agents.receiveInput(execution, test.ordinary(`new-${kind}-wake`, 'next-turn', true))
    await execution.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    expect(JSON.stringify(test.adapter.requests)).not.toContain(`held-${kind}-A`)
    expect(JSON.stringify(test.adapter.requests)).toContain(`held-${kind}-B`)
    expect(JSON.stringify(test.adapter.requests)).toContain(`held-${kind}-ordinary`)
  })

  it.each(['lead', 'member'] as const)('revalidates %s authority between two original held-input writes before claim', async (kind) => {
    const test = await setup([textResponse('must not dispatch')])
    const execution = kind === 'lead' ? test.lead : await test.resident()
    const target = kind === 'lead' ? { kind: 'lead' as const, executionId: test.lead.id, term: 1 } : test.target
    if (kind === 'lead') await test.writer.commit(test.lead, snapshot => ({ dataJson: '{}', updates: snapshot.tasks.map(task => ({
      previousRevision: task.revision, task: { ...task, revision: task.revision + 1, ownerId: test.lead.id },
    })) }))
    const first = test.work(`preempt-${kind}-A`), second = test.work(`preempt-${kind}-B`, 1)
    await test.ctx.agents.receiveInput(execution, first); await test.ctx.agents.receiveInput(execution, second)
    await expect(test.writer.withExecutionMaintenance(test.lead, { target }, signal, async (scope) => {
      await scope.capture()
      await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'begin', applicationId: `preempt-${kind}-profile`,
        profileId: 'profile', profileVersion: 1, targetJson: '{}', retiringMemberIds: [], previousPhase: 'dynamic' }))
    })).rejects.toThrow(/changed/)
    await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'finish', applicationId: `preempt-${kind}-profile` }))
    await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'unlock' }))
    await test.setBlocked()
    const coordinator = kind === 'lead' ? test.ctx.agentTeams.installLeadCoordinator({ id: 'claim-preemption-coordinator' }) : undefined
    if (coordinator !== undefined) await coordinator.record(test.lead, { operationId: TeamLeadOperationId('claim-preemption'),
      previousTerm: 1, phase: 'requested', recordId: 'claim-preemption-requested', dataJson: '{}' })
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    let preempting: Promise<unknown> | undefined
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === execution.session && execution.status === 'running' && preempting === undefined) {
        preempting = coordinator === undefined
          ? test.memberOwner.hold(test.lead, { memberId: test.member.id, operationId: 'claim-preemption', expectedGeneration: 1 },
            () => ({ recordId: 'claim-preemption-hold', dataJson: '{}' }))
          : coordinator.record(test.lead, { operationId: TeamLeadOperationId('claim-preemption'), previousTerm: 1,
            phase: 'frozen', recordId: 'claim-preemption-frozen', dataJson: '{}' })
      }
      return await original(session)
    })
    await test.ctx.agents.receiveInput(execution, test.ordinary(`preemption-${kind}-wake`, 'next-turn', true))
    await execution.whenIdle(); await preempting
    flush.mockRestore()
    expect(preempting).toBeDefined()
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.ctx.agents.inputControlState(execution.session).records.find(record =>
      record.input.message.id === second.message.id)?.location).toBe('held')
  })

  it.each(['lead', 'member'] as const)('honors late coordination wake intent after short %s occupation without changing original input ids', async (kind) => {
    const test = await setup([textResponse('late shared coordination')])
    const execution = kind === 'lead' ? test.lead : await test.resident()
    const target = kind === 'lead' ? { kind: 'lead' as const, executionId: test.lead.id, term: 1 } : test.target
    const late = test.ordinary(`late-${kind}`, 'next-turn', true)
    await test.writer.withExecutionMaintenance(test.lead, { target }, signal, async () => {
      expect(await test.ctx.agents.receiveInput(execution, late)).toMatchObject({ location: 'held' })
    })
    await execution.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    expect(execution.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.id === late.message.id)).toHaveLength(1)
    expect(test.ctx.agents.inputControlState(execution.session).records.find(record =>
      record.input.message.id === late.message.id)?.input).toEqual(late)
  })

  it.each(['lead', 'member'] as const)('hands late %s input back on reader failure but does not restore execution until a new explicit wake', async (kind) => {
    const test = await setup([textResponse('explicit later coordination')])
    const execution = kind === 'lead' ? test.lead : await test.resident()
    const target = kind === 'lead' ? { kind: 'lead' as const, executionId: test.lead.id, term: 1 } : test.target
    const late = test.ordinary(`blocked-${kind}-coordination`, 'next-turn', true)
    await expect(test.writer.withExecutionMaintenance(test.lead, { target }, signal, async () => {
      expect(await test.ctx.agents.receiveInput(execution, late)).toMatchObject({ location: 'held' })
      throw new Error('background effect is not settled')
    })).rejects.toThrow(/not settled/)
    expect(execution.inbox.nextTurn).toEqual([late.message])
    expect(execution.status).toBe('idle')
    expect(test.ctx.agents.canStartInput(execution)).toBe(true)
    expect(test.adapter.requests).toHaveLength(0)
    await test.ctx.agents.receiveInput(execution, test.ordinary(`explicit-${kind}-wake`, 'next-turn', true))
    await execution.whenIdle()
    expect(test.adapter.requests).toHaveLength(2)
    expect(JSON.stringify(test.adapter.requests)).toContain(`blocked-${kind}-coordination`)
  })

  it('closes scope methods and its signal as soon as callback returns, while final root confirmation still waits', async () => {
    const test = await setup(), entered = gate(), resume = gate(), returned = gate()
    await test.resident()
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const spy = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === test.lead.session) { entered.resolve(undefined); await resume.promise }
      return await original(session)
    })
    let retained: TeamExecutionMaintenanceScope | undefined, record: Promise<unknown> | undefined
    const maintaining = test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
      retained = scope
      record = test.writer.commitRecord(test.lead, () => ({ recordId: 'callback-close-checkpoint', dataJson: '{}' }))
      await entered.promise
      returned.resolve(undefined)
    })
    await returned.promise
    await vi.waitFor(() => { expect(retained?.signal.aborted).toBe(true) })
    expect(() => retained?.read()).toThrow(/scope is closed/)
    expect(() => retained?.capture()).toThrow(/scope is closed/)
    resume.resolve(undefined)
    await Promise.all([maintaining, record])
    spy.mockRestore()
  })

  it.each(['capture', 'release', 'restore'] as const)('stops cleanup after Handoff preempts its first %s write and never acknowledges the obsolete scope', async (phase) => {
    const test = await setup()
    const execution = await test.resident()
    const first = test.work(`cleanup-${phase}-A1`), second = test.work(`cleanup-${phase}-A2`), shared = test.ordinary(`cleanup-${phase}-shared`)
    for (const input of [first, second, shared]) await test.ctx.agents.receiveInput(execution, input)
    if (phase !== 'restore') await test.setBlocked()
    const coordinator = test.ctx.agentTeams.installLeadCoordinator({ id: `cleanup-${phase}-coordinator` })
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    let preempting: Promise<void> | undefined
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === execution.session && preempting === undefined) {
        const events = session.snapshotEvents(), last = events.at(-1)
        const matches = phase === 'capture' ? last?.type === 'agent/inbox/spliced' && last.data.heldInput === second.message.id
          : phase === 'release' ? last?.type === 'agent/input/released' && last.data.messageId === first.message.id
            : last?.type === 'agent/inbox/spliced' && last.data.inserted.some(message => message.id === first.message.id)
        if (matches) preempting = coordinator.record(test.lead, { operationId: TeamLeadOperationId(`cleanup-${phase}`),
          previousTerm: 1, phase: 'requested', recordId: `cleanup-${phase}-requested`, dataJson: '{}' })
      }
      return await original(session)
    })
    await expect(test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
      if (phase === 'restore') await scope.capture([first.message.id, second.message.id])
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
    await preempting; flush.mockRestore()
    expect(preempting).toBeDefined()
    const records = test.ctx.agents.inputControlState(execution.session).records
    expect(records.find(record => record.input.message.id === second.message.id)?.location).toBe('held')
    expect(test.adapter.requests).toHaveLength(0)
  })

  it.each(['capture', 'release', 'restore'] as const)('rechecks cleanup %s after waiting for the actual Team lock', async (phase) => {
    const test = await setup(), execution = await test.resident()
    const first = phase === 'restore' ? test.ordinary('locked shared one') : test.work('locked obsolete one')
    const second = phase === 'restore' ? test.ordinary('locked shared two') : test.work('locked obsolete two')
    for (const input of [first, second]) await test.ctx.agents.receiveInput(execution, input)
    if (phase !== 'restore') await test.setBlocked()
    const coordinator = test.ctx.agentTeams.installLeadCoordinator({ id: `locked-${phase}-coordinator` })
    const journal = Reflect.get(test.ctx.agentTeams, 'journal') as TeamJournal
    const transact = journal.transact.bind(journal), entered = gate(), resume = gate()
    let callbackEnded = false, decisions = 0
    const transaction = vi.spyOn(journal, 'transact').mockImplementation(async <T>(id: import('@deepseek-ai/dsh-session').SessionId,
      action: () => Promise<T>): Promise<T> => {
      if (callbackEnded && ++decisions === 2) { entered.resolve(undefined); await resume.promise }
      return await transact(id, action)
    })
    const maintaining = test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
      if (phase !== 'capture') await scope.capture([first.message.id, second.message.id])
      callbackEnded = true
    })
    const rejected = expect(maintaining).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
    try {
      await entered.promise
      await coordinator.record(test.lead, { operationId: TeamLeadOperationId(`locked-${phase}`), previousTerm: 1,
        phase: 'requested', recordId: `locked-${phase}-requested`, dataJson: '{}' })
      resume.resolve(undefined); await rejected
      const records = test.ctx.agents.inputControlState(execution.session).records
      for (const input of [first, second]) expect(records.find(record => record.input.message.id === input.message.id)?.location)
        .toBe(phase === 'capture' ? 'inbox' : 'held')
      expect(test.adapter.requests).toHaveLength(0)
    } finally { resume.resolve(undefined); await Promise.allSettled([maintaining]); transaction.mockRestore() }
  })

  it('does not restore held work whose writer association becomes obsolete while handback waits for the Team lock', async () => {
    const test = await setup(), execution = await test.resident()
    const work = test.work('handback-current-work'), shared = test.ordinary('handback-shared')
    for (const input of [work, shared]) await test.ctx.agents.receiveInput(execution, input)
    const journal = Reflect.get(test.ctx.agentTeams, 'journal') as TeamJournal
    const transact = journal.transact.bind(journal), entered = gate(), resume = gate()
    let callbackEnded = false, decisions = 0
    const transaction = vi.spyOn(journal, 'transact').mockImplementation(async <T>(id: import('@deepseek-ai/dsh-session').SessionId,
      action: () => Promise<T>): Promise<T> => {
      if (callbackEnded && ++decisions === 2) { entered.resolve(undefined); await resume.promise }
      return await transact(id, action)
    })
    const maintaining = test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
      await scope.capture([work.message.id, shared.message.id]); callbackEnded = true
    })
    try {
      await entered.promise
      await test.writer.commitRecord(test.lead, () => ({ recordId: 'late-obsolete-review', dataJson: JSON.stringify({ obsoleteInputId: work.message.id }) }))
      resume.resolve(undefined); await maintaining
      expect(execution.inbox.nextStep).toEqual([shared.message])
      expect(test.ctx.agents.inputControlState(execution.session).records.find(record => record.input.message.id === work.message.id)?.location).toBe('held')
      expect(test.adapter.requests).toHaveLength(0)
    } finally { resume.resolve(undefined); await Promise.allSettled([maintaining]); transaction.mockRestore() }
  })

  it('does not remove another real member-operation occupation during maintenance cleanup', async () => {
    const test = await setup(['hang'])
    await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Start actual member residency'), signal })
    const execution = await vi.waitFor(() => {
      const current = test.ctx.agents.get(test.member.id)
      if (current === undefined || current.status !== 'running') throw new Error('actual member did not start')
      expect(test.adapter.requests).toHaveLength(1)
      return current
    })
    await test.ctx.agents.receiveInput(execution, test.ordinary('Retain real source custody', 'next-turn'))
    const start = execution.session.snapshotEvents().findLast(event => event.type === 'turn/start')
    if (start?.type !== 'turn/start') throw new Error('actual member lacks a current turn')
    const callbackEntered = gate(), callbackReturn = gate(), readerEntered = gate(), readerReturn = gate()
    const maintenance = vi.spyOn(test.ctx.subagents, 'withContinuableExecution')
    const maintaining = test.writer.withExecutionMaintenance(test.lead,
      { target: { ...test.target, turn: start.data.turn } }, signal, async () => {
        callbackEntered.resolve(undefined); await callbackReturn.promise
      })
    const rejected = expect(maintaining).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
    let releasing: Promise<void> | undefined
    try {
      await callbackEntered.promise
      await test.memberOwner.hold(test.lead, { memberId: test.member.id, operationId: 'concurrent-member-operation', expectedGeneration: 1 },
        () => ({ recordId: 'concurrent-member-operation:held', dataJson: '{}' }))
      releasing = test.memberOwner.release(test.lead, test.member.id, 'concurrent-member-operation',
        { recordId: 'concurrent-member-operation:ready', dataJson: '{}' }, async () => {
          readerEntered.resolve(undefined); await readerReturn.promise; return []
        })
      // The release reserves its own occupation before waiting for the live maintenance resource.
      await vi.waitFor(() => { expect(maintenance).toHaveBeenCalledTimes(1) })
      callbackReturn.resolve(undefined); await rejected; await readerEntered.promise
      expect(test.ctx.agents.canClaimInput(execution)).toBe(false)
      readerReturn.resolve(undefined); await releasing
      expect(test.ctx.agents.canClaimInput(execution)).toBe(true)
    } finally {
      callbackReturn.resolve(undefined); readerReturn.resolve(undefined)
      await Promise.allSettled([maintaining, releasing]); maintenance.mockRestore()
    }
  })

  it('propagates native Team disposal into a stored scope and waits for the admitted callback before teardown', async () => {
    const test = await setup(), entered = gate(), resume = gate()
    await test.resident(); await test.closeResident()
    let scopeSignal: AbortSignal | undefined, disposed = false
    const maintaining = test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
      expect(scope.source).toBe('stored'); scopeSignal = scope.signal
      entered.resolve(undefined); await resume.promise; scope.signal.throwIfAborted()
    })
    const rejected = expect(maintaining).rejects.toThrow()
    await entered.promise
    const closing = test.fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(scopeSignal?.aborted).toBe(true) })
    expect(disposed).toBe(false)
    resume.resolve(undefined); await rejected; await closing
    expect(test.ctx.agents.get(test.member.id)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('closes ordinary member and Lead claim admission at native shutdown before their owner registrations finish disposing', async () => {
    const test = await setup(), execution = await test.resident(), entered = gate(), resume = gate()
    const maintaining = test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
      entered.resolve(undefined); await resume.promise; scope.signal.throwIfAborted()
    })
    const rejected = expect(maintaining).rejects.toThrow()
    let closing: Promise<void> | undefined
    try {
      await entered.promise; closing = test.fiber.dispose()
      await vi.waitFor(() => { expect(test.ctx.agents.canClaimInput(execution)).toBe(false) })
      expect(test.ctx.agents.canStartInput(test.lead)).toBe(false)
      expect(test.ctx.agents.canClaimInput(test.lead)).toBe(false)
      resume.resolve(undefined); await rejected; await closing
    } finally { resume.resolve(undefined); await Promise.allSettled([maintaining, closing]) }
  })
  it('uses one native pause fact for Board readiness, exact batch admission and unchanged statuses', async () => {
    const test = await setup()
    await test.setBlocked()
    const views = test.ctx.agentTeams.listTasks(test.lead)
    expect(views.map(task => [task.status, task.ready, task.dispatchBlocked])).toEqual([
      ['in_progress', false, true], ['in_progress', false, undefined],
    ])
    expect(test.writer.recordsConfirmed(test.lead)).toBe(true)
    const before = test.lead.session.seq
    await expect(test.writer.commit(test.lead, (snapshot) => {
      const first = snapshot.tasks[0], other = snapshot.tasks[1]
      if (first === undefined || other === undefined) throw new Error('fixture batch is absent')
      return { updates: [{ previousRevision: first.revision, task: { ...first, revision: first.revision + 1,
        ownerId: test.lead.id } }, { previousRevision: other.revision, task: { ...other, revision: other.revision + 1,
        subject: 'must remain unchanged' } }], dataJson: '{}' }
    })).rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })
    expect(test.lead.session.seq).toBe(before)
    await test.setBlocked(0, false)
    await test.writer.commit(test.lead, (snapshot) => {
      const first = snapshot.tasks[0]
      if (first === undefined) throw new Error('fixture Task is absent')
      return { updates: [{ previousRevision: first.revision, task: { ...first, revision: first.revision + 1, status: 'pending' } }], dataJson: '{}' }
    })
    expect(test.ctx.agentTeams.listTasks(test.lead)[0]).toMatchObject({ status: 'pending', ready: true })
    await test.setBlocked()
    expect(test.ctx.agentTeams.listTasks(test.lead)[0]).toMatchObject({ status: 'pending', ready: false, dispatchBlocked: true })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('settles old accepted work in the real inbox while returning other selected inputs with original ids', async () => {
    const test = await setup()
    const execution = await test.resident()
    const old = test.work('old-task-A'), shared = test.work('shared-task-B', 1, 'next-turn'), note = test.ordinary('ordinary coordination')
    for (const input of [old, shared, note]) await test.ctx.agents.receiveInput(execution, input)
    await test.setBlocked()
    const registration = vi.spyOn(test.ctx.agents, 'registerInputController')
    let retained: TeamExecutionMaintenanceScope | undefined
    await test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
      retained = scope
      expect(scope.source).toBe('live')
      expect(scope.read()?.pending.map(item => item.message.id)).toEqual([old.message.id, note.message.id, shared.message.id])
      expect(await scope.capture([shared.message.id, note.message.id])).toEqual([note, shared])
      expect(test.ctx.agents.canStartInput(execution)).toBe(false)
      expect(test.memberOwner.read(test.lead, test.member.id).control).toBeUndefined()
    })
    expect(registration).not.toHaveBeenCalled()
    registration.mockRestore()
    expect(execution.inbox.nextStep).toEqual([note.message])
    expect(execution.inbox.nextTurn).toEqual([shared.message])
    expect(test.ctx.agents.inputControlState(execution.session).records.find(record => record.input.message.id === old.message.id)?.location).toBe('released')
    expect(() => retained?.read()).toThrow(/scope is closed/)
    await expect(test.ctx.agents.receiveInput(execution, test.work('late-old-A'))).rejects.toThrow(/no longer schedulable/)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('settles obsolete original held input and returns eligible cold input without restoring its Preset or mounting an Agent', async () => {
    const test = await setup()
    const execution = await test.resident()
    const old = test.work('cold-old-A'), shared = test.work('cold-shared-B', 1), note = test.ordinary('cold coordination', 'next-turn')
    for (const input of [old, shared, note]) await test.ctx.agents.receiveInput(execution, input)
    await test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
      await scope.capture([old.message.id, shared.message.id])
      await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'begin', applicationId: 'held-cold-profile',
        profileId: 'profile', profileVersion: 1, targetJson: '{}', retiringMemberIds: [], previousPhase: 'dynamic' }))
    }).catch((error: unknown) => { expect(error).toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' }) })
    await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'finish', applicationId: 'held-cold-profile' }))
    await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'unlock' }))
    await test.setBlocked()
    await test.closeResident()
    await test.removeMemberPreset()
    const mounting = vi.spyOn(test.ctx.agentPresets, 'mount')
    await test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, async (scope) => {
      expect(scope.source).toBe('stored')
      expect(scope.read()?.inputControl.records.find(record => record.input.message.id === old.message.id)?.location).toBe('held')
      expect(test.ctx.agents.get(test.member.id)).toBeUndefined()
    })
    expect(mounting).not.toHaveBeenCalled()
    mounting.mockRestore()
    using saved = await test.ctx.sessionQuery.observeSession(test.member.id, { projectionMode: 'none' })
    expect(saved.events.filter(event => event.type === 'agent/input/released' && event.data.messageId === old.message.id)).toHaveLength(1)
    expect(saved.events.filter(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === shared.message.id))).toHaveLength(2)
    expect(test.ctx.agents.get(test.member.id)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('keeps a paused cold queue closed if its classifier owner is absent, then prunes only associated work at actual claim', async () => {
    const test = await setup([textResponse('only shared work and coordination')])
    const execution = await test.resident()
    const old = test.work('claim-old-A'), shared = test.work('claim-shared-B', 1), note = test.ordinary('ordinary claim note')
    for (const input of [old, shared, note]) await test.ctx.agents.receiveInput(execution, input)
    await test.setBlocked()
    test.writer.dispose()
    execution.wakePending?.()
    expect(test.ctx.agents.canStartInput(execution)).toBe(false)
    expect(test.ctx.agents.canClaimInput(execution)).toBe(false)
    expect(execution.inbox.nextStep).toEqual([old.message, shared.message, note.message])
    test.replaceWriter()
    execution.wakePending?.()
    await execution.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    expect(JSON.stringify(test.adapter.requests)).not.toContain('claim-old-A')
    expect(JSON.stringify(test.adapter.requests)).toContain('claim-shared-B')
    expect(JSON.stringify(test.adapter.requests)).toContain('ordinary claim note')
    expect(test.ctx.agents.inputControlState(execution.session).records.find(record => record.input.message.id === old.message.id)?.location).toBe('released')
  })

  it('cancels obsolete legacy mailbox assignment without head-of-line blocking later work or coordination', async () => {
    // The original child's stop also wakes its real Lead with the native settlement notice.
    const test = await setup(['hang', 'hang', 'hang', 'hang'])
    const warnings = vi.spyOn(test.ctx.logger, 'warn')
    await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('actual resident coordinator input'), signal })
    const execution = await vi.waitFor(() => {
      const live = test.ctx.agents.get(test.member.id)
      if (live?.status !== 'running') throw new Error('actual member did not start')
      return live
    })
    const start = execution.session.snapshotEvents().findLast(event => event.type === 'turn/start')
    if (start?.type !== 'turn/start') throw new Error('actual member has no running turn')
    await test.setBlocked()
    const entered = gate(), resume = gate()
    const maintaining = test.writer.withExecutionMaintenance(test.lead,
      { target: { ...test.target, turn: start.data.turn } }, signal, async () => {
        entered.resolve(undefined); await resume.promise
      })
    await entered.promise
    const old = test.work('mailbox-old-A'), other = test.work('mailbox-shared-B', 1)
    await test.writer.commitRecord(test.lead, () => ({ recordId: 'parked-mail', dataJson: '{}', notices: [
      { id: TeamMessageId(old.message.id), targetId: test.member.id, senderId: test.lead.id, senderName: 'lead', content: [...old.message.content] },
      { id: TeamMessageId(other.message.id), targetId: test.member.id, senderId: test.lead.id, senderName: 'lead', content: [...other.message.content] },
      { id: TeamMessageId('mailbox-coordination'), targetId: test.member.id, senderId: test.lead.id, senderName: 'lead', content: text('ordinary queued coordination') },
    ] }))
    resume.resolve(undefined); await maintaining
    await test.writer.commitRecord(test.lead, () => ({ recordId: 'dispatch-after-maintenance', dataJson: '{}' }))
    await vi.waitFor(() => {
      const current = test.ctx.sessionProjections.stateOf(test.lead.session, 'agentTeam')
      if (!current?.delivered.includes(TeamMessageId('mailbox-coordination'))) throw new Error(JSON.stringify({
        delivered: current?.delivered, queued: current?.messages.map(message => message.id), warnings: warnings.mock.calls,
        actors: test.ctx.agents.list().map(agent => ({ id: agent.id, status: agent.status,
          inputs: test.ctx.agents.inputControlState(agent.session).records.map(record => ({ id: record.input.message.id,
            location: record.location, captured: record.captured })) })),
        confirmed: test.writer.recordsConfirmed(test.lead),
      }))
    })
    const state = test.ctx.sessionProjections.stateOf(test.lead.session, 'agentTeam')
    expect(state?.cancelled).toContainEqual(expect.objectContaining({ messageId: TeamMessageId(old.message.id), reason: 'Task work input is no longer schedulable' }))
    expect(state?.delivered).toContain(TeamMessageId(other.message.id))
    expect(state?.delivered).toContain(TeamMessageId('mailbox-coordination'))
    expect(JSON.stringify(test.adapter.requests)).not.toContain('mailbox-old-A')
    warnings.mockRestore()
  })

  it('uses the real initial Lead controller without pretending the Lead is a member', async () => {
    const test = await setup()
    await test.writer.commit(test.lead, (snapshot) => {
      const task = snapshot.tasks[0]
      if (task === undefined) throw new Error('fixture Task is absent')
      return { updates: [{ previousRevision: task.revision, task: { ...task, revision: task.revision + 1, ownerId: test.lead.id } }], dataJson: '{}' }
    })
    const old = test.work('lead-old-A'), note = test.ordinary('lead coordination')
    await test.ctx.agents.receiveInput(test.lead, old)
    await test.ctx.agents.receiveInput(test.lead, note)
    await test.setBlocked()
    await expect(test.ctx.agents.receiveInput(test.lead, test.work('lead-late-obsolete-A'))).rejects.toThrow(/no longer schedulable/)
    await test.writer.withExecutionMaintenance(test.lead, { target: { kind: 'lead', executionId: test.lead.id, term: 1 } }, signal, async (scope) => {
      expect(scope.source).toBe('live'); expect(scope.read()?.header.id).toBe(test.lead.id)
      await scope.capture([note.message.id])
      expect(test.ctx.agents.canClaimInput(test.lead)).toBe(false)
    })
    expect(test.lead.inbox.nextStep).toEqual([note.message])
    expect(test.ctx.agents.inputControlState(test.lead.session).records.find(record => record.input.message.id === old.message.id)?.location).toBe('released')
    await expect(test.writer.withExecutionMaintenance(test.lead, { target: { kind: 'lead', executionId: test.lead.id, term: 2 } }, signal, async () => {}))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_STALE_TERM' })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('never cancels a later running turn and stops only the exact preview turn', async () => {
    const test = await setup(['hang'])
    const execution = await test.resident()
    await test.ctx.agents.receiveInput(execution, test.work('running current B', 1, 'next-turn', true))
    await vi.waitFor(() => { expect(execution.status).toBe('running'); expect(test.adapter.requests).toHaveLength(1) })
    // The preview is a real public Session cut, not a fabricated Agent status.
    const start = execution.session.snapshotEvents().findLast(event => event.type === 'turn/start')
    if (start?.type !== 'turn/start') throw new Error('running source has no actual turn')
    await expect(test.writer.withExecutionMaintenance(test.lead,
      { target: { ...test.target, turn: start.data.turn + 1 } }, signal, async () => {}))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
    expect(execution.status).toBe('running')
    await test.writer.withExecutionMaintenance(test.lead, { target: { ...test.target, turn: start.data.turn } }, signal, async (scope) => {
      expect(execution.status).toBe('idle'); expect(scope.source).toBe('live')
    })
    expect(execution.status).toBe('idle')
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('rejects an already ended preview turn observed synchronously at the real driver turn-end event', async () => {
    const test = await setup([textResponse('Finished current turn')]), execution = await test.resident()
    const entered = gate(), journal = Reflect.get(test.ctx.agentTeams, 'journal') as TeamJournal
    const input = Reflect.get(Reflect.get(test.ctx.agentTeams, 'memberExecutions'), 'input') as InputControllerHandle
    let rejected: Promise<void> | undefined
    const cancel = vi.spyOn(execution, 'cancel')
    const stop = test.ctx.on('session/event', (session, event) => {
      if (session !== execution.session || event.type !== 'turn/end') return
      expect(execution.status).toBe('running')
      rejected = expect(maintainExecution(test.ctx, { target: { ...test.target, turn: event.data.turn } }, signal,
        { input, lifetime: signal, assertCurrent: () => { expect(test.ctx.agentTeams.membership(test.lead).role).toBe('lead') },
          canHandback: () => true, admitted: () => true, transact: action => journal.transact(test.lead.id, action),
          withStored: () => Promise.reject(new Error('this actual live turn must never acquire stored custody')) }, async () => {}))
        .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
      entered.resolve(undefined)
    })
    try {
      await test.ctx.agents.receiveInput(execution, test.work('ending-current-B', 1, 'next-turn', true))
      await entered.promise
      await rejected; expect(cancel).not.toHaveBeenCalled()
    } finally { await execution.whenIdle(); stop(); cancel.mockRestore() }
  })

  it.each(['false', 'throw'] as const)('rejects unconfirmed live source flush %s and keeps exact pending input recoverable', async (failure) => {
    const test = await setup()
    const execution = await test.resident(), old = test.work('unconfirmed-old-A')
    await test.ctx.agents.receiveInput(execution, old)
    await test.setBlocked()
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async () => {
      if (failure === 'throw') throw new Error('source checkpoint unavailable')
      return false
    })
    const callback = vi.fn(async () => {})
    await expect(test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, callback)).rejects.toThrow()
    expect(callback).not.toHaveBeenCalled()
    expect(execution.inbox.nextStep).toEqual([old.message])
    flush.mockRestore()
    await test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, callback)
    expect(execution.inbox.nextStep).toEqual([])
    expect(test.adapter.requests).toHaveLength(0)
  })

  it.each(['false', 'throw'] as const)('does not dispose input based on an uncertain root Task intent (%s)', async (failure) => {
    const test = await setup()
    const execution = await test.resident(), old = test.work('root-uncertain-A')
    await test.ctx.agents.receiveInput(execution, old)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async () => {
      if (failure === 'throw') throw new Error('root Task intent checkpoint unavailable')
      return false
    })
    await expect(test.setBlocked()).rejects.toThrow()
    flush.mockRestore()
    expect(test.writer.recordsConfirmed(test.lead)).toBe(false)
    expect(test.ctx.agents.canClaimInput(execution)).toBe(false)
    const late = test.work('root-uncertain-late-A')
    expect(await test.ctx.agents.receiveInput(execution, late)).toMatchObject({ location: 'held' })
    const callback = vi.fn(async () => {})
    await expect(test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, callback))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
    expect(callback).not.toHaveBeenCalled()
    expect(execution.inbox.nextStep).toEqual([old.message])
    expect(execution.session.snapshotEvents().filter(event => event.type === 'agent/input/released')).toHaveLength(0)
    // Only this writer's owned confirming read may turn the intent into disposition evidence.
    await test.writer.read(test.lead, snapshot => snapshot.tasks)
    expect(test.writer.recordsConfirmed(test.lead)).toBe(true)
    await test.writer.withExecutionMaintenance(test.lead, { target: test.target }, signal, callback)
    expect(execution.inbox.nextStep).toEqual([])
    expect(test.ctx.agents.inputControlState(execution.session).records.filter(record => record.location === 'released')).toHaveLength(2)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('drains an admitted callback on cancellation and hands ordinary inputs back without stale task effects', async () => {
    const test = await setup()
    const execution = await test.resident(), note = test.ordinary('shared coordination after caller cancellation')
    await test.ctx.agents.receiveInput(execution, note)
    const entered = gate(), resume = gate(), abort = new AbortController()
    let ownedSignal: AbortSignal | undefined, finished = false
    const maintenance = test.writer.withExecutionMaintenance(test.lead, { target: test.target }, abort.signal, async (scope) => {
      ownedSignal = scope.signal; await scope.capture([note.message.id]); entered.resolve(undefined)
      await resume.promise; scope.signal.throwIfAborted()
    }).finally(() => { finished = true })
    const rejected = expect(maintenance).rejects.toThrow(/operation cancelled/)
    await entered.promise
    abort.abort(new Error('operation cancelled'))
    expect(ownedSignal?.aborted).toBe(true)
    expect(finished).toBe(false)
    expect(test.ctx.agents.canStartInput(execution)).toBe(false)
    resume.resolve(undefined)
    await rejected
    expect(execution.inbox.nextStep).toEqual([note.message])
    expect(test.ctx.agents.canStartInput(execution)).toBe(true)
    expect(test.memberOwner.read(test.lead, test.member.id).control).toBeUndefined()
  })
})
