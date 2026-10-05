/** Member-runtime custody regressions over the real Loader, JSONL and continuation services. */
import { createHash } from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent, AgentInput, InputControllerHandle } from '@deepseek-ai/dsh-agent'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import type { DormantContinuableScope } from '@deepseek-ai/dsh-subagent'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService, { TeamId, TeamMessageId, TeamTaskId } from '../src/index.ts'
import type { TeamMemberExecutionProvider } from '../src/member-runtime.ts'
import type { TeamMemberSlotTransfer } from '../src/member-slots.ts'
import { nativeFacadeHarness, facadeControlledMode } from './native-facade-harness.ts'

const signal = new AbortController().signal
const text = (value: string) => [{ type: 'text' as const, text: value }]
const record = (recordId: string, dataJson = '{}') => ({ recordId, dataJson })
const gate = () => {
  const pending = Promise.withResolvers<undefined>()
  return { promise: pending.promise, resolve: () => { pending.resolve(undefined) } }
}
/** Observe concurrent requests entering the execution's serialized maintenance phases. */
function serialBlockers() {
  const firstGate = gate(), secondGate = gate(), firstEntered = gate(), secondEntered = gate()
  let reads = 0
  const barrier = (wait: ReturnType<typeof gate>, entered: ReturnType<typeof gate>) => async () => {
    reads += 1
    entered.resolve()
    await wait.promise
    return []
  }
  return { firstGate, secondGate, firstEntered, secondEntered,
    first: barrier(firstGate, firstEntered), second: barrier(secondGate, secondEntered), reads: () => reads }
}

class PointSessionQuery extends SessionQuery {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('search is outside member custody tests')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('search is outside member custody tests')) }
}

async function setup(options: { script?: NonNullable<Parameters<typeof nativeFacadeHarness>[0]>['script']
  provider?: Omit<TeamMemberExecutionProvider, 'id'>
  maxRecordBytes?: number } = {}) {
  const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode,
    ...options.maxRecordBytes === undefined ? {} : { maxTaskExtensionBytes: options.maxRecordBytes } },
  ...options.script === undefined ? {} : { script: options.script } })
  // The facade's minimal reader omits catalog views; continuation preparation needs the real point reader.
  vi.spyOn(test.ctx.sessionQuery, 'observeSession').mockImplementation((id, options) =>
    SessionQuery.prototype.observeSession.call(test.ctx.sessionQuery, id, options))
  const unavailable = async (): Promise<never> => { throw new Error('Task commands are outside this test') }
  const writer = test.ctx.agentTeams.installTaskExtension({ id: facadeControlledMode.requiredTaskExtensionId,
    validateMemberGroup: () => undefined, create: unavailable, update: unavailable })
  const owner = test.ctx.agentTeams.installMemberExecutions({ id: 'focused-member-owner', ...options.provider })
  const member = (await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'focused-worker', context: 'fresh',
    provider: 'spawn', presetId: 'standard', prompt: text('Unused registration prompt'), signal })).member
  return { ...test, writer, owner, member }
}

async function prepareHeld(test: Awaited<ReturnType<typeof setup>>, operationId = 'held-source', nextExecutionId?: SessionId) {
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId, expectedGeneration: 1,
    ...nextExecutionId === undefined ? {} : { nextExecutionId } },
  () => record(`${operationId}:hold`))
  if (test.member.preset === undefined) throw new Error('fixture needs its declared Preset')
  await test.ctx.subagents.prepareContinuable({ childId: test.member.id, provider: 'spawn', label: 'standard',
    preset: test.member.preset, request: { parent: test.lead }, signal })
}

async function prepareCandidate(test: Awaited<ReturnType<typeof setup>>, operationId: string, candidateId: SessionId) {
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId, expectedGeneration: 1, nextExecutionId: candidateId },
    () => record(`${operationId}:hold`))
  if (test.member.preset === undefined) throw new Error('fixture needs its declared Preset')
  await test.ctx.subagents.prepareContinuable({ childId: candidateId, provider: 'spawn', label: 'standard',
    preset: test.member.preset, request: { parent: test.lead }, signal })
}

/** Keep a real announced execution resident with non-waking pending work while maintenance is serialized. */
async function residentHeld(test: Awaited<ReturnType<typeof setup>>, operationId: string, nextExecutionId?: SessionId) {
  await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Start actual resident work'), signal })
  const execution = await vi.waitFor(() => {
    const current = test.ctx.agents.get(test.member.id)
    if (current?.status !== 'running') throw new Error('resident execution did not start')
    return current
  })
  await vi.waitFor(() => { expect(test.adapter.requests).toHaveLength(1) })
  await test.ctx.agents.receiveInput(execution, { message: createUserMessage({ content: text('Parked non-waking input'), source: { kind: 'user' } }),
    target: 'next-turn', wakeup: false })
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId, expectedGeneration: 1,
    ...nextExecutionId === undefined ? {} : { nextExecutionId } }, () => record(`${operationId}:hold`))
  test.ctx.agentTeams.interrupt(test.lead, test.member.name)
  await execution.whenIdle()
  expect(test.ctx.agents.get(test.member.id)).toBe(execution)
  return execution
}

async function profileTransfer(test: Awaited<ReturnType<typeof setup>>): Promise<TeamMemberSlotTransfer> {
  const target = (await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'profile-successor', provider: 'spawn',
    context: 'fresh', presetId: 'standard', prompt: text('Unused registration prompt'), signal })).member
  const targetJson = '{"slot":"research"}'
  await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'begin', applicationId: 'profile-application',
    profileId: 'profile', profileVersion: 1, targetJson, retiringMemberIds: [], previousPhase: 'dynamic' }))
  await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'finish', applicationId: 'profile-application' }))
  await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'unlock' }))
  return { profileId: 'profile', profileVersion: 1,
    appliedTargetFingerprint: createHash('sha256').update(targetJson).digest('hex'), slotId: 'research',
    fromMemberId: test.member.id, toMemberId: target.id, previousSlots: [{ slotId: 'research', memberId: test.member.id }] }
}

async function events(test: Awaited<ReturnType<typeof setup>>, id = test.member.id): Promise<readonly SessionEvent[]> {
  const read = await test.ctx.sessionPersistence.open(id, 'read')
  try { return (await read.read()).events } finally { await read.close() }
}

async function coldContext(test: Awaited<ReturnType<typeof setup>>) {
  await test.ctx.fiber.dispose()
  const ctx = new Context()
  test.resources.contexts.push(ctx)
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentPresets, { default: 'standard' })
  await ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: test.resources.root })
  await ctx.plugin(PointSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService, { controlledMode: facadeControlledMode })
  const adapter = new MockAdapter([])
  ctx.llm.registerAdapter(['mock'], adapter)
  const resume = () => ctx.agents.resume({ resumeSessionId: test.member.id,
    agentOptions: { provider: 'mock', model: 'mock' }, setup: async (scoped) => { await ctx.agentPresets.mount(scoped, 'standard') } })
  return { ctx, adapter, resume }
}

it('captures an unused source without creating a Session and records an empty disposition', async () => {
  const test = await setup()
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'not-started', expectedGeneration: 1 },
    () => record('not-started:hold'))
  expect(await test.owner.captureCurrent(test.lead, test.member.id, 'not-started')).toEqual([])
  await test.owner.releaseCaptured(test.lead, test.member.id, 'not-started', [], record('not-started:empty'))
  expect(await test.ctx.sessionPersistence.stat(test.member.id)).toBeUndefined()
  expect(test.owner.read(test.lead, test.member.id).records.map(item => item.recordId))
    .toEqual(['not-started:hold', 'not-started:empty'])
  expect(test.adapter.requests).toEqual([])
})

