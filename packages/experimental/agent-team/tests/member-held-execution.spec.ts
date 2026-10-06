/** Resource handback observations retain the original member hold and real source occupation. */
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import type { TeamHeldExecutionScope } from '../src/index.ts'
import { TeamLeadOperationId } from '../src/index.ts'
import { facadeControlledMode, nativeFacadeHarness } from './native-facade-harness.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const signal = new AbortController().signal
const gate = () => Promise.withResolvers<undefined>()
const text = (value: string) => [{ type: 'text' as const, text: value }]

async function setup(script: NonNullable<Parameters<typeof nativeFacadeHarness>[0]>['script'] = [textResponse('unused')]) {
  const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode }, script })
  vi.spyOn(test.ctx.sessionQuery, 'observeSession').mockImplementation((id, options) =>
    SessionQuery.prototype.observeSession.call(test.ctx.sessionQuery, id, options))
  const unsupported = async (): Promise<never> => { throw new Error('Task changes are outside this test') }
  test.ctx.agentTeams.installTaskExtension({ id: facadeControlledMode.requiredTaskExtensionId, create: unsupported,
    update: unsupported, validateMemberGroup: () => undefined, assessSettlementNotice: () => 'suppress' })
  const owner = test.ctx.agentTeams.installMemberExecutions({ id: 'held-resource-owner' })
  const member = (await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'held-resource-worker', context: 'fresh',
    provider: 'spawn', presetId: 'standard', prompt: [], signal })).member
  await owner.hold(test.lead, { memberId: member.id, operationId: 'held-resource', expectedGeneration: 1,
    nextExecutionId: SessionId('initial-held-candidate') },
  () => ({ recordId: 'held-resource:held', dataJson: '{}' }))
  const prepare = async () => {
    const configuration = owner.read(test.lead, member.id).member
    if (configuration.preset === undefined) throw new Error('fixture needs its real Preset binding')
    await test.ctx.subagents.prepareContinuable({ childId: member.id, provider: configuration.provider,
      label: configuration.description, preset: configuration.preset, request: { parent: test.lead }, signal })
  }
  const resident = async () => {
    await owner.release(test.lead, member.id, 'held-resource', { recordId: 'held-resource:initial-ready', dataJson: '{}' }, () => [])
    await test.ctx.agentTeams.sendMessage(test.lead, { target: member.name, content: text('Start original input'), signal })
    const execution = await vi.waitFor(() => {
      const loaded = test.ctx.agents.get(member.id)
      if (loaded === undefined || loaded.status !== 'running') throw new Error('actual source did not start')
      expect(test.adapter.requests).toHaveLength(1); return loaded
    })
    await test.ctx.agents.receiveInput(execution, { message: createUserMessage({ content: text('Retain quiet source'), source: { kind: 'user' } }),
      target: 'next-turn', wakeup: false })
    await owner.hold(test.lead, { memberId: member.id, operationId: 'held-resource', expectedGeneration: 1,
      nextExecutionId: SessionId('another-initial-held-candidate') }, () => ({ recordId: 'held-resource:held-again', dataJson: '{}' }))
    test.ctx.agentTeams.interrupt(test.lead, member.name); await execution.whenIdle()
    return execution
  }
  return { ...test, owner, member, prepare, resident }
}

it.each(['live', 'stored', 'absent'] as const)('retains the actual %s held source through resource confirmation and expires its detached observer', async (source) => {
  const test = await setup(source === 'live' ? ['hang'] : [textResponse('unused')])
  if (source === 'stored') await test.prepare()
  const execution = source === 'live' ? await test.resident() : undefined
  let retained: TeamHeldExecutionScope | undefined
  const result = await test.owner.withHeldExecution(test.lead, test.member.id, 'held-resource', (_id, stored) => {
    expect(stored === undefined).toBe(source !== 'stored'); return []
  }, signal, async (scope) => {
    retained = scope
    expect(scope.source).toBe(source); expect(scope.executionId).toBe(test.member.id)
    scope.assertCurrent()
    const observation = scope.read()
    if (source === 'absent') expect(observation).toBeUndefined()
    else {
      expect(observation?.header.id).toBe(test.member.id)
      if (observation === undefined) throw new Error('occupied real source must be observable')
      const originalCwd = observation.header.cwd
      Reflect.set(observation.header, 'cwd', '/detached-observation-only')
      expect(scope.read()?.header.cwd).toBe(originalCwd)
    }
    if (execution !== undefined) expect(test.ctx.agents.canClaimInput(execution)).toBe(false)
    expect(Object.keys(scope)).not.toContain('capture')
    return 'resource handed back'
  })
  expect(result).toBe('resource handed back')
  expect(retained?.signal.aborted).toBe(true)
  expect(() => retained?.read()).toThrow('scope closed')
  expect(() => retained?.assertCurrent()).toThrow('scope closed')
  expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
  expect(test.adapter.requests).toHaveLength(source === 'live' ? 1 : 0)
})

it('rejects observed blockers without exposing a resource-writing callback', async () => {
  const test = await setup(); await test.prepare()
  const callback = vi.fn()
  await expect(test.owner.withHeldExecution(test.lead, test.member.id, 'held-resource', () => ['unknown external result'], signal, callback))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_BLOCKED' })
  expect(callback).not.toHaveBeenCalled()
  expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
})