it('retains exact held input across a quiet cold capture and settles selected identities once', async () => {
  const test = await setup()
  await prepareHeld(test)
  const input: AgentInput = { message: createUserMessage({ content: text('Unconsumed work'), source: { kind: 'user' } }),
    target: 'next-turn', wakeup: true }
  await test.ctx.subagents.withContinuableExecution(test.lead, test.member.id, signal, async (execution) => {
    expect(await test.ctx.agents.receiveInput(execution, input)).toMatchObject({ location: 'held', messageId: input.message.id })
    expect(await test.owner.capture(execution)).toEqual([input])
  })
  expect(test.ctx.agents.get(test.member.id)).toBeUndefined()
  expect(await test.owner.captureCurrent(test.lead, test.member.id, 'held-source', signal)).toEqual([input])
  await test.owner.releaseCaptured(test.lead, test.member.id, 'held-source', [input.message.id], record('source:released'), signal)
  await test.owner.releaseCaptured(test.lead, test.member.id, 'held-source', [input.message.id], record('source:released'))
  expect(await test.owner.captureCurrent(test.lead, test.member.id, 'held-source')).toEqual([])
  const stored = await events(test)
  expect(stored.filter(event => event.type === 'agent/input/held')).toHaveLength(1)
  expect(stored.filter(event => event.type === 'agent/input/released')).toHaveLength(1)
  expect(stored.some(event => event.type === 'user/message' || event.type === 'turn/start')).toBe(false)
  expect(test.adapter.requests).toEqual([])
})

it('rejects capture without a held member and late user-question replies while preserving admission', async () => {
  const test = await setup({ script: ['hang'] })
  await expect(test.owner.capture(test.lead)).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
  await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Start work'), signal })
  const execution = await vi.waitFor(() => {
    const current = test.ctx.agents.get(test.member.id)
    expect(current?.status).toBe('running'); return current!
  })
  await expect(test.owner.capture(execution)).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'question-custody', expectedGeneration: 1 },
    () => record('question-custody:hold'))
  await expect(test.ctx.agents.receiveInput(execution, { message: createUserMessage({ content: text('Late answer'),
    source: { kind: 'user-question-reply', callId: ToolCallId('old-question'), outcome: 'answered' } }),
  target: 'next-turn', wakeup: true })).rejects.toThrow('working input requires the current member execution')
  expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
  test.ctx.agentTeams.interrupt(test.lead, test.member.name)
  await execution.whenIdle()
})

it('preloads only recorded bounded reference material into an admitted exact execution', async () => {
  const test = await setup({ script: ['hang'], maxRecordBytes: 2_000 })
  const expected = test.owner.read(test.lead, test.member.id).execution
  expect(await test.owner.preloadMaterial(test.lead, expected, [])).toBe('deferred')
  await expect(test.owner.preloadMaterial(test.lead, { ...expected, generation: 2 }, [])).
    rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Start work'), signal })
  const execution = await vi.waitFor(() => {
    const current = test.ctx.agents.get(test.member.id)
    expect(current?.status).toBe('running'); return current!
  })
  await expect(test.owner.preloadMaterial(test.lead, expected, [{ recordId: 'unowned', content: text('Not owned') }]))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  await test.owner.record(test.lead, test.member.id, 'references', record('bounded-reference'))
  await expect(test.owner.preloadMaterial(test.lead, expected, [{ recordId: 'bounded-reference', content: text('x'.repeat(3_000)) }]))
    .rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_TOO_LARGE' })
  const material = [{ recordId: 'bounded-reference', content: text('Reference without authority') }]
  expect(await test.owner.preloadMaterial(test.lead, expected, material)).toBe('stored')
  expect(await test.owner.preloadMaterial(test.lead, expected, material)).toBe('stored')
  const held = execution.inbox.nextStep.filter(message => message.source.kind === 'team-member-material')
  expect(held).toHaveLength(1)
  expect(held[0]?.source).toMatchObject({ teamId: test.lead.id, memberId: test.member.id,
    generation: 1, ownerId: 'focused-member-owner', recordId: 'bounded-reference' })
  expect(test.adapter.requests).toHaveLength(1)
  test.ctx.agentTeams.interrupt(test.lead, test.member.name)
  await execution.whenIdle()
})

it('requires current Lead authority, controlled mode and the exact operation owner for progress', async () => {
  const test = await setup({ script: ['hang'] })
  expect(() => test.owner.read(test.lead, SessionId('unknown-member'))).toThrow(expect.objectContaining({ code: 'TEAM_MEMBER_NOT_FOUND' }))
  await expect(test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'stale', expectedGeneration: 2 },
    () => record('stale:start'))).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'owned', expectedGeneration: 1 }, () => record('owned:start'))
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'owned', expectedGeneration: 1 }, () => record('owned:progress'))
  await expect(test.owner.record(test.lead, test.member.id, 'other-operation', record('wrong-operation')))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  await expect(test.owner.releaseCaptured(test.lead, test.member.id, 'other-operation', [], record('wrong-disposition')))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  await expect(test.owner.commit(test.lead, test.member.id, 'owned', record('no-candidate'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  const official = await nativeFacadeHarness({ script: ['hang'] })
  const officialOwner = official.ctx.agentTeams.installMemberExecutions({ id: 'official-no-op-owner' })
  await expect(officialOwner.recordRoster(official.lead, record('official-write'))).rejects.toMatchObject({ code: 'TEAM_MODE_REQUIRED' })
  expect(official.ctx.agents.isInputControlled(official.lead.session)).toBe(false)
  expect(official.ctx.agents.canStartInput(official.lead)).toBe(true)
})

it('confirms an uncertain release on retry without admitting work before durability is known', async () => {
  const test = await setup()
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'uncertain-release', expectedGeneration: 1 },
    () => record('uncertain-release:hold'))
  const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
  await expect(test.owner.release(test.lead, test.member.id, 'uncertain-release', record('uncertain-release:ready'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
  expect(test.owner.read(test.lead, test.member.id).confirmed).toBe(false)
  const mail = await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Still blocked'), signal })
  expect(mail.status).toBe('queued')
  flush.mockRestore()
  await test.owner.release(test.lead, test.member.id, 'uncertain-release', record('uncertain-release:ready'), () => [])
  expect(test.owner.read(test.lead, test.member.id).confirmed).toBe(true)
  await expect(test.owner.release(test.lead, test.member.id, 'uncertain-release', record('uncertain-release:ready', '{"different":true}'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  expect(test.lead.session.snapshotEvents().filter(event => event.type === 'team/member/control')).toHaveLength(2)
  expect(test.adapter.requests).toHaveLength(0)
})

it('moves one Profile association atomically with member release and keeps its original target immutable', async () => {
  const test = await setup()
  const transfer = await profileTransfer(test)
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'profile-transfer', expectedGeneration: 1 },
    () => record('profile-transfer:hold'))
  await expect(test.owner.release(test.lead, test.member.id, 'profile-transfer', record('profile-transfer:wrong-source'), () => [],
    { ...transfer, fromMemberId: transfer.toMemberId })).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  await test.owner.release(test.lead, test.member.id, 'profile-transfer', record('profile-transfer:ready'), () => [], transfer)
  await test.owner.release(test.lead, test.member.id, 'profile-transfer', record('profile-transfer:ready'), () => [], transfer)
  const state = test.ctx.agentTeams.composition(test.lead)
  expect(state.appliedTargetJson).toBe('{"slot":"research"}')
  expect(state.profile).toMatchObject({ id: 'profile', version: 1, modified: true })
  expect(state.slotBindings).toEqual([{ slotId: 'research', memberId: transfer.toMemberId }])
  await expect(test.owner.release(test.lead, test.member.id, 'profile-transfer', record('profile-transfer:ready'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
})

it('restores the exact cold parent before composing its persisted held member without a model call', async () => {
  const first = await setup()
  await prepareHeld(first)
  const cold = await coldContext(first)
  const restored: string[] = []
  const owner = cold.ctx.agentTeams.installMemberExecutions({ id: 'focused-member-owner', resolveAnchor: async (id, incoming) => {
    expect(incoming.aborted).toBe(false)
    restored.push(id)
    return (await cold.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })).agent
  } })
  const member = await cold.resume()
  expect(restored).toEqual([first.lead.id])
  expect(cold.ctx.agentTeams.membership(member.agent)).toMatchObject({ memberId: first.member.id, generation: 1 })
  expect(cold.ctx.agents.canStartInput(member.agent)).toBe(false)
  expect(cold.ctx.agents.canClaimInput(member.agent)).toBe(false)
  expect(cold.adapter.requests).toEqual([])
  await member.dispose(); await owner.dispose()
})

it.each(['missing-resolver', 'different-parent', 'disposed-parent'] as const)(
  'refuses a cold bound member when parent restoration is invalid (%s)', async (failure) => {
    const first = await setup()
    await prepareHeld(first)
    const cold = await coldContext(first)
    const owner = cold.ctx.agentTeams.installMemberExecutions({ id: 'focused-member-owner',
      ...failure === 'missing-resolver' ? {} : { resolveAnchor: async (id: SessionId) => {
        if (failure === 'different-parent') return (await cold.ctx.agents.create({ sessionId: SessionId('another-Team'),
          agentOptions: { provider: 'mock', model: 'mock' } })).agent
        const handle = await cold.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
        await handle.dispose(); return handle.agent
      } } })
    await expect(cold.resume()).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
    expect(cold.ctx.agents.get(first.member.id)).toBeUndefined()
    expect(cold.adapter.requests).toEqual([])
    await owner.dispose()
  })

it.each([false, true])('linearizes concurrent release retries without duplicate effects (conflicting=%s)', async (conflicting) => {
  const test = await setup({ script: ['hang'] })
  await residentHeld(test, 'parallel-release')
  const pair = serialBlockers()
  const { firstGate, secondGate, firstEntered } = pair
  const maintenance = vi.spyOn(test.ctx.subagents, 'withContinuableExecution')
  const first = test.owner.release(test.lead, test.member.id, 'parallel-release', record('parallel-release:ready'), pair.first)
  let second: Promise<void> | undefined
  try {
    await firstEntered.promise
    expect(pair.reads()).toBe(1)
    second = test.owner.release(test.lead, test.member.id, 'parallel-release',
      record('parallel-release:ready', conflicting ? '{"changed":true}' : '{}'), pair.second)
    const outcome = second.then(() => ({ kind: 'accepted' }), (error: unknown) => ({ kind: 'rejected', error }))
    // Both real maintenance requests must be queued before the first release changes the retry path.
    await vi.waitFor(() => { expect(maintenance).toHaveBeenCalledTimes(2) })
    expect(pair.reads()).toBe(1)
    firstGate.resolve(); secondGate.resolve(); await first
    expect(await outcome).toMatchObject(conflicting ? { kind: 'rejected', error: { code: 'TEAM_MEMBER_OPERATION_STALE' } }
      : { kind: 'accepted' })
    expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(false)
    expect(test.lead.session.snapshotEvents().filter(event => event.type === 'team/member/control')).toHaveLength(2)
  } finally { firstGate.resolve(); secondGate.resolve(); await Promise.allSettled([first, second]); maintenance.mockRestore() }
})

it('keeps admission held when another owner step retargets the candidate during release safety checks', async () => {
  const test = await setup()
  const old = SessionId('release-old-candidate'), next = SessionId('release-new-candidate')
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'changed-release', expectedGeneration: 1, nextExecutionId: old },
    () => record('changed-release:hold'))
  await expect(test.owner.release(test.lead, test.member.id, 'changed-release', record('changed-release:ready'), async () => {
    await test.owner.retarget(test.lead, test.member.id, 'changed-release', old, next, record('changed-release:target'), () => [])
    return []
  })).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  expect(test.owner.read(test.lead, test.member.id).control).toMatchObject({ held: true, nextExecutionId: next })
  expect(test.adapter.requests).toEqual([])
})

it.each([false, true])('linearizes concurrent binding requests against one prepared candidate (conflicting=%s)', async (conflicting) => {
  const test = await setup({ script: ['hang'] })
  const candidate = SessionId('parallel-binding-candidate')
  await residentHeld(test, 'parallel-binding', candidate)
  await prepareCandidate(test, 'parallel-binding', candidate)
  const pair = serialBlockers()
  const { firstGate, secondGate, firstEntered } = pair
  const maintenance = vi.spyOn(test.ctx.subagents, 'withContinuableExecution')
  const first = test.owner.commit(test.lead, test.member.id, 'parallel-binding', record('parallel-binding:commit'), pair.first)
  let second: ReturnType<typeof test.owner.commit> | undefined
  try {
    await firstEntered.promise
    expect(pair.reads()).toBe(1)
    second = test.owner.commit(test.lead, test.member.id, 'parallel-binding',
      record('parallel-binding:commit', conflicting ? '{"changed":true}' : '{}'), pair.second)
    const outcome = second.then(() => ({ kind: 'accepted' }), (error: unknown) => ({ kind: 'rejected', error }))
    // Both candidate reads must reach real maintenance before binding changes their live retry path.
    await vi.waitFor(() => { expect(maintenance).toHaveBeenCalledTimes(2) })
    expect(pair.reads()).toBe(1)
    secondGate.resolve()
    firstGate.resolve(); expect((await first).executionId).toBe(candidate)
    expect(await outcome).toMatchObject(conflicting ? { kind: 'rejected', error: { code: 'TEAM_MEMBER_OPERATION_STALE' } }
      : { kind: 'accepted' })
    if (!conflicting) expect((await second).generation).toBe(2)
    expect(test.lead.session.snapshotEvents().filter(event => event.type === 'team/member/execution')).toHaveLength(1)
    expect(test.adapter.requests).toHaveLength(1)
  } finally { firstGate.resolve(); secondGate.resolve(); await Promise.allSettled([first, second]); maintenance.mockRestore() }
})

it('confirms an uncertain binding once and refuses a retry with different recorded facts', async () => {
  const test = await setup()
  const candidate = SessionId('uncertain-binding-candidate')
  await prepareCandidate(test, 'uncertain-binding', candidate)
  const failed = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
  await expect(test.owner.commit(test.lead, test.member.id, 'uncertain-binding', record('uncertain-binding:commit'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
  expect(test.owner.read(test.lead, test.member.id)).toMatchObject({ confirmed: false,
    execution: { executionId: candidate, generation: 2 } })
  failed.mockRestore()
  expect(await test.owner.commit(test.lead, test.member.id, 'uncertain-binding', record('uncertain-binding:commit'), () => []))
    .toMatchObject({ executionId: candidate, generation: 2 })
  expect(test.owner.read(test.lead, test.member.id).confirmed).toBe(true)
  await expect(test.owner.commit(test.lead, test.member.id, 'uncertain-binding', record('uncertain-binding:commit', '{"changed":true}'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  expect(test.lead.session.snapshotEvents().filter(event => event.type === 'team/member/execution')).toHaveLength(1)
})

it('retains an unfinished Task owner and refuses binding while that Task is in progress', async () => {
  const test = await setup()
  await test.writer.commit(test.lead, cut => ({ updates: [{ previousRevision: null, task: { id: TeamTaskId(`task-${cut.nextTaskNumber}`),
    revision: 1, subject: 'Unsettled work', description: 'Must be released by its Task owner', status: 'in_progress',
    ownerId: test.member.id, blockedBy: [], writeScopes: [] } }], dataJson: '{}' }))
  await prepareCandidate(test, 'unfinished-task', SessionId('unfinished-task-candidate'))
  await expect(test.owner.commit(test.lead, test.member.id, 'unfinished-task', record('unfinished-task:commit'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  expect(test.ctx.agentTeams.memberExecution(test.lead, test.member.id)?.generation).toBe(1)
  expect(test.owner.read(test.lead, test.member.id).tasks[0]).toMatchObject({ status: 'in_progress', ownerId: test.member.id, revision: 1 })
})

it('does not bind or release a still-running execution even when the external blocker reader is empty', async () => {
  const test = await setup({ script: ['hang'] })
  await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Working'), signal })
  const execution = await vi.waitFor(() => {
    const current = test.ctx.agents.get(test.member.id)
    expect(current?.status).toBe('running'); return current!
  })
  await prepareCandidate(test, 'still-running', SessionId('still-running-candidate'))
  await expect(test.owner.commit(test.lead, test.member.id, 'still-running', record('still-running:blocked'), () => ['job still pending']))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_RUNNING' })
  await expect(test.owner.commit(test.lead, test.member.id, 'still-running', record('still-running:commit'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_RUNNING' })
  await expect(test.owner.release(test.lead, test.member.id, 'still-running', record('still-running:ready'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_RUNNING' })
  await expect(test.owner.recordRoster(execution, record('member-must-not-control-roster'))).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
  test.ctx.agentTeams.interrupt(test.lead, test.member.name); await execution.whenIdle()
})

it('retains pending input and confirmation failure through capture before releasing the source custody', async () => {
  const test = await setup({ script: ['hang'] })
  await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Working'), signal })
  const execution = await vi.waitFor(() => {
    const current = test.ctx.agents.get(test.member.id)
    expect(current?.status).toBe('running'); return current!
  })
  const input: AgentInput = { message: createUserMessage({ content: text('Queued before freeze'), source: { kind: 'user' } }), target: 'next-turn', wakeup: false }
  expect((await test.ctx.agents.receiveInput(execution, input)).location).toBe('inbox')
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'capture-checkpoint', expectedGeneration: 1 },
    () => record('capture-checkpoint:hold'))
  const failure = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
  await expect(test.owner.capture(execution)).rejects.toThrow('input capture durability was not confirmed')
  expect(test.ctx.agents.canClaimInput(execution)).toBe(false)
  expect(execution.inbox.nextTurn.some(message => message.id === input.message.id)).toBe(false)
  failure.mockRestore()
  expect(await test.owner.capture(execution)).toEqual([input])
  expect(execution.session.snapshotEvents().filter(event => event.type === 'agent/input/held' && event.data.input.message.id === input.message.id))
    .toMatchObject([{ data: { captured: true, input } }])
  test.ctx.agentTeams.interrupt(test.lead, test.member.name); await execution.whenIdle()
})

it('refuses a retarget to a reserved roster identity and rejects conflicting retries', async () => {
  const test = await setup()
  const other = (await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'other-reserved', context: 'fresh', provider: 'spawn',
    presetId: 'standard', prompt: text('Unused registration prompt'), signal })).member
  const first = SessionId('retarget-one'), second = SessionId('retarget-two')
  await prepareCandidate(test, 'retarget-identity', first)
  await expect(test.owner.retarget(test.lead, test.member.id, 'retarget-identity', first, other.id, record('retarget-identity:invalid'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  await expect(test.owner.retarget(test.lead, test.member.id, 'retarget-identity', second, first, record('retarget-identity:stale'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  await test.owner.retarget(test.lead, test.member.id, 'retarget-identity', first, second, record('retarget-identity:changed'), () => [])
  await expect(test.owner.retarget(test.lead, test.member.id, 'retarget-identity', first, second, record('retarget-identity:changed', '{"changed":true}'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
})

it('refuses forgetting a candidate that already ran ordinary work', async () => {
  const test = await setup({ script: [textResponse('Ordinary child finished'), textResponse('Lead observed')] })
  const used = SessionId('previously-working-candidate')
  await test.ctx.subagents.startContinuable({ childId: used, provider: 'spawn', label: 'standard', preset: test.member.preset!,
    request: { parent: test.lead, prompt: text('Ordinary work before reservation') }, signal })
  await vi.waitFor(() => { expect(test.ctx.agents.get(used)).toBeUndefined() })
  await test.lead.whenIdle()
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'used-candidate', expectedGeneration: 1, nextExecutionId: used },
    () => record('used-candidate:hold'))
  await expect(test.owner.retarget(test.lead, test.member.id, 'used-candidate', used, SessionId('different-unused-candidate'), record('used-candidate:retry'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  expect(test.owner.read(test.lead, test.member.id).control?.nextExecutionId).toBe(used)
})

it.each(['dormant', 'resident'] as const)('refuses source capture when the reservation changes after obtaining a %s source', async (residency) => {
  const test = await setup({ ...residency === 'resident' ? { script: ['hang'] } : {} })
  const before = SessionId('capture-reservation-before'), after = SessionId('capture-reservation-after')
  if (residency === 'resident') await residentHeld(test, 'capture-race', before)
  else await prepareHeld(test, 'capture-race', before)
  const dormant = test.ctx.subagents.withDormantContinuable.bind(test.ctx.subagents)
  const live = test.ctx.subagents.withContinuableExecution.bind(test.ctx.subagents)
  const retarget = async () => {
    await test.owner.retarget(test.lead, test.member.id, 'capture-race', before, after, record('capture-race:retarget'), () => [])
  }
  const coldBorrow = vi.spyOn(test.ctx.subagents, 'withDormantContinuable').mockImplementation(async <T>(
    parent: Agent, childId: SessionId, input: InputControllerHandle, incoming: AbortSignal,
    action: (source: DormantContinuableScope | undefined, heldSignal: AbortSignal) => Promise<T>): Promise<T> => {
    return dormant(parent, childId, input, incoming, async (source, heldSignal) => {
      await retarget()
      return action(source, heldSignal)
    })
  })
  const liveBorrow = vi.spyOn(test.ctx.subagents, 'withContinuableExecution').mockImplementation(async <T>(
    parent: Agent, childId: SessionId, incoming: AbortSignal, action: (agent: Agent, signal: AbortSignal) => Promise<T>): Promise<T> =>
    live(parent, childId, incoming, async (agent, heldSignal) => { await retarget(); return action(agent, heldSignal) }))
  try {
    await expect(test.owner.captureCurrent(test.lead, test.member.id, 'capture-race')).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  } finally { coldBorrow.mockRestore(); liveBorrow.mockRestore() }
  expect(test.owner.read(test.lead, test.member.id).control?.nextExecutionId).toBe(after)
})

it.each([false, true])('captures exact pending work from an actual resident maintenance phase (reader=%s)', async (withReader) => {
  const test = await setup({ script: ['hang'] })
  const execution = await residentHeld(test, 'live-capture')
  const pending = [...execution.inbox.nextStep, ...execution.inbox.nextTurn]
  const reader = (_id: SessionId, stored?: import('@deepseek-ai/dsh-agent').StoredInputCustodySnapshot) => {
    expect(stored).toBeUndefined()
    expect(test.ctx.agents.get(test.member.id)).toBe(execution)
    expect(() => execution.runMaintenance(async () => {})).toThrow(/active work/)
    return []
  }
  const captured = await test.owner.captureCurrent(test.lead, test.member.id, 'live-capture', signal,
    ...withReader ? [reader] : [])
  expect(captured.map(input => input.message)).toEqual(pending)
  expect(test.adapter.requests).toHaveLength(1)
})

it('refuses resident capture when its candidate changes during the blocker read', async () => {
  const test = await setup({ script: ['hang'] })
  const before = SessionId('live-capture-before'), after = SessionId('live-capture-after')
  const execution = await residentHeld(test, 'live-capture-change', before)
  const pending = [...execution.inbox.nextStep, ...execution.inbox.nextTurn]
  await expect(test.owner.captureCurrent(test.lead, test.member.id, 'live-capture-change', signal, async () => {
    await test.owner.retarget(test.lead, test.member.id, 'live-capture-change', before, after, record('live-capture-change:target'), () => [])
    return []
  })).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  expect([...execution.inbox.nextStep, ...execution.inbox.nextTurn]).toEqual(pending)
})

it('rejects a selected input disposition superseded by a new held operation', async () => {
  const test = await setup()
  await prepareHeld(test, 'disposition-before')
  const input: AgentInput = { message: createUserMessage({ content: text('Held input'), source: { kind: 'user' } }), target: 'next-turn', wakeup: false }
  await test.ctx.subagents.withContinuableExecution(test.lead, test.member.id, signal, async (agent) => {
    await test.ctx.agents.receiveInput(agent, input)
  })
  const original = test.ctx.subagents.withDormantContinuable.bind(test.ctx.subagents)
  let replaced = false
  const borrowing = vi.spyOn(test.ctx.subagents, 'withDormantContinuable').mockImplementation(async <T>(
    parent: Agent, childId: SessionId, input: InputControllerHandle, incoming: AbortSignal,
    action: (source: DormantContinuableScope | undefined, heldSignal: AbortSignal) => Promise<T>): Promise<T> => {
    if (!replaced) {
      replaced = true
      await test.owner.release(test.lead, test.member.id, 'disposition-before', record('disposition-before:stop'), () => [])
      await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'disposition-after', expectedGeneration: 1 },
        () => record('disposition-after:hold'))
    }
    return original(parent, childId, input, incoming, action)
  })
  try {
    await expect(test.owner.releaseCaptured(test.lead, test.member.id, 'disposition-before', [input.message.id], record('disposition-before:released')))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  } finally { borrowing.mockRestore() }
  expect((await events(test)).some(event => event.type === 'agent/input/released')).toBe(false)
  expect(test.owner.read(test.lead, test.member.id).control?.operationId).toBe('disposition-after')
})

it.each([false, true])('settles only a still-owned input after borrowing an actually resident source (superseded=%s)', async (superseded) => {
  const test = await setup()
  await prepareHeld(test, 'live-disposition-before')
  const input: AgentInput = { message: createUserMessage({ content: text('Resident held input'), source: { kind: 'user' } }),
    target: 'next-turn', wakeup: false }
  const entered = gate(), exit = gate(), requested = gate()
  const occupied = test.ctx.subagents.withContinuableExecution(test.lead, test.member.id, signal, async (execution) => {
    await test.ctx.agents.receiveInput(execution, input)
    entered.resolve()
    await exit.promise
  })
  await entered.promise
  const original = test.ctx.subagents.withContinuableExecution.bind(test.ctx.subagents)
  let replaced = false
  const borrowing = vi.spyOn(test.ctx.subagents, 'withContinuableExecution').mockImplementation(async <T>(
    parent: Agent, childId: SessionId, incoming: AbortSignal,
    action: (execution: Agent, heldSignal: AbortSignal) => Promise<T>): Promise<T> => {
    requested.resolve()
    if (superseded && !replaced) {
      replaced = true
      await test.owner.release(test.lead, test.member.id, 'live-disposition-before', record('live-disposition-before:stop'), () => [])
      await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'live-disposition-after', expectedGeneration: 1 },
        () => record('live-disposition-after:hold'))
    }
    return original(parent, childId, incoming, action)
  })
  const changing = test.owner.releaseCaptured(test.lead, test.member.id, 'live-disposition-before', [input.message.id],
    record('live-disposition-before:release'))
  const outcome = changing.then(() => ({ accepted: true }), (error: unknown) => ({ error }))
  try {
    await requested.promise
    exit.resolve()
    await occupied
    expect(await outcome).toMatchObject(superseded ? { error: { code: 'TEAM_MEMBER_OPERATION_STALE' } } : { accepted: true })
    const released = (await events(test)).filter(event => event.type === 'agent/input/released' && event.data.messageId === input.message.id)
    expect(released).toHaveLength(superseded ? 0 : 1)
    expect(test.adapter.requests).toHaveLength(0)
  } finally { exit.resolve(); borrowing.mockRestore(); await Promise.allSettled([occupied, outcome]) }
})

it.each(['release', 'commit', 'retarget'] as const)('disposes a %s whose external blocker callback never settles', async (kind) => {
  const test = await setup()
  const candidate = SessionId('nonsettling-blocker-candidate')
  await prepareCandidate(test, 'nonsettling-blocker', candidate)
  const entered = gate()
  const blockers = () => { entered.resolve(); return new Promise<readonly string[]>(() => {}) }
  const operation = kind === 'release'
    ? test.owner.release(test.lead, test.member.id, 'nonsettling-blocker', record('nonsettling-blocker:release'), blockers)
    : kind === 'commit' ? test.owner.commit(test.lead, test.member.id, 'nonsettling-blocker', record('nonsettling-blocker:commit'), blockers)
      : test.owner.retarget(test.lead, test.member.id, 'nonsettling-blocker', candidate, SessionId('nonsettling-blocker-next'), record('nonsettling-blocker:next'), blockers)
  const rejected = expect(operation).rejects.toMatchObject({ code: 'TEAM_MEMBER_OWNER_CLOSED' })
  await entered.promise
  await test.owner.dispose()
  await rejected
  expect(test.ctx.agentTeams.memberExecution(test.lead, test.member.id)?.generation).toBe(1)
  expect(test.lead.session.snapshotEvents().filter(event => event.type === 'team/member/control')).toHaveLength(1)
  expect(test.adapter.requests).toHaveLength(0)
})

it('cancels a nonsettling cold anchor resolver without leaving a half-created child or waiting on the resolver', async () => {
  const first = await setup()
  await prepareHeld(first)
  const cold = await coldContext(first)
  const entered = gate()
  const owner = cold.ctx.agentTeams.installMemberExecutions({ id: 'focused-member-owner', resolveAnchor: () => {
    entered.resolve(); return new Promise<Agent>(() => {})
  } })
  const pending = cold.resume()
  const rejected = expect(pending).rejects.toMatchObject({ code: 'TEAM_MEMBER_OWNER_CLOSED' })
  await entered.promise
  await owner.dispose()
  await rejected
  expect(cold.ctx.agents.get(first.member.id)).toBeUndefined()
  expect(cold.adapter.requests).toHaveLength(0)
})

it('cancels nonsettling initial material before any working input or model request is admitted', async () => {
  const entered = gate()
  const test = await setup({ provider: { initialMaterial: () => {
    entered.resolve(); return new Promise<readonly import('../src/member-runtime.ts').TeamMemberMaterial[]>(() => {})
  } } })
  const pending = test.ctx.subagents.startContinuable({ childId: test.member.id, provider: 'spawn', label: 'standard', preset: test.member.preset!,
    request: { parent: test.lead, prompt: text('Must await initial material') }, signal })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'TEAM_MEMBER_OWNER_CLOSED' })
  await entered.promise
  await test.owner.dispose()
  await rejected
  expect(test.ctx.agents.get(test.member.id)).toBeUndefined()
  expect(test.adapter.requests).toHaveLength(0)
})

it('waits for real source maintenance outside the Team lock before releasing admission', async () => {
  const test = await setup()
  await prepareHeld(test, 'maintenance-release')
  const entered = gate(), exit = gate()
  const occupied = test.ctx.subagents.withContinuableExecution(test.lead, test.member.id, signal, async (execution) => {
    expect(test.ctx.agents.canStartInput(execution)).toBe(false)
    entered.resolve(); await exit.promise
  })
  await entered.promise
  let released = false
  const pending = test.owner.release(test.lead, test.member.id, 'maintenance-release', record('maintenance-release:ready'), () => [])
    .then(() => { released = true })
  try {
    expect(await test.ctx.agentTeams.readCompositionLocked(test.lead, snapshot => snapshot.composition.phase)).toBe('dynamic')
    expect(released).toBe(false)
    expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
    exit.resolve(); await occupied; await pending
    expect(test.ctx.agents.get(test.member.id)).toBeUndefined()
    expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(false)
    expect(test.adapter.requests).toHaveLength(0)
  } finally { exit.resolve(); await Promise.allSettled([occupied, pending]) }
})

it('keeps a cold original writer exclusively owned until the confirmed release has handed it back', async () => {
  const test = await setup()
  await prepareHeld(test, 'maintenance-return')
  const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
  let observed = false
  const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (session.id === test.lead.id && test.owner.read(test.lead, test.member.id).control?.held === false && !observed) {
      observed = true
      expect(test.ctx.agents.get(test.member.id)).toBeUndefined()
      await expect(test.ctx.sessionPersistence.open(test.member.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    }
    return original(session)
  })
  try { await test.owner.release(test.lead, test.member.id, 'maintenance-return', record('maintenance-return:ready'), () => []) }
  finally { flush.mockRestore() }
  expect(observed).toBe(true)
  expect(test.ctx.agents.get(test.member.id)).toBeUndefined()
  const source = await test.ctx.sessionPersistence.open(test.member.id, 'write')
  await source.close()
  expect(test.adapter.requests).toHaveLength(0)
})

it.each(['record', 'recordRoster'] as const)('does not acknowledge %s after a false checkpoint and confirms its identical retry once', async (kind) => {
  const test = await setup()
  const value = record(`unconfirmed-${kind}:progress`)
  const write = () => kind === 'record' ? test.owner.record(test.lead, test.member.id, 'progress', value)
    : test.owner.recordRoster(test.lead, value)
  const failed = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
  await expect(write()).rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
  expect(test.owner.recordsConfirmed(test.lead)).toBe(false)
  expect(test.owner.read(test.lead, test.member.id).confirmed).toBe(false)
  failed.mockRestore()
  await write()
  expect(test.owner.recordsConfirmed(test.lead)).toBe(true)
  expect(test.owner.read(test.lead, test.member.id).confirmed).toBe(true)
  expect(test.lead.session.snapshotEvents().filter(event => event.type === 'team/extension')).toHaveLength(1)
})

it.each(['record', 'recordRoster'] as const)('retains an unconfirmed %s fact after a throwing checkpoint until its exact retry is confirmed', async (kind) => {
  const test = await setup()
  const value = record(`throwing-${kind}:progress`)
  const write = () => kind === 'record' ? test.owner.record(test.lead, test.member.id, 'progress', value)
    : test.owner.recordRoster(test.lead, value)
  const failed = vi.spyOn(test.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk checkpoint failed'))
  await expect(write()).rejects.toThrow('disk checkpoint failed')
  expect(test.owner.recordsConfirmed(test.lead)).toBe(false)
  expect(test.owner.read(test.lead, test.member.id).confirmed).toBe(false)
  failed.mockRestore()
  await write()
  expect(test.owner.recordsConfirmed(test.lead)).toBe(true)
  expect(test.owner.read(test.lead, test.member.id).confirmed).toBe(true)
  expect(test.lead.session.snapshotEvents().filter(event => event.type === 'team/extension')).toHaveLength(1)
})

it('rejects every working input source on a past execution and retains only non-waking factual reference custody', async () => {
  const test = await setup()
  const candidate = SessionId('old-input-successor')
  await prepareHeld(test, 'old-input', candidate)
  await test.ctx.subagents.prepareContinuable({ childId: candidate, provider: 'spawn', label: 'standard', preset: test.member.preset!,
    request: { parent: test.lead }, signal })
  await test.owner.commit(test.lead, test.member.id, 'old-input', record('old-input:commit'), () => [])
  await test.ctx.subagents.withContinuableExecution(test.lead, test.member.id, signal, async (old) => {
    const sources: readonly MessageSource[] = [{ kind: 'user' },
      { kind: 'team-message', teamId: TeamId(test.lead.id), senderId: test.lead.id, senderName: 'lead', messageId: TeamMessageId('late-team-input') },
      { kind: 'agent-message', form: 'relay', senderSessionId: test.lead.id }]
    for (const source of sources) await expect(test.ctx.agents.receiveInput(old, { message: createUserMessage({ content: text('Old work'), source }),
      target: 'next-step', wakeup: false })).rejects.toThrow('working input requires the current member execution')
    const passive = createUserMessage({ content: text('Historical reference'), source: { kind: 'agent-instructions', form: 'instructions', changes: [] } })
    expect(await test.ctx.agents.receiveInput(old, { message: passive, target: 'next-step', wakeup: false })).toMatchObject({ location: 'held' })
  })
  expect(test.adapter.requests).toHaveLength(0)
})

it('keeps a foreign owner from capturing or recording another owner’s held operation', async () => {
  const test = await setup()
  await prepareHeld(test)
  await test.owner.dispose()
  const other = test.ctx.agentTeams.installMemberExecutions({ id: 'other-member-owner' })
  await test.owner.dispose()
  await expect(other.captureCurrent(test.lead, test.member.id, 'held-source')).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  await expect(other.record(test.lead, test.member.id, 'held-source', record('foreign-progress'))).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  await expect(other.releaseCaptured(test.lead, test.member.id, 'held-source', [], record('foreign-disposition')))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  await other.recordRoster(test.lead, record('other-owner-still-installed'))
  expect(other.recordsConfirmed(test.lead)).toBe(true)
  await other.dispose()
})

it('ignores ordinary roots and official children when the optional member material owner is installed', async () => {
  const test = await nativeFacadeHarness({ script: ['hang'] })
  const material = vi.fn(async () => [])
  const owner = test.ctx.agentTeams.installMemberExecutions({ id: 'official-member-owner', initialMaterial: material })
  const member = (await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'official-worker', description: 'Original official behavior',
    context: 'fresh', provider: 'spawn', prompt: text('Original working prompt'), signal })).member
  const execution = await vi.waitFor(() => {
    const current = test.ctx.agents.get(member.id)
    expect(current?.status).toBe('running'); return current!
  })
  const ordinary = await test.ctx.agents.create({ sessionId: SessionId('ordinary-root-after-owner'), agentOptions: { provider: 'mock', model: 'mock' } })
  expect(test.ctx.agents.isInputControlled(execution.session)).toBe(false)
  expect(test.ctx.agents.isInputControlled(ordinary.agent.session)).toBe(false)
  expect(material).not.toHaveBeenCalled()
  expect(test.adapter.requests[0]?.messages.some(message => message.content.some(block => block.type === 'text'
    && block.text.includes('Original working prompt')))).toBe(true)
  test.ctx.agentTeams.interrupt(test.lead, member.name); await execution.whenIdle()
  await ordinary.dispose(); await owner.dispose()
})

it('refuses reference preloading after the recorded member has retired', async () => {
  const test = await setup({ provider: { initialMaterial: async () => [] } })
  await prepareHeld(test, 'retired-source')
  await test.owner.release(test.lead, test.member.id, 'retired-source', record('retired-source:ready'), () => [])
  await test.ctx.agentTeams.retireTeammate(test.lead, test.member.name)
  const old = await test.ctx.agents.resume({ resumeSessionId: test.member.id, agentOptions: { provider: 'mock', model: 'mock' } })
  expect(test.ctx.agents.canStartInput(old.agent)).toBe(false)
  await expect(test.owner.preloadMaterial(test.lead, test.owner.read(test.lead, test.member.id).execution, []))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  expect(test.adapter.requests).toHaveLength(0)
  await old.dispose()
})

it('stops preloading further reference records after the member becomes held during its first receipt', async () => {
  const test = await setup({ script: ['hang'] })
  await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Working'), signal })
  const execution = await vi.waitFor(() => {
    const current = test.ctx.agents.get(test.member.id)
    expect(current?.status).toBe('running'); return current!
  })
  const binding = test.owner.read(test.lead, test.member.id).execution
  await test.owner.record(test.lead, test.member.id, 'reference-race', record('reference-race:first'))
  await test.owner.record(test.lead, test.member.id, 'reference-race', record('reference-race:second'))
  const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
  let held = false
  const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (session.id === execution.id && !held) {
      held = true
      await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'reference-race', expectedGeneration: 1 },
        () => record('reference-race:hold'))
    }
    return original(session)
  })
  try {
    await expect(test.owner.preloadMaterial(test.lead, binding, [
      { recordId: 'reference-race:first', content: text('First recorded reference') },
      { recordId: 'reference-race:second', content: text('Second recorded reference') },
    ])).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  } finally { flush.mockRestore() }
  expect(execution.inbox.nextStep.filter(message => message.source.kind === 'team-member-material')).toHaveLength(1)
  expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
  test.ctx.agentTeams.interrupt(test.lead, test.member.name); await execution.whenIdle()
})

it('rechecks the abandoned candidate after external safety checks materialize it', async () => {
  const test = await setup()
  const candidate = SessionId('retarget-materialized-during-checks')
  await prepareCandidate(test, 'retarget-materialized', candidate)
  const entered = gate(), exit = gate()
  let maintenance: Promise<void> | undefined
  try {
    await expect(test.owner.retarget(test.lead, test.member.id, 'retarget-materialized', candidate, SessionId('retarget-materialized-next'),
      record('retarget-materialized:next'), async () => {
        maintenance = test.ctx.subagents.withContinuableExecution(test.lead, candidate, signal, async () => {
          entered.resolve(); await exit.promise
        })
        await entered.promise; return []
      })).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
    expect(test.owner.read(test.lead, test.member.id).control?.nextExecutionId).toBe(candidate)
  } finally { exit.resolve(); await maintenance }
  expect(test.adapter.requests).toHaveLength(0)
})

it('closes a live input policy immediately while its admitted record is still draining during disposal', async () => {
  const test = await setup()
  await prepareHeld(test, 'draining-owner')
  await test.ctx.subagents.withContinuableExecution(test.lead, test.member.id, signal, async (execution) => {
    const entered = gate(), exit = gate()
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session.id === test.lead.id) { entered.resolve(); await exit.promise }
      return original(session)
    })
    const pending = test.owner.recordRoster(test.lead, record('draining-owner:progress'))
    await entered.promise
    const disposal = test.owner.dispose()
    try {
      expect(() => test.owner.read(test.lead, test.member.id)).toThrow(expect.objectContaining({ code: 'TEAM_MEMBER_OWNER_CLOSED' }))
      expect(test.ctx.agents.canStartInput(execution)).toBe(false)
      expect(test.ctx.agents.canClaimInput(execution)).toBe(false)
      exit.resolve(); await pending; await disposal
    } finally { exit.resolve(); flush.mockRestore(); await Promise.allSettled([pending, disposal]) }
  })
  expect(test.adapter.requests).toHaveLength(0)
})

it('refuses releasing a live source whose artifact disappeared instead of treating it as an unborn member', async () => {
  const test = await setup({ script: ['hang'] })
  const execution = await residentHeld(test, 'missing-artifact')
  const directory = join(test.resources.root, '_no-cwd', test.member.id)
  const parked = join(test.resources.root, 'parked-member-artifact')
  expect(existsSync(directory)).toBe(true)
  expect(existsSync(parked)).toBe(false)
  renameSync(directory, parked)
  try {
    expect(await test.ctx.sessionPersistence.stat(test.member.id)).toBeUndefined()
    expect(test.ctx.agents.get(test.member.id)).toBe(execution)
    const outcome = await test.owner.release(test.lead, test.member.id, 'missing-artifact', record('missing-artifact:ready'), () => [])
      .then(() => ({ accepted: true }), (error: unknown) => ({ error }))
    expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
    expect(outcome).toHaveProperty('error')
  } finally { renameSync(parked, directory) }
  expect(test.adapter.requests).toHaveLength(1)
})

it.each(['preset', 'parent', 'ordinary'] as const)('refuses a prepared candidate from another %s configuration without replacing the current binding', async (change) => {
  const test = await setup()
  const candidate = SessionId('mismatched-candidate')
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'mismatched-candidate', expectedGeneration: 1, nextExecutionId: candidate },
    () => record('mismatched-candidate:hold'))
  if (change === 'ordinary') {
    const ordinary = await test.ctx.agents.create({ sessionId: candidate, meta: { parentSession: test.lead.id },
      agentOptions: { provider: 'mock', model: 'mock' } })
    await ordinary.dispose()
  } else {
    const parent = change === 'parent' ? (await test.ctx.agents.create({ sessionId: SessionId('another-candidate-parent'),
      agentOptions: { provider: 'mock', model: 'mock' } })).agent : test.lead
    await using selected = await test.ctx.agentPresets.acquireComposition(change === 'preset' ? 'reviewer' : 'standard')
    if (selected.revision === undefined) throw new Error('fixture needs the declared Preset revision')
    await test.ctx.subagents.prepareContinuable({ childId: candidate, provider: 'spawn', label: selected.id,
      preset: { id: selected.id, revision: selected.revision }, request: { parent }, signal })
  }
  await expect(test.owner.commit(test.lead, test.member.id, 'mismatched-candidate', record('mismatched-candidate:commit'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_PRESET_UNAVAILABLE' })
  expect(test.ctx.agentTeams.memberExecution(test.lead, test.member.id)?.generation).toBe(1)
  expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
  expect(test.adapter.requests).toHaveLength(0)
})

it('retains generation-two reference source metadata when a fresh raw Session reader has no Team producer installed', async () => {
  const test = await setup({ script: ['hang', textResponse('Lead observed')], provider: { initialMaterial: async (_anchor, execution) => execution.generation === 2
    ? [{ recordId: 'raw-reference:commit', content: text('Reference only; no approval or authority is transferred') }] : [] } })
  const candidate = SessionId('raw-reference-generation-two')
  await prepareCandidate(test, 'raw-reference', candidate)
  await test.owner.commit(test.lead, test.member.id, 'raw-reference', record('raw-reference:commit'), () => [])
  await test.owner.release(test.lead, test.member.id, 'raw-reference', record('raw-reference:ready'), () => [])
  await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Start the new execution'), signal })
  const execution = await vi.waitFor(() => {
    const current = test.ctx.agents.get(candidate)
    expect(current?.status).toBe('running'); return current!
  })
  const reference = execution.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'team-member-material')
  if (reference?.type !== 'user/message') throw new Error('new execution did not receive its actual reference')
  expect(reference.data.source).toEqual({ kind: 'team-member-material', form: 'recall', teamId: test.lead.id,
    memberId: test.member.id, generation: 2, ownerId: 'focused-member-owner', recordId: 'raw-reference:commit' })
  test.ctx.agentTeams.interrupt(test.lead, test.member.name)
  await execution.whenIdle()
  await vi.waitFor(() => { expect(test.ctx.agents.get(candidate)).toBeUndefined() })
  const reader = new Context()
  test.resources.contexts.push(reader)
  await mountAgentLoopTestDependencies(reader)
  await reader.plugin(JsonlSessionPersistence, { root: test.resources.root })
  expect(reader.get('agentTeams')).toBeUndefined()
  const stored = await reader.sessionPersistence.open(candidate, 'read')
  try {
    const read = await stored.read()
    const actual = read.events.find(event => event.type === 'user/message' && event.data.source.kind === 'team-member-material')
    expect(actual).toEqual(reference)
  } finally { await stored.close() }
})

it('rejects concurrent release retries that share audit text but request different Profile effects', async () => {
  const test = await setup({ script: ['hang'] })
  const transfer = await profileTransfer(test)
  await residentHeld(test, 'slot-effect-release')
  const pair = serialBlockers()
  const { firstGate, secondGate, firstEntered, secondEntered } = pair
  const first = test.owner.release(test.lead, test.member.id, 'slot-effect-release', record('slot-effect-release:ready'), pair.first, transfer)
  const second = test.owner.release(test.lead, test.member.id, 'slot-effect-release', record('slot-effect-release:ready'), pair.second)
  const outcome = second.then(() => ({ kind: 'accepted' }), (error: unknown) => ({ kind: 'rejected', error }))
  try {
    await firstEntered.promise
    expect(pair.reads()).toBe(1)
    firstGate.resolve(); await first
    await secondEntered.promise
    secondGate.resolve()
    expect(await outcome).toMatchObject({ kind: 'rejected', error: { code: 'TEAM_MEMBER_OPERATION_STALE' } })
    expect(test.ctx.agentTeams.composition(test.lead).slotBindings).toEqual([{ slotId: 'research', memberId: transfer.toMemberId }])
    expect(test.lead.session.snapshotEvents().filter(event => event.type === 'team/member/control')).toHaveLength(2)
  } finally { firstGate.resolve(); secondGate.resolve(); await Promise.allSettled([first, second]) }
})

it('refuses abandoning a candidate with held waking input even when it has never started a model turn', async () => {
  const test = await setup()
  const candidate = SessionId('candidate-with-other-held-custody')
  const custody = test.ctx.agents.registerInputController(InputControllerId('other-preparation-custody'), {
    initialize: (session) => { if (session.id === candidate) custody.bind(session) },
    admit: () => ({ kind: 'hold' }), canStart: () => false, canClaim: () => false,
  })
  await test.ctx.subagents.prepareContinuable({ childId: candidate, provider: 'spawn', label: 'standard', preset: test.member.preset!,
    request: { parent: test.lead }, signal })
  await test.ctx.subagents.withContinuableExecution(test.lead, candidate, signal, async (execution) => {
    await test.ctx.agents.receiveInput(execution, { message: createUserMessage({ content: text('Previously admitted work'), source: { kind: 'user' } }),
      target: 'next-turn', wakeup: true })
  })
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'held-candidate-input', expectedGeneration: 1, nextExecutionId: candidate },
    () => record('held-candidate-input:hold'))
  const stored = await events(test, candidate)
  expect(stored.some(event => event.type === 'turn/start')).toBe(false)
  expect(stored.some(event => event.type === 'agent/input/held' && event.data.input.wakeup)).toBe(true)
  await expect(test.owner.retarget(test.lead, test.member.id, 'held-candidate-input', candidate, SessionId('held-candidate-input-next'),
    record('held-candidate-input:next'), () => [])).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  await custody.dispose()
  expect(test.adapter.requests).toHaveLength(0)
})

it('refuses a Profile application while a member change owns admission and leaves the current composition intact', async () => {
  const test = await setup()
  expect(test.ctx.agentTeams.memberExecution(test.lead, SessionId('foreign-logical-member'))).toBeUndefined()
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'profile-conflict', expectedGeneration: 1 },
    () => record('profile-conflict:hold'))
  await expect(test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'begin', applicationId: 'conflicting-profile',
    profileId: 'profile', profileVersion: 1, targetJson: '{}', retiringMemberIds: [], previousPhase: 'dynamic' })))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_HELD' })
  expect(test.ctx.agentTeams.composition(test.lead).phase).toBe('dynamic')
})

it('rejects delayed member collaboration and unrelated retirement after its operation holds admission', async () => {
  const test = await setup({ script: ['hang'] })
  await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Working'), signal })
  const execution = await vi.waitFor(() => {
    const current = test.ctx.agents.get(test.member.id)
    expect(current?.status).toBe('running'); return current!
  })
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'held-collaboration', expectedGeneration: 1 },
    () => record('held-collaboration:hold'))
  await expect(test.ctx.agentTeams.sendMessage(execution, { target: 'lead', content: text('Delayed operation'), signal }))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_HELD' })
  await expect(test.ctx.agentTeams.retireTeammate(test.lead, test.member.name)).rejects.toMatchObject({ code: 'TEAM_MEMBER_HELD' })
  test.ctx.agentTeams.interrupt(test.lead, test.member.name); await execution.whenIdle()
})