it('rejects a real running execution rather than using its member hold as physical quiescence', async () => {
  const test = await setup(['hang'])
  await test.owner.release(test.lead, test.member.id, 'held-resource', { recordId: 'held-resource:ready', dataJson: '{}' }, () => [])
  const adapter = test.adapter
  await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Actual running work'), signal })
  const execution = await vi.waitFor(() => {
    const actual = test.ctx.agents.get(test.member.id)
    if (actual === undefined || actual.status !== 'running') throw new Error('actual execution did not start')
    expect(adapter.requests).toHaveLength(1); return actual
  })
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'running-held', expectedGeneration: 1 },
    () => ({ recordId: 'running-held:held', dataJson: '{}' }))
  await expect(test.owner.withHeldExecution(test.lead, test.member.id, 'running-held', () => [], signal, async () => {}))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_RUNNING' })
  test.ctx.agentTeams.interrupt(test.lead, test.member.name); await execution.whenIdle()
})

it.each(['false', 'throw'] as const)('does not enter resource handback until the Root hold checkpoint confirms (%s)', async (failure) => {
  const test = await setup(), callback = vi.fn()
  const flush = test.ctx.sessions.flush.bind(test.ctx.sessions)
  const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (session === test.lead.session) {
      if (failure === 'throw') throw new Error('Root checkpoint failed')
      return false
    }
    return await flush(session)
  })
  await expect(test.owner.withHeldExecution(test.lead, test.member.id, 'held-resource', () => [], signal, callback)).rejects.toThrow()
  expect(callback).not.toHaveBeenCalled()
  checkpoint.mockRestore()
  await test.owner.withHeldExecution(test.lead, test.member.id, 'held-resource', () => [], signal, async () => {})
})

it('keeps the writer occupied and drains the actual resource callback when the caller cancels', async () => {
  const test = await setup(); await test.prepare()
  const entered = gate(), resume = gate(), cancellation = new AbortController()
  let scoped: AbortSignal | undefined, settled = false
  const occupying = test.owner.withHeldExecution(test.lead, test.member.id, 'held-resource', () => [], cancellation.signal, async (scope) => {
    scoped = scope.signal; entered.resolve(undefined); await resume.promise; scope.assertCurrent()
  })
  const rejected = expect(occupying).rejects.toThrow('caller stopped')
  const observed = occupying.catch(() => { settled = true })
  try {
    await entered.promise; cancellation.abort(new Error('caller stopped'))
    expect(scoped?.aborted).toBe(true); expect(settled).toBe(false)
    resume.resolve(undefined); await rejected; await observed
    expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
  } finally { resume.resolve(undefined); await observed }
})

it('rejects final confirmation when Handoff takes over during the occupied resource callback', async () => {
  const test = await setup(); await test.prepare()
  const coordinator = test.ctx.agentTeams.installLeadCoordinator({ id: 'held-resource-handoff' })
  await expect(test.owner.withHeldExecution(test.lead, test.member.id, 'held-resource', () => [], signal, async (scope) => {
    scope.assertCurrent()
    await coordinator.record(test.lead, { operationId: TeamLeadOperationId('held-resource-handoff'), previousTerm: 1,
      phase: 'requested', recordId: 'held-resource:handoff', dataJson: '{}' })
  })).rejects.toMatchObject({ code: 'TEAM_LEAD_NOT_READY' })
  expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
})

it('aborts and drains the occupied callback before registration disposal returns', async () => {
  const test = await setup(); await test.prepare()
  const entered = gate(), resume = gate()
  let scoped: AbortSignal | undefined, disposed = false
  const occupying = test.owner.withHeldExecution(test.lead, test.member.id, 'held-resource', () => [], signal, async (scope) => {
    scoped = scope.signal; entered.resolve(undefined); await resume.promise; scope.assertCurrent()
  })
  const rejected = expect(occupying).rejects.toThrow()
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    closing = test.owner.dispose().then(() => { disposed = true })
    expect(scoped?.aborted).toBe(true)
    expect(disposed).toBe(false)
    resume.resolve(undefined)
    await rejected; await closing
    expect(disposed).toBe(true)
    expect(test.ctx.agentTeams.memberExecution(test.lead, test.member.id)?.generation).toBe(1)
  } finally { resume.resolve(undefined); await Promise.allSettled([occupying, closing]) }
})

it('rejects a changed exact control during safety observation and never calls resource handback', async () => {
  const test = await setup(), entered = gate(), resume = gate(), callback = vi.fn()
  const occupying = test.owner.withHeldExecution(test.lead, test.member.id, 'held-resource', async () => {
    entered.resolve(undefined); await resume.promise; return []
  }, signal, callback)
  const rejected = expect(occupying).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  try {
    await entered.promise
    await test.owner.retarget(test.lead, test.member.id, 'held-resource', SessionId('initial-held-candidate'),
      SessionId('another-candidate'), { recordId: 'another-resource:held', dataJson: '{}' }, () => [])
    resume.resolve(undefined); await rejected
    expect(callback).not.toHaveBeenCalled()
  } finally { resume.resolve(undefined); await Promise.allSettled([occupying]) }
})