it('refuses duplicate selected mailbox identities before recording any cancellation', async () => {
  const test = await setup()
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'duplicate-selection', expectedGeneration: 1 },
    () => record('duplicate-selection:hold'))
  const sent = await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Pending work'), signal })
  await expect(test.ctx.agentTeams.cancelPendingMessages(test.lead, test.member.name, 'Selected disposition', [sent.messageId, sent.messageId]))
    .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
  expect(test.lead.session.snapshotEvents().filter(event => event.type === 'team/message/cancelled')).toHaveLength(0)
})

it('refuses reserved provisioning in the official combination before creating or running a child', async () => {
  const test = await nativeFacadeHarness()
  await expect(test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'official-reserved-member', description: 'Official worker',
    provider: 'spawn', context: 'fresh', presetId: 'standard', reservedMemberId: SessionId('official-reserved-id'),
    prompt: text('Must not run'), signal })).rejects.toMatchObject({ code: 'TEAM_MODE_REQUIRED' })
  expect(test.ctx.agentTeams.listMembers(test.lead)).toHaveLength(1)
  expect(test.adapter.requests).toHaveLength(0)
})

it('preserves the current generation on an identical creation retry and rejects root or candidate identity collisions', async () => {
  const test = await setup()
  const candidate = SessionId('reserved-execution-collision')
  await prepareCandidate(test, 'reserved-creation', candidate)
  const request = { name: 'unrelated-reserved-member', provider: 'spawn', context: 'fresh' as const, presetId: 'standard',
    prompt: text('Unused registration prompt'), signal }
  for (const id of [test.lead.id, candidate]) {
    await expect(test.ctx.agentTeams.spawnTeammate(test.lead, { ...request, reservedMemberId: id }))
      .rejects.toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })
  }
  await test.owner.commit(test.lead, test.member.id, 'reserved-creation', record('reserved-creation:commit'), () => [])
  await test.owner.release(test.lead, test.member.id, 'reserved-creation', record('reserved-creation:ready'), () => [])
  const retried = await test.ctx.agentTeams.spawnTeammate(test.lead, { ...request,
    name: test.member.name, reservedMemberId: test.member.id })
  expect(retried.member.execution).toEqual({ memberId: test.member.id, executionId: candidate, generation: 2 })
  expect(test.ctx.agentTeams.listMembers(test.lead)).toHaveLength(2)
  expect(test.adapter.requests).toHaveLength(0)
})

it('does not reuse a reserved creation identity after its member has retired', async () => {
  const test = await setup()
  await test.ctx.agentTeams.retireTeammate(test.lead, test.member.name)
  await expect(test.ctx.agentTeams.spawnTeammate(test.lead, { name: test.member.name, provider: 'spawn', context: 'fresh', presetId: 'standard',
    reservedMemberId: test.member.id, prompt: text('Unused registration prompt'), signal }))
    .rejects.toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })
  expect(test.ctx.agentTeams.listMembers(test.lead)[1]?.status).toBe('retired')
  expect(test.adapter.requests).toHaveLength(0)
})
