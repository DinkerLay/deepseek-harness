import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService, { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import type { SubagentSettlementNoticeFacts, SubagentSettlementNoticeWording } from '@deepseek-ai/dsh-subagent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { deliverSubagentPrompt, type HostPromptDeliverer } from '@deepseek-ai/dsh-subagent/internal'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService, { TeamError, TeamId, TeamMessageId, TeamTaskId } from '../src/index.ts'
import { TeamRuntimeLifecycle } from '../src/lifecycle.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { TeamMemberSnapshot, TeamMessageCancellation, TeamMessageSnapshot, TeamTaskSnapshot } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import SessionQuery from '@deepseek-ai/dsh-session-query'

const SIGNAL = new AbortController().signal
const PRESET_TOOL = new URL('../../../subagent/subagent-in-process-driver/tests/fixtures/plugins/preset-tool.js', import.meta.url).href
const roots: string[] = []
const contexts: Context[] = []

/** Real point-observation reader; these tests do not exercise corpus search. */
class CompleteSessionQuery extends SessionQuery {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('search is not used')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('search is not used')) }
}

afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Detached durable Team read through the same projection definition as the service. */
function durable(agent: Agent): {
  members: readonly TeamMemberSnapshot[]
  tasks: readonly TeamTaskSnapshot[]
  pendingMessages: readonly TeamMessageSnapshot[]
  cancelled: readonly TeamMessageCancellation[]
} {
  let projected = teamProjectionDefinition.init(agent.session.header)
  for (const event of agent.session.snapshotEvents()) projected = teamProjectionDefinition.apply(projected, event)
  if (projected.failure !== undefined) throw new Error(projected.failure)
  const state = projected
  return {
    members: state.members,
    tasks: state.tasks,
    pendingMessages: state.messages.filter(message => !state.delivered.includes(message.id)
      && !state.cancelled.some(item => item.messageId === message.id)),
    cancelled: state.cancelled,
  }
}

/** Read one stored session's full event log through a short-lived read handle. */
async function storedEvents(ctx: Context, id: SessionId): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0],
  config: ConstructorParameters<typeof TeamService>[1] = {},
  withPresets = false,
  completeObservations = false,
) {
  const ctx = new Context()
  contexts.push(ctx)
  if (withPresets) await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
  let removeReviewer: (() => Promise<void>) | undefined
  if (withPresets) {
    await ctx.plugin(AgentPresets, { default: 'standard' })
    await ctx.agentPresets.register({ id: 'standard', plugins: [] })
    removeReviewer = await ctx.agentPresets.register({
      id: 'reviewer', plugins: [{ name: PRESET_TOOL, config: { tool: 'review_only' } }],
    })
  }
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  if (completeObservations) await ctx.plugin(CompleteSessionQuery)
  else await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  const teamFiber = await ctx.plugin(TeamService, config)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead, adapter, storageRoot, teamFiber, removeReviewer }
}

function content(text: string) {
  return [{ type: 'text' as const, text }]
}

interface TeamServiceInternals {
  readonly roster: {
    readonly inFlightCreations: Set<Promise<unknown>>
    checkpointInitialPrompt(childId: SessionId, messageId: string, signal: AbortSignal): Promise<void>
    reconcileProvisioning(root: Agent, signal: AbortSignal): Promise<void>
    liveChildrenByRoot(): Map<Agent, SessionId[]>
  }
  readonly mailbox: {
    tryDispatch(root: Agent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean>
    serializeTarget(targetId: SessionId, operation: () => Promise<boolean>): Promise<boolean>
    markDelivered(root: Agent, messageId: ReturnType<typeof TeamMessageId>, targetId: SessionId): Promise<void>
  }
  readonly journal: {
    state(root: Agent): unknown
  }
  disposeRuntime(): Promise<void>
  recoverFor(agent: Agent): Promise<void>
  scheduleRecovery(agent: Agent): void
}

/** White-box access follows the runtime owners so coverage does not widen the service API. */
function teamInternals(ctx: Context): TeamServiceInternals {
  return ctx.agentTeams as unknown as TeamServiceInternals
}

function spawn(
  ctx: Context,
  lead: Agent,
  name: string,
  options: { context?: 'fresh' | 'fork'
    provider?: string
    presetId?: string
    group?: string
    expectedPresetRevision?: string
    applicationId?: string
    slotId?: string } = {},
) {
  const context = options.context ?? 'fresh'
  return ctx.agentTeams.spawnTeammate(lead, {
    name,
    description: `${name} responsibility`,
    prompt: content(`${name} initial`),
    context,
    provider: options.provider ?? (context === 'fork' ? 'fork' : 'spawn'),
    ...options.presetId === undefined ? {} : { presetId: options.presetId },
    ...options.group === undefined ? {} : { group: options.group },
    ...options.expectedPresetRevision === undefined ? {} : { expectedPresetRevision: options.expectedPresetRevision },
    ...options.applicationId === undefined ? {} : { applicationId: options.applicationId },
    ...options.slotId === undefined ? {} : { slotId: options.slotId },
    signal: SIGNAL,
  })
}

async function waitNoAgent(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 5_000 })
}

async function waitRunning(ctx: Context, id: SessionId): Promise<Agent> {
  return vi.waitFor(() => {
    const agent = ctx.agents.get(id)
    expect(agent?.status).toBe('running')
    return agent!
  }, { timeout: 5_000 })
}

describe('controlled member execution ownership', () => {
  it('records non-started no-op and roster intents without holding or waking a member', async () => {
    const { ctx, lead, adapter } = await setup([], { maxTaskExtensionBytes: 10_000, controlledMode: { kind: 'controlled',
      requiredTaskExtensionId: 'test-managed-writer', permissionTableId: 'groups',
      permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const writer = ctx.agentTeams.installTaskExtension({ id: 'test-managed-writer',
      validateMemberGroup: () => undefined, create: unavailable, update: unavailable })
    const owner = ctx.agentTeams.installMemberExecutions({ id: 'member-operations' })
    const member = (await spawn(ctx, lead, 'unused')).member
    const roster = { recordId: 'add-intent', dataJson: '{"reserved":"new-member"}' }
    await owner.recordRoster(lead, (cut) => { expect(cut.members).toHaveLength(1); return roster })
    await owner.recordRoster(lead, roster)
    await expect(owner.recordRoster(lead, { ...roster, dataJson: '{}' })).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
    const noop = { recordId: 'unused:no-op', dataJson: '{"phase":"completed"}' }
    await owner.record(lead, member.id, 'unused', (cut) => { expect(cut.execution.generation).toBe(1); return noop })
    await owner.record(lead, member.id, 'unused', noop)
    await expect(owner.record(lead, member.id, 'unused', { ...noop, dataJson: '{}' }))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
    await expect(owner.recordRoster(lead, { recordId: 'bad-json', dataJson: '?' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(owner.recordRoster(lead, { recordId: 'oversized', dataJson: JSON.stringify('x'.repeat(200_000)) }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_TOO_LARGE' })
    expect(owner.read(lead, member.id).control).toBeUndefined()
    expect(adapter.requests).toHaveLength(0)
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/extension')).toHaveLength(2)
    await owner.dispose(); writer.dispose()
  })

  it('reserves one creation identity, rejects conflicting retries, and cancels only the confirmed message selection', async () => {
    const { ctx, lead, adapter } = await setup([], { maxMembers: 1, maxActiveMembers: 1,
      controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'test-managed-writer',
        permissionTableId: 'groups', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const writer = ctx.agentTeams.installTaskExtension({ id: 'test-managed-writer',
      validateMemberGroup: () => undefined, create: unavailable, update: unavailable })
    const owner = ctx.agentTeams.installMemberExecutions({ id: 'member-operations' })
    const request = { name: 'reserved', provider: 'spawn', context: 'fresh' as const, presetId: 'standard',
      prompt: content('unused controlled registration prompt'), reservedMemberId: SessionId('reserved-member'), signal: SIGNAL }
    const member = (await ctx.agentTeams.spawnTeammate(lead, request)).member
    expect((await ctx.agentTeams.spawnTeammate(lead, request)).member.id).toBe(member.id)
    await expect(ctx.agentTeams.spawnTeammate(lead, { ...request, name: 'changed' })).rejects.toBeInstanceOf(TeamError)
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(2)
    await owner.hold(lead, { memberId: member.id, operationId: 'messages', expectedGeneration: 1 },
      () => ({ recordId: 'messages:hold', dataJson: '{}' }))
    const first = await ctx.agentTeams.sendMessage(lead, { target: member.name, content: content('first'), signal: SIGNAL })
    const second = await ctx.agentTeams.sendMessage(lead, { target: member.name, content: content('second'), signal: SIGNAL })
    await expect(ctx.agentTeams.cancelPendingMessages(lead, member.name, 'recorded disposition', [first.messageId]))
      .rejects.toBeInstanceOf(TeamError)
    expect(durable(lead).cancelled).toHaveLength(0)
    await ctx.agentTeams.cancelPendingMessages(lead, member.name, 'recorded disposition', [first.messageId, second.messageId])
    const third = await ctx.agentTeams.sendMessage(lead, { target: member.name, content: content('later'), signal: SIGNAL })
    await ctx.agentTeams.cancelPendingMessages(lead, member.name, 'recorded disposition', [first.messageId, second.messageId])
    expect(durable(lead).pendingMessages.map(item => item.id)).toEqual([third.messageId])
    expect(adapter.requests).toHaveLength(0)
    await owner.dispose(); writer.dispose()
  })

  it('retargets an unused candidate without opening the held source or reusing the old reservation', async () => {
    const { ctx, lead, adapter } = await setup([], { controlledMode: { kind: 'controlled',
      requiredTaskExtensionId: 'test-managed-writer', permissionTableId: 'groups',
      permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true, true)
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const writer = ctx.agentTeams.installTaskExtension({ id: 'test-managed-writer',
      validateMemberGroup: () => undefined, create: unavailable, update: unavailable })
    const owner = ctx.agentTeams.installMemberExecutions({ id: 'member-operations' })
    const member = (await spawn(ctx, lead, 'candidate-worker')).member
    const first = SessionId('candidate-first'), second = SessionId('candidate-second')
    await owner.hold(lead, { memberId: member.id, operationId: 'retry', expectedGeneration: 1, nextExecutionId: first },
      () => ({ recordId: 'retry:hold', dataJson: '{}' }))
    await ctx.subagents.prepareContinuable({ childId: first, provider: 'spawn', label: 'standard',
      preset: member.preset!, request: { parent: lead }, signal: SIGNAL })
    const record = { recordId: 'retry:target-2', dataJson: '{}' }
    await expect(owner.retarget(lead, member.id, 'retry', first, second, record, () => ['unknown outcome']))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_BLOCKED' })
    await owner.retarget(lead, member.id, 'retry', first, second, record, () => [])
    await owner.retarget(lead, member.id, 'retry', first, second, record, () => [])
    expect(owner.read(lead, member.id).control).toMatchObject({ held: true, nextExecutionId: second })
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/member/candidate')).toHaveLength(1)
    await expect(owner.retarget(lead, member.id, 'retry', second, first,
      { recordId: 'retry:invalid', dataJson: '{}' }, () => [])).rejects.toBeInstanceOf(TeamError)
    await ctx.subagents.prepareContinuable({ childId: second, provider: 'spawn', label: 'standard',
      preset: member.preset!, request: { parent: lead }, signal: SIGNAL })
    const committed = await owner.commit(lead, member.id, 'retry', { recordId: 'retry:commit', dataJson: '{}' }, () => [])
    expect(committed.executionId).toBe(second)
    await owner.release(lead, member.id, 'retry', { recordId: 'retry:release', dataJson: '{}' }, () => [])
    expect(adapter.requests).toHaveLength(0)
    await owner.dispose(); writer.dispose()
  })

  it('prepares and binds a new execution without a second member or a candidate model request', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('old coordination'), textResponse('Lead observed'), 'hang'],
      { controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'test-managed-writer',
        permissionTableId: 'groups', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true, true)
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const writer = ctx.agentTeams.installTaskExtension({ id: 'test-managed-writer',
      validateMemberGroup: () => undefined, create: unavailable, update: unavailable })
    const owner = ctx.agentTeams.installMemberExecutions({ id: 'member-operations',
      initialMaterial: async (_anchor, execution) => execution.generation === 1 ? [] : [{
        recordId: 'renew-worker:bound', content: content('Reference only: continue from the Task Board, no inherited approval.'),
      }] })
    const member = (await spawn(ctx, lead, 'renew-worker')).member
    await ctx.agentTeams.sendMessage(lead, { target: member.name, content: content('initial coordination'), signal: SIGNAL })
    await waitNoAgent(ctx, member.id)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    await lead.whenIdle()
    const beforeRequests = adapter.requests.length
    const nextId = SessionId('renewed-worker-session')
    await owner.hold(lead, { memberId: member.id, operationId: 'renew-worker', expectedGeneration: 1,
      nextExecutionId: nextId }, () => ({ recordId: 'renew-worker:start', dataJson: '{}' }))
    const preset = member.preset
    if (preset === undefined) throw new Error('expected declared controlled Preset')
    await ctx.subagents.prepareContinuable({ childId: nextId, provider: 'spawn', label: 'standard',
      preset, request: { parent: lead }, signal: SIGNAL })
    expect(adapter.requests).toHaveLength(beforeRequests)
    expect(ctx.agentTeams.memberExecution(lead, member.id)?.executionId).toBe(member.id)
    const record = { recordId: 'renew-worker:bound', dataJson: '{"phase":"bound"}' }
    expect(await owner.commit(lead, member.id, 'renew-worker', record, () => []))
      .toEqual({ memberId: member.id, executionId: nextId, generation: 2 })
    await owner.release(lead, member.id, 'renew-worker', { recordId: 'renew-worker:ready', dataJson: '{}' }, () => [])
    expect(await owner.commit(lead, member.id, 'renew-worker', record, () => []))
      .toEqual({ memberId: member.id, executionId: nextId, generation: 2 })
    expect(adapter.requests).toHaveLength(beforeRequests)
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(2)
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ id: member.id, name: member.name,
      executionStarted: false, execution: { memberId: member.id, executionId: nextId, generation: 2 } })
    await ctx.subagents.withContinuableExecution(lead, member.id, SIGNAL, async (old) => {
      expect(ctx.agentTeams.tryMembership(old)).toBeUndefined()
      await expect(ctx.agentTeams.sendMessage(old, { target: 'lead', content: content('late old execution'), signal: SIGNAL }))
        .rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
    })
    const sent = await ctx.agentTeams.sendMessage(lead, { target: member.name, content: content('new coordination'), signal: SIGNAL })
    expect(sent.status).toBe('accepted')
    const next = await waitRunning(ctx, nextId)
    const references = next.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'team-member-material')
    expect(references).toHaveLength(1)
    expect(references[0]).toMatchObject({ data: { source: { kind: 'team-member-material', form: 'recall',
      memberId: member.id, generation: 2, recordId: 'renew-worker:bound' } } })
    expect(ctx.agentTeams.membership(next)).toMatchObject({ role: 'teammate', name: member.name,
      memberId: member.id, generation: 2 })
    expect(ctx.agentTeams.memberExecutionBySession(lead, member.id))
      .toEqual({ memberId: member.id, executionId: member.id, generation: 1 })
    expect(ctx.agentTeams.listMembers(lead)[1]?.executionStarted).toBe(true)
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/message/member-delivered'))
      .toMatchObject([{ data: { messageId: sent.messageId, targetId: member.id, executionId: nextId, generation: 2 } }])
    expect(next.session.snapshotEvents().filter(event => event.type === 'user/message').some(event =>
      event.data.content.some(block => block.type === 'text' && block.text.includes('You are teammate "renew-worker"')))).toBe(true)
    ctx.agentTeams.interrupt(lead, member.name)
    await waitNoAgent(ctx, next.id)
    await owner.dispose()
    writer.dispose()
  })

  it('holds only the selected member and records confirmed progress without starting it', async () => {
    const { ctx, lead, adapter } = await setup(['hang'], { controlledMode: { kind: 'controlled',
      requiredTaskExtensionId: 'test-managed-writer', permissionTableId: 'groups',
      permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const writer = ctx.agentTeams.installTaskExtension({ id: 'test-managed-writer',
      validateMemberGroup: () => undefined, create: unavailable, update: unavailable })
    const a = (await spawn(ctx, lead, 'held-worker')).member
    const b = (await spawn(ctx, lead, 'unaffected-worker')).member
    const owner = ctx.agentTeams.installMemberExecutions({ id: 'member-operations' })
    expect(() => ctx.agentTeams.installMemberExecutions({ id: 'other-owner' })).toThrow(/already installed/)
    const request = { memberId: a.id, operationId: 'hold-a', expectedGeneration: 1 }
    const record = { recordId: 'hold-a:start', dataJson: '{"phase":"stopping"}' }
    await owner.hold(lead, request, () => record)
    await owner.hold(lead, request, () => record)
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/member/control')).toHaveLength(1)
    expect(owner.read(lead, a.id).control).toMatchObject({ held: true, operationId: 'hold-a' })
    expect(ctx.agentTeams.memberExecution(lead, a.id)).toEqual({ memberId: a.id, executionId: a.id, generation: 1 })
    expect(ctx.agentTeams.memberExecutionBySession(lead, a.id)).toMatchObject({ memberId: a.id, generation: 1 })
    const heldMail = await ctx.agentTeams.sendMessage(lead, { target: a.name, content: content('wait for new work'), signal: SIGNAL })
    expect(heldMail.status).toBe('queued')
    expect(await ctx.sessionPersistence.stat(a.id)).toBeUndefined()
    expect(adapter.requests).toHaveLength(0)
    await expect(writer.commit(lead, cut => ({ updates: [{ previousRevision: null, task: {
      id: TeamTaskId(`task-${cut.nextTaskNumber}`), revision: 1, subject: 'blocked assignment', description: 'blocked',
      status: 'in_progress', ownerId: a.id, blockedBy: [], writeScopes: [],
    } }], dataJson: '{}' }))).rejects.toMatchObject({ code: 'TEAM_MEMBER_HELD' })
    const independentSent = await ctx.agentTeams.sendMessage(lead, { target: b.name, content: content('independent work'), signal: SIGNAL })
    expect(independentSent.status).toBe('accepted')
    await waitRunning(ctx, b.id)
    expect(adapter.requests).toHaveLength(1)
    await expect(owner.release(lead, a.id, 'hold-a', { recordId: 'hold-a:stop', dataJson: '{}' },
      () => ['external operation unconfirmed'])).rejects.toMatchObject({ code: 'TEAM_MEMBER_BLOCKED' })
    expect(owner.read(lead, a.id).control?.held).toBe(true)
    await owner.release(lead, a.id, 'hold-a', { recordId: 'hold-a:stop', dataJson: '{}' }, () => [])
    await owner.release(lead, a.id, 'hold-a', { recordId: 'hold-a:stop', dataJson: '{}' }, () => [])
    expect(owner.read(lead, a.id).control?.held).toBe(false)
    expect(await ctx.sessionPersistence.stat(a.id)).toBeUndefined()
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/member/control')).toHaveLength(2)
    ctx.agentTeams.interrupt(lead, b.name)
    await waitNoAgent(ctx, b.id)
    await owner.dispose()
    writer.dispose()
  })

  it('keeps an unconfirmed hold closed and confirms the same request without another event', async () => {
    const { ctx, lead } = await setup([], { controlledMode: { kind: 'controlled',
      requiredTaskExtensionId: 'test-managed-writer', permissionTableId: 'groups',
      permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const writer = ctx.agentTeams.installTaskExtension({ id: 'test-managed-writer',
      validateMemberGroup: () => undefined, create: unavailable, update: unavailable })
    const member = (await spawn(ctx, lead, 'checkpoint-worker')).member
    const owner = ctx.agentTeams.installMemberExecutions({ id: 'member-operations' })
    const request = { memberId: member.id, operationId: 'hold-checkpoint', expectedGeneration: 1 }
    const record = { recordId: 'hold-checkpoint:start', dataJson: '{}' }
    const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(owner.hold(lead, request, () => record)).rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
    expect(owner.read(lead, member.id).control?.held).toBe(true)
    flush.mockRestore()
    await owner.hold(lead, request, () => record)
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/member/control')).toHaveLength(1)
    await expect(owner.hold(lead, { ...request, expectedGeneration: 2 }, () => record))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
    await expect(owner.release(lead, member.id, 'foreign', { recordId: 'foreign', dataJson: '{}' }, () => []))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
    await owner.dispose()
    writer.dispose()
  })
})

describe('controlled member settlement notices', () => {
  it('registers without a standby run and starts only on the first durable Team input', async () => {
    const { ctx, lead, adapter } = await setup([
      textResponse('Work finished.'), textResponse('Lead noticed completion'),
    ], { controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'test-managed-writer',
      permissionTableId: 'test-policy', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096 } }, true)
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const writer = ctx.agentTeams.installTaskExtension({ id: 'test-managed-writer',
      validateMemberGroup: () => undefined, create: unavailable, update: unavailable })
    ctx.on('agent/created', ({ agent }) => {
      if (agent.id === lead.id) return
      agent.inject(createUserMessage({ content: [{ type: 'text', text: 'Agent instructions' }],
        source: { kind: 'agent-instructions', form: 'instructions', changes: [] } }))
    })
    const observed: Array<{ firstInputOnly: boolean; events: readonly SessionEvent[] }> = []
    ctx.subagents.registerSettlementNoticePolicy((facts) => {
      observed.push({ firstInputOnly: facts.firstInputOnly, events: facts.events })
      return undefined
    })
    const settled: SessionId[] = []
    ctx.on('subagent/end', (info) => { settled.push(info.id) })
    const member = await spawn(ctx, lead, 'standby-worker', { group: 'collectors' })
    expect(adapter.requests).toHaveLength(0)
    expect(await ctx.sessionPersistence.stat(member.member.id)).toBeUndefined()
    expect(member.member.executionStarted).toBe(false)
    expect(lead.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled')).toHaveLength(0)
    expect(lead.inbox.nextTurn.filter(message => message.source.kind === 'subagent-settled')).toHaveLength(0)

    await ctx.agentTeams.sendMessage(lead, {
      target: 'standby-worker', content: content('continue'), signal: SIGNAL,
    })
    await vi.waitFor(() => { expect(settled).toHaveLength(1) })
    expect(observed[0]?.events.flatMap(event => event.type === 'user/message'
      ? [event.data.source.kind] : [])).toContain('team-message')
    expect(ctx.agentTeams.listMembers(lead).find(candidate => candidate.id === member.member.id)?.executionStarted).toBe(true)
    await vi.waitFor(() => { expect(lead.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled')).toBe(true) })
    writer.dispose()
  })

  it('keeps the official Team standby settlement without a controlled mode', async () => {
    const { ctx, lead } = await setup([textResponse('Ready.'), textResponse('Lead noticed completion')])
    const member = await spawn(ctx, lead, 'official-worker')
    await vi.waitFor(() => { expect(lead.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled'
      && event.data.source.senderSessionId === member.member.id)).toBe(true) })
    const notice = lead.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled')
    expect(notice?.type === 'user/message' && notice.data.content[0]?.type === 'text'
      ? notice.data.content[0].text : '').toContain('Background subagent')
  })

  it('delegates later completed runs to the bound product Task reader', async () => {
    const { ctx, lead } = await setup([
      textResponse('Work is recorded elsewhere'),
    ], { controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'test-managed-writer',
      permissionTableId: 'test-policy', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096 } }, true)
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const observed: string[] = []
    const writer = ctx.agentTeams.installTaskExtension({ id: 'test-managed-writer',
      validateMemberGroup: () => undefined,
      assessSettlementNotice: (facts) => { observed.push(facts.runId); return 'suppress' },
      create: unavailable, update: unavailable })
    const settled: SessionId[] = []
    ctx.on('subagent/end', (info) => { settled.push(info.id) })
    const member = await spawn(ctx, lead, 'accounted-worker', { group: 'collectors' })
    await ctx.agentTeams.sendMessage(lead, {
      target: 'accounted-worker', content: content('continue'), signal: SIGNAL,
    })
    await vi.waitFor(() => { expect(settled).toHaveLength(1) })
    expect(observed).toHaveLength(1)
    expect(lead.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled')).toHaveLength(0)
    expect(member.member.name).toBe('accounted-worker')
    writer.dispose()
  })

  it.each([
    { description: 'different final output', script: [textResponse('Not ready.'), textResponse('Lead noticed')] },
    { description: 'a standby tool call', script: [toolCallResponse('standby-list', 'list_agents', {}),
      textResponse('Ready.'), textResponse('Lead noticed')] },
    { description: 'an incomplete first run', script: [maxTokensResponse('Ready.'),
      textResponse('Lead noticed')] },
    { description: 'no closing text', script: [[{ type: 'finish' as const, reason: { kind: 'stop' as const } }],
      textResponse('Lead noticed')] },
  ])('keeps the first settlement after $description', async ({ description, script }) => {
    const { ctx, lead } = await setup(script, { controlledMode: {
      kind: 'controlled', requiredTaskExtensionId: 'test-managed-writer',
      permissionTableId: 'test-policy', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096,
    } }, true)
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const writer = ctx.agentTeams.installTaskExtension({ id: 'test-managed-writer',
      validateMemberGroup: () => undefined, unsubmittedTaskIds: () => {
        if (description === 'different final output') throw new Error('Task reader unavailable')
        return [TeamTaskId('task-7')]
      },
      create: unavailable, update: unavailable })
    const member = await spawn(ctx, lead, 'unusual-standby', { group: 'collectors' })
    await ctx.agentTeams.sendMessage(lead, { target: 'unusual-standby', content: content('Inspect the assigned Task'), signal: SIGNAL })
    await vi.waitFor(() => { expect(lead.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled'
      && event.data.source.senderSessionId === member.member.id)).toBe(true) })
    const notice = lead.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled')
    expect(notice?.type === 'user/message' && notice.data.content[0]?.type === 'text'
      ? notice.data.content[0].text : '').toContain('Teammate unusual-standby')
    if (description !== 'different final output') {
      expect(notice?.type === 'user/message' && notice.data.content[0]?.type === 'text'
        ? notice.data.content[0].text : '').toContain('Unsubmitted Tasks: task-7')
    }
    writer.dispose()
  })

  it.each(['failed', 'retiring', 'retired'] as const)(
    'keeps the teammate name when its roster phase is %s', async (phase) => {
      const { ctx, lead } = await setup([], { controlledMode: { kind: 'controlled',
        requiredTaskExtensionId: 'test-managed-writer', permissionTableId: 'test-policy',
        permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096 } })
      const childId = SessionId(`settled-${phase}`)
      const member = { id: childId, name: `worker-${phase}`, description: 'Worker',
        provider: 'spawn', context: 'fresh' as const, phase: 'provisioning' as const }
      lead.session.append('team/member/configured', { version: 3, teamId: TeamId(lead.id), member })
      if (phase !== 'failed') lead.session.append('team/member/configured', {
        version: 3, teamId: TeamId(lead.id), member: { ...member, phase: 'active' },
      })
      if (phase === 'retired') lead.session.append('team/member/configured', {
        version: 3, teamId: TeamId(lead.id), member: { ...member, phase: 'retiring' },
      })
      lead.session.append('team/member/configured', {
        version: 3, teamId: TeamId(lead.id), member: { ...member, phase },
      })
      const decide = Reflect.get(ctx.subagents, 'sendSettlementNotice') as (
        facts: SubagentSettlementNoticeFacts,
      ) => Promise<'send' | 'suppress' | SubagentSettlementNoticeWording>
      const result = await decide.call(ctx.subagents, {
        runId: SubagentRunId(`run-${phase}`), parentSessionId: lead.id, childSessionId: childId,
        stopReason: 'error', startSeq: SessionLogOffset(0), endSeq: SessionLogOffset(0),
        parentStartSeq: SessionLogOffset(0), events: [], firstInputOnly: false,
      })
      expect(result).toMatchObject({ action: 'send', subject: `Teammate worker-${phase}` })
    },
  )
})

describe('Team identity and provisioning', () => {
  it('reads a detached composition cut under the Team lock and refuses member callers', async () => {
    const { ctx, lead } = await setup(['hang'])
    const member = await spawn(ctx, lead, 'composition-reader')
    const child = await waitRunning(ctx, member.member.id)
    const detached = await ctx.agentTeams.readCompositionLocked(lead, snapshot => snapshot)
    expect(detached.composition.phase).toBe('dynamic')
    expect(detached.members).toHaveLength(1)
    expect(detached.members[0]?.name).toBe(member.member.name)
    await expect(ctx.agentTeams.readCompositionLocked(child, () => 'not permitted'))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    const original = ctx.agents.get.bind(ctx.agents)
    const changed = vi.spyOn(ctx.agents, 'get')
    changed.mockImplementationOnce(original).mockImplementation(id => id === lead.id ? undefined : original(id))
    await expect(ctx.agentTeams.readCompositionLocked(lead, () => 'stale'))
      .rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
    changed.mockRestore()
    await expect(ctx.agentTeams.commitComposition(child, () => ({ kind: 'lock' })))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    expect(await ctx.agentTeams.commitComposition(lead, () => undefined)).toEqual({ phase: 'dynamic' })
  })

  it('rechecks a composition caller after waiting for the native lock', async () => {
    const { ctx, lead } = await setup([])
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    const occupied = ctx.agentTeams.readCompositionLocked(lead, async () => {
      entered.resolve(undefined)
      await released.promise
    })
    await entered.promise
    const pending = ctx.agentTeams.commitComposition(lead, () => ({ kind: 'lock' }))
    const original = ctx.agents.get.bind(ctx.agents)
    const changed = vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === lead.id ? undefined : original(id))
    released.resolve(undefined)
    await occupied
    await expect(pending).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
    changed.mockRestore()
    expect(ctx.agentTeams.composition(lead).phase).toBe('dynamic')
  })

  it('keeps the official Team dynamic until a Host composition operation locks it', async () => {
    const { ctx, lead } = await setup(['hang'])
    expect(ctx.agentTeams.composition(lead)).toEqual({ phase: 'dynamic' })
    const before = lead.session.snapshotEvents().filter(event => event.type === 'team/composition')
    expect(before).toHaveLength(0)
    await ctx.agentTeams.commitComposition(lead, (snapshot) => {
      expect(snapshot.composition.phase).toBe('dynamic')
      return { kind: 'lock' }
    })
    await expect(spawn(ctx, lead, 'locked-member')).rejects.toMatchObject({ code: 'TEAM_COMPOSITION_LOCKED' })
    await ctx.agentTeams.commitComposition(lead, () => ({ kind: 'unlock' }))
    const member = await spawn(ctx, lead, 'unlocked-member')
    expect(member.member.name).toBe('unlocked-member')
    expect(ctx.agentTeams.composition(lead).phase).toBe('dynamic')
  })

  it('allows only the matching application to retire and provision members', async () => {
    const { ctx, lead } = await setup(['hang'])
    const old = await spawn(ctx, lead, 'old-member')
    await ctx.agentTeams.commitComposition(lead, snapshot => ({ kind: 'begin', applicationId: 'apply-1',
      profileId: 'stock', profileVersion: 1, targetJson: '{}',
      retiringMemberIds: [old.member.id], previousPhase: snapshot.composition.phase as 'dynamic' }))
    await expect(spawn(ctx, lead, 'unauthorized')).rejects.toMatchObject({ code: 'TEAM_COMPOSITION_APPLYING' })
    await expect(ctx.agentTeams.retireTeammate(lead, 'old-member'))
      .rejects.toMatchObject({ code: 'TEAM_COMPOSITION_APPLYING' })
    await ctx.agentTeams.retireTeammate(lead, 'old-member', 'apply-1')
    const next = await spawn(ctx, lead, 'new-member', { applicationId: 'apply-1', slotId: 'slot-1' })
    expect(durable(lead).members.find(member => member.id === next.member.id)?.slotId).toBe('slot-1')
    await ctx.agentTeams.commitComposition(lead, () => ({ kind: 'finish', applicationId: 'apply-1' }))
    expect(ctx.agentTeams.composition(lead)).toMatchObject({ phase: 'fixed',
      profile: { id: 'stock', version: 1, modified: false } })
    await expect(ctx.agentTeams.retireTeammate(lead, 'new-member'))
      .rejects.toMatchObject({ code: 'TEAM_COMPOSITION_LOCKED' })
  })

  it('refuses a Profile member when the expected Preset declaration changed', async () => {
    const { ctx, lead } = await setup([], {}, true)
    await ctx.agentTeams.commitComposition(lead, snapshot => ({ kind: 'begin', applicationId: 'apply-preset',
      profileId: 'preset-profile', profileVersion: 1, targetJson: '{}', retiringMemberIds: [],
      previousPhase: snapshot.composition.phase as 'dynamic' }))
    await expect(spawn(ctx, lead, 'revision-worker', { applicationId: 'apply-preset', slotId: 'slot-1',
      presetId: 'reviewer', expectedPresetRevision: '0'.repeat(64) }))
      .rejects.toMatchObject({ code: 'TEAM_PRESET_UNAVAILABLE' })
    expect(durable(lead).members).toEqual([])
  })

  it('rejects missing and failed authoritative Team projections', async () => {
    const first = await setup([])
    const journal = teamInternals(first.ctx).journal
    const stateOf = first.ctx.sessionProjections.stateOf.bind(first.ctx.sessionProjections)
    const stateOfSpy = vi.spyOn(first.ctx.sessionProjections, 'stateOf').mockImplementation((session, key) => (
      key === 'agentTeam' ? undefined : stateOf(session, key)
    ))
    expect(() => journal.state(first.lead)).toThrow('Agent Teams projection is not registered')
    stateOfSpy.mockImplementation((session, key) => key === 'agentTeam'
      ? { ...teamProjectionDefinition.init(session.header), failure: 'failed Team projection' }
      : stateOf(session, key))
    expect(() => journal.state(first.lead)).toThrow('failed Team projection')
    stateOfSpy.mockRestore()
  })

  it('rejects deployment limits that are not positive safe integers', async () => {
    const fields = [
      'maxMembers',
      'maxActiveMembers',
      'maxTasks',
      'maxPendingMessagesPerMember',
      'maxMessageBytes',
      'maxTaskExtensionBytes',
      'disposalTimeoutMs',
    ] as const
    for (const field of fields) {
      for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(setup([], { [field]: value })).rejects.toThrow()
      }
    }
  })

  it('supports direct-constructor defaults and recovers roots that already exist', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-direct-'))
    roots.push(storageRoot)
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    const lead = await ctx.agentLoop.create(SessionId('preexisting-lead'), {})
    const service = new TeamService(ctx)

    expect(service.listMembers(lead)).toEqual([expect.objectContaining({
      name: 'lead',
      status: 'inactive',
      diagnostics: [],
    })])
    const provisioning = {
      id: SessionId('preexisting-child'),
      name: 'preexisting-worker',
      description: 'preexisting responsibility',
      provider: 'spawn',
      context: 'fresh' as const,
      phase: 'provisioning' as const,
    }
    lead.session.append('team/member', {
      version: 2,
      teamId: TeamId(lead.id),
      member: provisioning,
    })
    expect(service.listMembers(lead)[1]).toEqual(expect.objectContaining({
      name: 'preexisting-worker',
      status: 'provisioning',
      diagnostics: [],
    }))
    expect(service.listMembers(lead)[1]).not.toHaveProperty('model')
    await Promise.resolve()
  })

  it('shows controlled request models without changing the official roster model contract', async () => {
    for (const controlled of [false, true]) {
      const { ctx, lead } = await setup([], controlled ? { controlledMode: {
        kind: 'controlled', requiredTaskExtensionId: 'test-managed-writer',
        permissionTableId: 'test-policy', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096,
      } } : {})
      lead.session.append('request/header', {
        header: { config: { provider: 'mock', model: 'lead-selected' } }, reason: 'initial',
      })
      const childId = SessionId('selected-model-child')
      for (const phase of ['provisioning', 'active'] as const) {
        lead.session.append('team/member', { version: 2, teamId: TeamId(lead.id),
          member: { id: childId, name: 'model-worker', description: 'Model metadata test',
            provider: 'spawn', context: 'fresh', phase } })
      }
      const child = await ctx.agents.create({ sessionId: childId,
        meta: { parentSession: lead.id }, agentOptions: { provider: 'mock', model: 'child-created' } })
      child.agent.session.append('request/header', {
        header: { config: { provider: 'mock', model: 'child-selected' } }, reason: 'initial',
      })
      const rows = ctx.agentTeams.listMembers(lead)
      expect(rows[0]?.model).toBe(controlled ? 'lead-selected' : 'mock')
      expect(rows[1]?.model).toBe(controlled ? 'child-selected' : 'child-created')
      expect(lead.options.model).toBe('mock')
      expect(child.agent.options.model).toBe('child-created')
    }
  })

  it('uses the inherited model only before a controlled member starts', async () => {
    const { ctx, lead } = await setup([], { controlledMode: {
      kind: 'controlled', requiredTaskExtensionId: 'test-managed-writer',
      permissionTableId: 'test-policy', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096,
    } })
    lead.session.append('request/header', {
      header: { config: { provider: 'mock', model: 'lead-selected' } }, reason: 'initial',
    })
    const childId = SessionId('stored-model-child')
    for (const phase of ['provisioning', 'active'] as const) {
      lead.session.append('team/member', { version: 2, teamId: TeamId(lead.id),
        member: { id: childId, name: 'stored-worker', description: 'Unloaded metadata test',
          provider: 'spawn', context: 'fresh', phase } })
    }
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ model: 'lead-selected', executionStarted: false })
    const messageId = TeamMessageId('model-test-delivery')
    lead.session.append('team/message/queued', { version: 2, teamId: TeamId(lead.id),
      message: { id: messageId, senderId: lead.id, senderName: 'lead', targetId: childId, content: content('Start') } })
    lead.session.append('team/message/delivered', { version: 2, teamId: TeamId(lead.id), messageId, targetId: childId })
    const row = ctx.agentTeams.listMembers(lead)[1]
    expect(row).toMatchObject({ executionStarted: true })
    expect(row).not.toHaveProperty('model')
  })

  it('creates fresh and fork teammates with immutable names and bounded roster size', async () => {
    const { ctx, lead } = await setup([
      textResponse('lead answer'),
      textResponse('fork answer'),
      textResponse('fresh answer'),
    ], { maxMembers: 2 })
    lead.followup(createUserMessage({ content: content('lead turn'), source: { kind: 'user' } }))
    await lead.whenIdle()

    const forked = await spawn(ctx, lead, 'fork-worker', { context: 'fork' })
    await waitNoAgent(ctx, forked.member.id)
    const fresh = await spawn(ctx, lead, 'fresh-worker')
    await waitNoAgent(ctx, fresh.member.id)

    expect((await ctx.sessionPersistence.stat(forked.member.id))?.header.isSeeded).toBe(true)
    expect((await ctx.sessionPersistence.stat(fresh.member.id))?.header.isSeeded).toBe(false)
    expect(ctx.agentTeams.listMembers(lead).map(row => [row.name, row.context, row.status])).toEqual([
      ['lead', undefined, 'inactive'],
      ['fork-worker', 'fork', 'inactive'],
      ['fresh-worker', 'fresh', 'inactive'],
    ])
    await expect(spawn(ctx, lead, 'third-worker')).rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' })
    await expect(spawn(ctx, lead, 'fresh-worker')).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })
  })

  it('pins a professional teammate Preset across creation and cold continuation', async () => {
    const { ctx, lead, adapter } = await setup([
      textResponse('review complete'),
      textResponse('Lead receives settlement'),
      textResponse('review follow-up complete'),
      textResponse('Lead receives follow-up'),
    ], {}, true)
    const started = await spawn(ctx, lead, 'reviewer', { presetId: 'reviewer' })
    const binding = started.member.preset
    expect(binding?.id).toBe('reviewer')
    expect(binding?.revision).toMatch(/^[a-f0-9]{64}$/u)
    expect(durable(lead).members[0]?.preset).toEqual(binding)
    expect((await ctx.sessionPersistence.stat(started.member.id))?.header.agentPreset).toBe('reviewer')
    const events = await storedEvents(ctx, started.member.id)
    expect(events.filter(event => event.type === 'subagent/continuable-preset').map(event => event.data.preset)).toEqual([binding])
    await waitNoAgent(ctx, started.member.id)
    expect(adapter.requests.some(request => request.tools?.some(tool => tool.name === 'review_only'))).toBe(true)

    const resumed: Agent[] = []
    ctx.on('agent/created', ({ agent }) => {
      if (agent.id === started.member.id) resumed.push(agent)
    })
    const delivered = await ctx.agentTeams.sendMessage(lead, {
      target: 'reviewer', content: content('continue review'), signal: SIGNAL,
    })
    expect(delivered.status).toBe('accepted')
    await vi.waitFor(() => { expect(resumed).toHaveLength(1) }, { timeout: 5_000 })
    expect(resumed[0]!.session.header.agentPreset).toBe('reviewer')
    await vi.waitFor(() => {
      expect(adapter.requests.filter(request => request.tools?.some(tool => tool.name === 'review_only')).length)
        .toBeGreaterThanOrEqual(2)
    }, { timeout: 5_000 })
    await waitNoAgent(ctx, started.member.id)
  })

  it('uses a configured default member Preset without changing the official inheritance default', async () => {
    const product = await setup([textResponse('ready'), textResponse('lead settled')],
      { defaultMemberPresetId: 'reviewer' }, true)
    const member = await spawn(product.ctx, product.lead, 'general-worker')
    expect(member.member.preset?.id).toBe('reviewer')
    expect((await product.ctx.sessionPersistence.stat(member.member.id))?.header.agentPreset).toBe('reviewer')
    const official = await setup([textResponse('ready'), textResponse('lead settled')], {}, true)
    const inherited = await spawn(official.ctx, official.lead, 'ordinary-worker')
    expect(inherited.member.preset).toBeUndefined()
  })

  it('persists a teammate group without changing its address or Session identity', async () => {
    const { ctx, lead } = await setup([textResponse('ready')])
    const started = await spawn(ctx, lead, 'collector-one', { group: 'collectors' })
    expect(started.member.group).toBe('collectors')
    expect(started.member.name).toBe('collector-one')
    expect(durable(lead).members[0]?.group).toBe('collectors')
    expect(ctx.agentTeams.listMembers(lead)[1]?.group).toBe('collectors')
    const configured = lead.session.snapshotEvents().filter(event => event.type === 'team/member/configured')
    expect(configured.map(event => event.data.member.group)).toEqual(['collectors', 'collectors'])
    await waitNoAgent(ctx, started.member.id)
  })

  it('persists controlled mode before Team work and rejects member-to-member private messages', async () => {
    const mode = { kind: 'controlled' as const, requiredTaskExtensionId: 'test-managed-writer',
      permissionTableId: 'test-policy', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096 }
    const { ctx, lead } = await setup([], { controlledMode: mode })
    expect(ctx.agentTeams.controlledMode(lead)).toEqual(mode)
    expect(lead.session.snapshotEvents().find(event => event.type.startsWith('team/'))?.type).toBe('team/mode')
    const firstId = SessionId('controlled-first')
    const secondId = SessionId('controlled-second')
    for (const [id, name, group] of [[firstId, 'first', 'collectors'], [secondId, 'second', 'analysts']] as const) {
      const member = { id, name, group, description: `${name} role`,
        provider: 'spawn', context: 'fresh' as const, phase: 'provisioning' as const }
      lead.session.append('team/member/configured', { version: 3, teamId: TeamId(lead.id), member })
      lead.session.append('team/member/configured', { version: 3, teamId: TeamId(lead.id),
        member: { ...member, phase: 'active' } })
    }
    await ctx.sessions.flush(lead.session)
    const first = await ctx.agents.create({ sessionId: firstId,
      meta: { parentSession: lead.id }, agentOptions: {} })
    await expect(ctx.agentTeams.sendMessage(first.agent, {
      target: 'second', content: content('private work'), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_TARGET_DENIED' })
    expect(durable(lead).pendingMessages.some(message => message.senderId === firstId
      && message.targetId === secondId)).toBe(false)
    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'Bypass', description: 'No required extension loaded',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    await first.dispose()
  })

  it('pins an ordinary-message cap in the controlled mode without limiting Task notices', async () => {
    const mode = { kind: 'controlled' as const, requiredTaskExtensionId: 'test-managed-writer',
      permissionTableId: 'test-policy', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 256 }
    const { ctx, lead } = await setup([], { controlledMode: mode })
    const id = SessionId('capped-worker')
    const member = { id, name: 'worker', description: 'test messages', provider: 'spawn',
      context: 'fresh' as const, phase: 'provisioning' as const }
    lead.session.append('team/member', { version: 2, teamId: TeamId(lead.id), member })
    lead.session.append('team/member', { version: 2, teamId: TeamId(lead.id),
      member: { ...member, phase: 'active' } })
    await ctx.sessions.flush(lead.session)
    const worker = await ctx.agents.create({ sessionId: id,
      meta: { parentSession: lead.id }, agentOptions: {} })
    const oversized = ctx.agentTeams.sendMessage(worker.agent, {
      target: 'lead', content: content('x'.repeat(1000)), signal: SIGNAL,
    })
    await expect(oversized).rejects.toMatchObject({ code: 'TEAM_MESSAGE_TOO_LARGE',
      message: 'ordinary Team message exceeds 256 bytes; submit Task results for Lead acceptance and pass accepted results through Task prerequisites' })
    await expect(oversized).rejects.toThrow('submit Task results')
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/message/queued')).toHaveLength(0)
    expect(ctx.agentTeams.controlledMode(lead)?.maxOrdinaryMessageBytes).toBe(256)
    await worker.dispose()
  })

  it('rejects a controlled deployment without a valid ordinary-message cap', async () => {
    for (const value of [undefined, 0, -1, 1.5, Number.NaN]) {
      await expect(setup([], { controlledMode: { kind: 'controlled',
        requiredTaskExtensionId: 'test-managed-writer', permissionTableId: 'test-policy',
        permissionRevision: 'revision-1', maxOrdinaryMessageBytes: value } } as never)).rejects.toThrow()
    }
    await expect(setup([], {})).resolves.toBeDefined()
  })

  it('generates the controlled first input in the service and rejects inherited context', async () => {
    const { ctx, lead } = await setup([textResponse('ready')], { controlledMode: {
      kind: 'controlled', requiredTaskExtensionId: 'test-managed-writer',
      permissionTableId: 'test-policy', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096,
    } }, true)
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const policy = ctx.agentTeams.installTaskExtension({ id: 'test-managed-writer',
      validateMemberGroup: (_caller, group) => {
        if (group !== 'collectors') throw new TeamError('choose collectors', 'TEAM_INVALID_ARGUMENT')
      }, create: unavailable, update: unavailable })
    await expect(spawn(ctx, lead, 'fork-worker', { context: 'fork', presetId: 'reviewer' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    const started = await ctx.agentTeams.spawnTeammate(lead, {
      name: 'collector-one', group: 'collectors', presetId: 'reviewer',
      prompt: [], context: 'fresh', provider: 'spawn', signal: SIGNAL,
    })
    expect(started.member.description).toBe('reviewer')
    expect(await ctx.sessionPersistence.stat(started.member.id)).toBeUndefined()
    const sent = await ctx.agentTeams.sendMessage(lead, {
      target: 'collector-one', content: content('Consult the Task Board'), signal: SIGNAL,
    })
    const events = await storedEvents(ctx, started.member.id)
    const first = events.find(event => event.type === 'user/message')
    const firstText = first?.type === 'user/message'
      ? first.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : ''
    expect(firstText).toContain('Work only on an assigned running Task')
    expect(firstText).toContain('Consult the Task Board')
    expect(first?.type === 'user/message' && first.data.source.kind === 'team-message'
      ? first.data.source.messageId : undefined).toBe(sent.messageId)
    expect(firstText).toContain('collector-one')
    expect(firstText).toContain('collectors')
    expect(firstText).not.toContain('Your responsibility')
    expect(firstText).not.toContain('collector-one initial')
    policy.dispose()
  })

  it('fails closed before reserving a controlled member when the group policy is absent or rejects', async () => {
    const { ctx, lead } = await setup([], { controlledMode: {
      kind: 'controlled', requiredTaskExtensionId: 'test-managed-writer',
      permissionTableId: 'test-policy', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096,
    } }, true)
    await expect(spawn(ctx, lead, 'missing-policy', { group: 'collectors', presetId: 'reviewer' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const policy = ctx.agentTeams.installTaskExtension({ id: 'test-managed-writer',
      validateMemberGroup: (_caller, group) => {
        if (group !== 'collectors') throw new TeamError('choose collectors', 'TEAM_INVALID_ARGUMENT')
      }, create: unavailable, update: unavailable })
    await expect(spawn(ctx, lead, 'wrong-group', { group: 'debate', presetId: 'reviewer' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    expect(durable(lead).members).toEqual([])
    policy.dispose()
  })

  it('keeps failed first-delivery mail for explicit cancellation before retirement', async () => {
    const { ctx, lead, removeReviewer } = await setup([textResponse('Inspect the failed member')], { controlledMode: {
      kind: 'controlled', requiredTaskExtensionId: 'test-managed-writer',
      permissionTableId: 'test-policy', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096,
    } }, true)
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const writer = ctx.agentTeams.installTaskExtension({ id: 'test-managed-writer',
      validateMemberGroup: () => undefined, create: unavailable, update: unavailable })
    const member = await spawn(ctx, lead, 'changed-preset', { group: 'collectors', presetId: 'reviewer' })
    await removeReviewer?.()
    const result = await ctx.agentTeams.sendMessage(lead, {
      target: 'changed-preset', content: content('Inspect the Task Board'), signal: SIGNAL,
    })
    expect(result.status).toBe('queued')
    expect(ctx.agentTeams.listMembers(lead).find(row => row.id === member.member.id)?.status).toBe('failed')
    expect(await ctx.sessionPersistence.stat(member.member.id)).toBeUndefined()
    await expect(ctx.agentTeams.retireTeammate(lead, 'changed-preset')).rejects.toMatchObject({ code: 'TEAM_MEMBER_HAS_MESSAGES' })
    expect(await ctx.agentTeams.cancelPendingMessages(lead, 'changed-preset', 'Rebuild with a new Preset')).toEqual([result.messageId])
    expect((await ctx.agentTeams.retireTeammate(lead, 'changed-preset')).status).toBe('retired')
    writer.dispose()
  })

  it('keeps inherited and Preset tools available to a controlled member', async () => {
    const { ctx, lead } = await setup(['hang'], { controlledMode: {
      kind: 'controlled', requiredTaskExtensionId: 'test-managed-writer',
      permissionTableId: 'test-policy', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096,
    } }, true)
    ctx.tools.register({ name: 'global_tool', description: 'Host tool',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: () => Promise.resolve('global'),
    })
    await ctx.agentPresets.register({ id: 'tool-rich', plugins: [
      { name: PRESET_TOOL, config: { tool: 'preset_tool' } },
    ] })
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const policy = ctx.agentTeams.installTaskExtension({ id: 'test-managed-writer',
      validateMemberGroup: () => undefined, create: unavailable, update: unavailable })
    const started = await spawn(ctx, lead, 'tool-rich-worker', { group: 'collectors', presetId: 'tool-rich' })
    await ctx.agentTeams.sendMessage(lead, { target: 'tool-rich-worker', content: content('Consult the Task Board'), signal: SIGNAL })
    const child = await waitRunning(ctx, started.member.id)
    const scope = scopeOf(child.ctx)
    expect(ctx.tools.get('global_tool', scope)).toBeDefined()
    expect(ctx.tools.get('preset_tool', scope)).toBeDefined()
    expect((await ctx.tools.execute({ callId: ToolCallId('member-global-tool'),
      name: 'global_tool', arguments: {}, agent: child, signal: SIGNAL })).isError).toBe(false)
    policy.dispose()
  })

  it('retains controlled mode and group across a cold restart with the opt-in config removed', async () => {
    const mode = { kind: 'controlled' as const, requiredTaskExtensionId: 'test-managed-writer',
      permissionTableId: 'test-policy', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 256 }
    const first = await setup([], { controlledMode: mode })
    const member = { id: SessionId('durable-group-member'), name: 'durable-worker', group: 'collectors',
      description: 'Collect evidence', provider: 'spawn', context: 'fresh' as const,
      phase: 'provisioning' as const }
    first.lead.session.append('team/member/configured', {
      version: 3, teamId: TeamId(first.lead.id), member,
    })
    first.lead.session.append('team/member/configured', {
      version: 3, teamId: TeamId(first.lead.id), member: { ...member, phase: 'active' },
    })
    await first.ctx.sessions.flush(first.lead.session)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: first.storageRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    await ctx.plugin(TeamService)
    const resumed = await ctx.agents.resume({ resumeSessionId: first.lead.id, agentOptions: {} })
    expect(ctx.agentTeams.controlledMode(resumed.agent)).toEqual(mode)
    expect(ctx.agentTeams.listMembers(resumed.agent).find(row => row.name === member.name)?.group)
      .toBe('collectors')
    expect(resumed.agent.session.snapshotEvents().filter(event => event.type === 'team/mode')).toHaveLength(1)
    await expect(ctx.agentTeams.sendMessage(resumed.agent, {
      target: 'durable-worker', content: content('x'.repeat(1000)), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_TOO_LARGE' })
    await resumed.dispose()
  })

  it('serializes a first Task write behind the controlled-mode durability barrier', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-mode-race-'))
    roots.push(storageRoot)
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    await ctx.plugin(TeamService, { controlledMode: {
      kind: 'controlled', requiredTaskExtensionId: 'test-writer',
      permissionTableId: 'test-policy', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096,
    } })
    const rootId = SessionId('controlled-race')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session.id === rootId && session.snapshotEvents().some(event => event.type === 'team/mode')) {
        entered.resolve(undefined)
        await release.promise
      }
      return await flush(session)
    })
    const creation = ctx.agentLoop.create(rootId, {})
    let attempted: ReturnType<typeof ctx.agentTeams.createTask> | undefined
    try {
      await entered.promise
      const live = ctx.agents.get(rootId)
      expect(live).toBeDefined()
      attempted = ctx.agentTeams.createTask(live!, { subject: 'Too early', description: 'Must wait for mode' })
      expect(live!.session.snapshotEvents().filter(event => event.type === 'team/task')).toEqual([])
    } finally {
      release.resolve(undefined)
    }
    await creation
    await expect(attempted).rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    expect(ctx.agents.get(rootId)?.session.snapshotEvents().find(event => event.type.startsWith('team/'))?.type)
      .toBe('team/mode')
  })

  it('keeps an unmarked historical Team read-only when the controlled product mounts later', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-old-controlled-'))
    roots.push(storageRoot)
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    const disposeProjection = ctx.sessionProjections.register(teamProjectionDefinition)
    const lead = await ctx.agentLoop.create(SessionId('old-lead'), {})
    lead.session.append('team/task', { version: 2, teamId: TeamId(lead.id),
      task: { id: TeamTaskId('task-1'), revision: 1, subject: 'Old', description: 'Historical work',
        status: 'pending', blockedBy: [], writeScopes: [] } })
    await ctx.sessions.flush(lead.session)
    disposeProjection()
    await ctx.plugin(TeamService, { controlledMode: { kind: 'controlled',
      requiredTaskExtensionId: 'test-managed-writer', permissionTableId: 'test-policy',
      permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096 } })
    expect(ctx.agentTeams.controlledMode(lead)).toBeUndefined()
    expect(ctx.agentTeams.listTasks(lead)).toHaveLength(1)
    await expect(ctx.agentTeams.createTask(lead, { subject: 'New', description: 'Must not convert old Team' }))
      .rejects.toMatchObject({ code: 'TEAM_MODE_REQUIRED' })
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'missing', content: content('Must not enqueue'), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MODE_REQUIRED' })
    await expect(spawn(ctx, lead, 'missing')).rejects.toMatchObject({ code: 'TEAM_MODE_REQUIRED' })
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/mode')).toEqual([])
  })


  it('refuses an explicit Preset without the registry before reserving a member', async () => {
    const { ctx, lead } = await setup([])
    await expect(spawn(ctx, lead, 'reviewer', { presetId: 'reviewer' }))
      .rejects.toMatchObject({ code: 'TEAM_PRESET_UNAVAILABLE' })
    expect(durable(lead).members).toEqual([])
  })

  it('does not cold-resume a teammate under a changed Preset declaration', async () => {
    const { ctx, lead, removeReviewer } = await setup([
      textResponse('initial review'), textResponse('replacement ready'),
    ], {}, true)
    const started = await spawn(ctx, lead, 'reviewer', { presetId: 'reviewer' })
    await waitNoAgent(ctx, started.member.id)
    await removeReviewer?.()
    await ctx.agentPresets.register({ id: 'reviewer', plugins: [] })
    const message = await ctx.agentTeams.sendMessage(lead, {
      target: 'reviewer', content: content('continue review'), signal: SIGNAL,
    })
    expect(message.status).toBe('queued')
    expect(ctx.agents.get(started.member.id)).toBeUndefined()
    expect(durable(lead).pendingMessages.map(item => item.id)).toContain(message.messageId)
    expect(await ctx.agentTeams.cancelPendingMessages(lead, 'reviewer', 'Preset declaration changed'))
      .toEqual([message.messageId])
    expect(await ctx.agentTeams.cancelPendingMessages(lead, 'reviewer', 'Already settled')).toEqual([])
    expect(durable(lead).cancelled).toEqual([{
      messageId: message.messageId, targetId: started.member.id, reason: 'Preset declaration changed',
    }])
    expect((await ctx.agentTeams.retireTeammate(lead, 'reviewer')).status).toBe('retired')
    await teamInternals(ctx).recoverFor(lead)
    expect(durable(lead).cancelled).toHaveLength(1)
    expect(ctx.agentTeams.listMembers(lead)[1]?.status).toBe('retired')
    const replacement = await spawn(ctx, lead, 'reviewer-new', { presetId: 'reviewer' })
    expect(replacement.member.id).not.toBe(started.member.id)
    expect(replacement.member.preset?.revision).not.toBe(started.member.preset?.revision)
    expect(ctx.agentTeams.listMembers(lead).map(row => [row.name, row.status])).toEqual([
      ['lead', expect.any(String)], ['reviewer', 'retired'], ['reviewer-new', expect.any(String)],
    ])
    await waitNoAgent(ctx, replacement.member.id)
  })

  it('retires an idle teammate while preserving its Session and reserving its name', async () => {
    const { ctx, lead } = await setup([textResponse('worker done')])
    const started = await spawn(ctx, lead, 'worker')
    await waitNoAgent(ctx, started.member.id)
    const before = await storedEvents(ctx, started.member.id)

    const retired = await ctx.agentTeams.retireTeammate(lead, 'worker')
    expect(retired.status).toBe('retired')
    expect(durable(lead).members[0]?.phase).toBe('retired')
    expect((await storedEvents(ctx, started.member.id)).length).toBe(before.length)
    expect((await ctx.agentTeams.retireTeammate(lead, 'worker')).status).toBe('retired')
    await expect(spawn(ctx, lead, 'worker')).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'worker', content: content('after retirement'), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
  })

  it('reuses active capacity after retirement but retains the historical creation ceiling', async () => {
    const { ctx, lead } = await setup([
      textResponse('first done'), textResponse('second done'), textResponse('third done'),
    ], { maxMembers: 2, maxActiveMembers: 1 })
    const first = await spawn(ctx, lead, 'first')
    await waitNoAgent(ctx, first.member.id)
    await expect(spawn(ctx, lead, 'while-first-active'))
      .rejects.toMatchObject({ code: 'TEAM_ACTIVE_MEMBER_LIMIT' })
    await ctx.agentTeams.retireTeammate(lead, 'first')
    const second = await spawn(ctx, lead, 'second')
    await waitNoAgent(ctx, second.member.id)
    await ctx.agentTeams.retireTeammate(lead, 'second')
    await expect(spawn(ctx, lead, 'third'))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' })
  })

  it('retires a failed member without requiring an executable child Session', async () => {
    const { ctx, lead } = await setup([])
    const member = {
      id: SessionId('failed-child'), name: 'failed-worker', description: 'failed',
      provider: 'spawn', context: 'fresh' as const, phase: 'provisioning' as const,
    }
    lead.session.append('team/member', { version: 2, teamId: TeamId(lead.id), member })
    lead.session.append('team/member', {
      version: 2, teamId: TeamId(lead.id), member: { ...member, phase: 'failed', error: 'creation failed' },
    })
    await ctx.sessions.flush(lead.session)
    expect((await ctx.agentTeams.retireTeammate(lead, 'failed-worker')).status).toBe('retired')
    expect(durable(lead).members[0]?.phase).toBe('retired')
  })

  it('stops a running teammate before publishing its retired roster status', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'worker')
    await waitRunning(ctx, started.member.id)
    const retired = await ctx.agentTeams.retireTeammate(lead, 'worker')
    expect(retired.status).toBe('retired')
    expect(ctx.agents.get(started.member.id)).toBeUndefined()
  })

  it('does not let a teammate retire another Team member', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'worker')
    const child = await waitRunning(ctx, started.member.id)
    await expect(ctx.agentTeams.retireTeammate(child, 'worker'))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    expect(ctx.agentTeams.listMembers(lead)[1]?.status).toBe('running')
    ctx.agentTeams.interrupt(lead, 'worker')
  })

  it('requires unfinished tasks and undelivered Team mail to be resolved before retirement', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'worker')
    const child = await waitRunning(ctx, started.member.id)
    const task = await ctx.agentTeams.createTask(lead, { subject: 'work', description: 'finish the work' })
    const claimed = await ctx.agentTeams.updateTask(child, {
      taskId: task.id, expectedRevision: task.revision, action: 'claim',
    })
    await expect(ctx.agentTeams.retireTeammate(lead, 'worker'))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_HAS_TASKS' })
    const released = await ctx.agentTeams.updateTask(child, {
      taskId: claimed.id, expectedRevision: claimed.revision, action: 'release',
    })
    expect(child.status).toBe('running')
    await expect(ctx.agentTeams.updateTask(child, {
      taskId: claimed.id, expectedRevision: claimed.revision, action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_STALE_REVISION' })
    await ctx.agentTeams.updateTask(lead, {
      taskId: claimed.id, expectedRevision: released.revision, action: 'reassign', owner: 'lead',
    })
    const mailbox = teamInternals(ctx).mailbox
    vi.spyOn(mailbox, 'tryDispatch').mockResolvedValue(false)
    const message = await ctx.agentTeams.sendMessage(lead, {
      target: 'worker', content: content('pending note'), signal: SIGNAL,
    })
    expect(message.status).toBe('queued')
    await expect(ctx.agentTeams.retireTeammate(lead, 'worker'))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_HAS_MESSAGES' })
    ctx.agentTeams.interrupt(lead, 'worker')
  })

  it('finishes a persisted retirement edge when the Lead recovers', async () => {
    const { ctx, lead } = await setup([textResponse('worker done')])
    const started = await spawn(ctx, lead, 'worker')
    await waitNoAgent(ctx, started.member.id)
    const member = durable(lead).members[0]!
    lead.session.append('team/member/configured', {
      version: 3, teamId: TeamId(lead.id), member: { ...member, phase: 'retiring' },
    })
    await ctx.sessions.flush(lead.session)
    expect(ctx.agentTeams.listMembers(lead)[1]?.status).toBe('retiring')
    await teamInternals(ctx).recoverFor(lead)
    expect(ctx.agentTeams.listMembers(lead)[1]?.status).toBe('retired')
  })

  it('flushes the accepted child prompt before committing the active roster edge', async () => {
    const { ctx, lead } = await setup([textResponse('checkpointed child answer')])
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const order: string[] = []
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session.id === lead.id && durable(lead).members[0]?.phase === 'active') {
        order.push('lead-active')
      } else if (session.id !== lead.id) {
        order.push('child')
      }
      return flush(session)
    })

    const started = await spawn(ctx, lead, 'checkpoint-worker')
    expect(order.indexOf('child')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('child')).toBeLessThan(order.indexOf('lead-active'))
    await waitNoAgent(ctx, started.member.id)
  })

  it('checkpoints live and detached inbox receipts and aborts an unresolved checkpoint', async () => {
    const { ctx, lead } = await setup([])
    const internal = teamInternals(ctx).roster
    let liveSession: Session | undefined
    const liveFiber = await ctx.plugin(Object.assign(function checkpointFixture(childCtx: Context) {
      liveSession = childCtx.sessions.create(SessionId('checkpoint-child'))
    }, { inject: ['sessions'] }))
    if (liveSession === undefined) throw new Error('checkpoint fixture did not create its Session')
    const initial = createUserMessage({ content: content('checkpoint me'), source: { kind: 'user' } })
    const checkpoint = internal.checkpointInitialPrompt(liveSession.id, initial.id, SIGNAL)
    await Promise.resolve()
    lead.inject(createUserMessage({ content: content('unrelated progress'), source: { kind: 'user' } }))
    const unrelatedFiber = await ctx.plugin(Object.assign(function unrelatedCheckpointFixture(childCtx: Context) {
      childCtx.sessions.create(SessionId('unrelated-checkpoint-child'))
    }, { inject: ['sessions'] }))
    await unrelatedFiber.dispose()
    liveSession.append('agent/inbox/spliced', {
      target: 'next-turn', start: 0, inserted: [initial],
    })
    await checkpoint
    // Live sessions persist only through an attached agent-loop writer; this
    // bare fixture session seeds its durable log directly for the cold reread.
    const persisted = await ctx.sessionPersistence.create(liveSession.header)
    await persisted.append(liveSession.snapshotEvents())
    await persisted.close()
    await liveFiber.dispose()

    await expect(internal.checkpointInitialPrompt(liveSession.id, initial.id, SIGNAL)).resolves.toBeUndefined()
    const missing = createUserMessage({ content: content('missing'), source: { kind: 'user' } })
    await expect(internal.checkpointInitialPrompt(liveSession.id, missing.id, SIGNAL))
      .rejects.toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })

    let disposedSession: Session | undefined
    const disposedFiber = await ctx.plugin(Object.assign(function disposedCheckpointFixture(childCtx: Context) {
      disposedSession = childCtx.sessions.create(SessionId('disposed-checkpoint-child'))
    }, { inject: ['sessions'] }))
    if (disposedSession === undefined) throw new Error('disposed checkpoint fixture did not create its Session')
    const disposed = internal.checkpointInitialPrompt(disposedSession.id, missing.id, SIGNAL)
    const disposedResult = expect(disposed).rejects.toThrow('not found')
    await Promise.resolve()
    await disposedFiber.dispose()
    await disposedResult

    let abortedSession: Session | undefined
    const abortedFiber = await ctx.plugin(Object.assign(function abortedCheckpointFixture(childCtx: Context) {
      abortedSession = childCtx.sessions.create(SessionId('aborted-checkpoint-child'))
    }, { inject: ['sessions'] }))
    if (abortedSession === undefined) throw new Error('aborted checkpoint fixture did not create its Session')
    const controller = new AbortController()
    const aborted = internal.checkpointInitialPrompt(abortedSession.id, missing.id, controller.signal)
    await Promise.resolve()
    controller.abort({ kind: 'test' })
    await expect(aborted).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })

    const errorController = new AbortController()
    const errorAborted = internal.checkpointInitialPrompt(abortedSession.id, missing.id, errorController.signal)
    const errorResult = expect(errorAborted).rejects.toThrow('checkpoint stopped')
    await Promise.resolve()
    errorController.abort(new Error('checkpoint stopped'))
    await errorResult
    await abortedFiber.dispose()
  })

  it('drains an accepted child when its initial durability checkpoint fails', async () => {
    const { ctx, lead } = await setup(['hang'])
    vi.spyOn(teamInternals(ctx).roster, 'checkpointInitialPrompt')
      .mockRejectedValueOnce(new Error('checkpoint failed'))

    await expect(spawn(ctx, lead, 'checkpoint-failure')).rejects.toThrow('checkpoint failed')
    const member = durable(lead).members[0]
    expect(member).toMatchObject({ phase: 'failed', error: 'checkpoint failed' })
    if (member !== undefined) await waitNoAgent(ctx, member.id)
  })

  it('records failed provisioning durably, reserves its name, and counts it against the limit', async () => {
    const { ctx, lead } = await setup([], { maxMembers: 1 })
    await expect(spawn(ctx, lead, 'failed-worker', { provider: 'missing' })).rejects.toThrow()

    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({
      name: 'failed-worker',
      status: 'failed',
      provider: 'missing',
    })
    await expect(spawn(ctx, lead, 'failed-worker')).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })
    await expect(spawn(ctx, lead, 'other-worker')).rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' })
  })

  it('records non-Error provider failures and contains a reversed provisioning settlement race', async () => {
    const first = await setup([])
    vi.spyOn(first.ctx.subagents, 'startContinuable').mockRejectedValueOnce('string provider failure')
    await expect(spawn(first.ctx, first.lead, 'string-failure')).rejects.toBe('string provider failure')
    expect(first.ctx.agentTeams.listMembers(first.lead)[1]).toMatchObject({
      status: 'failed',
      diagnostics: ['string provider failure'],
    })
    await expect(first.ctx.agentTeams.sendMessage(first.lead, {
      target: 'string-failure', content: content('cannot deliver'), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })

    const second = await setup([])
    vi.spyOn(second.ctx.subagents, 'startContinuable').mockImplementationOnce(async () => {
      const provisioning = durable(second.lead).members[0]
      if (provisioning === undefined) throw new Error('missing provisioning edge')
      second.lead.session.append('team/member', {
        version: 2,
        teamId: TeamId(second.lead.id),
        member: { ...provisioning, phase: 'active' },
      })
      await second.ctx.sessions.flush(second.lead.session)
      throw new Error('creator failed after recovery settled active')
    })
    await expect(spawn(second.ctx, second.lead, 'reverse-race')).rejects.toBeInstanceOf(AggregateError)
    expect(durable(second.lead).members[0]?.phase).toBe('active')
  })

  it('cleans up a child when recovery settles its provisioning record first', async () => {
    const { ctx, lead } = await setup(['hang'])
    const start = ctx.subagents.startContinuable.bind(ctx.subagents)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let childId: SessionId | undefined
    vi.spyOn(ctx.subagents, 'startContinuable').mockImplementation(async (spec) => {
      childId = spec.childId
      entered.resolve(undefined)
      await release.promise
      return start(spec)
    })

    const spawning = spawn(ctx, lead, 'racing-worker')
    const rejected = expect(spawning).rejects.toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })
    await entered.promise
    await teamInternals(ctx).roster.reconcileProvisioning(lead, SIGNAL)
    expect(durable(lead).members[0]?.phase).toBe('failed')

    release.resolve(undefined)
    await rejected
    if (childId === undefined) throw new Error('reserved child id was not observed')
    await waitNoAgent(ctx, childId)
  })

  it('handles a continuation that settles before the active roster view or conflict cleanup lookup', async () => {
    const first = await setup([])
    vi.spyOn(teamInternals(first.ctx).roster, 'checkpointInitialPrompt').mockResolvedValueOnce()
    vi.spyOn(first.ctx.subagents, 'startContinuable').mockImplementationOnce(async spec => ({
      childId: spec.childId!,
      messageId: createUserMessage({ content: content('accepted'), source: { kind: 'user' } }).id,
    }))
    const inactive = await spawn(first.ctx, first.lead, 'instant-worker')
    expect(inactive.member).toMatchObject({ status: 'inactive', diagnostics: [] })
    expect(inactive.member).not.toHaveProperty('model')

    const second = await setup([])
    vi.spyOn(teamInternals(second.ctx).roster, 'checkpointInitialPrompt').mockResolvedValueOnce()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(second.ctx.subagents, 'startContinuable').mockImplementationOnce(async (spec) => {
      entered.resolve(undefined)
      await release.promise
      return {
        childId: spec.childId!,
        messageId: createUserMessage({ content: content('accepted'), source: { kind: 'user' } }).id,
      }
    })
    const spawning = spawn(second.ctx, second.lead, 'instant-conflict')
    const rejected = expect(spawning).rejects.toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })
    await entered.promise
    await teamInternals(second.ctx).roster.reconcileProvisioning(second.lead, SIGNAL)
    release.resolve(undefined)
    await rejected
  })

  it('validates names and permits only the Lead to create or interrupt teammates', async () => {
    const { ctx, lead } = await setup(['hang'])
    for (const name of ['Lead', 'lead', '-bad', 'bad-', 'bad_name', 'x'.repeat(65)]) {
      await expect(spawn(ctx, lead, name)).rejects.toMatchObject({ code: 'TEAM_INVALID_MEMBER_NAME' })
    }
    const started = await spawn(ctx, lead, 'worker')
    const worker = await waitRunning(ctx, started.member.id)
    await expect(spawn(ctx, worker, 'nested')).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    expect(() => ctx.agentTeams.interrupt(worker, 'worker')).toThrow(expect.objectContaining({ code: 'TEAM_LEAD_REQUIRED' }))
    expect(ctx.agentTeams.interrupt(lead, 'worker')).toEqual({ previousStatus: 'running' })
    await waitNoAgent(ctx, worker.id)
    expect(ctx.agentTeams.interrupt(lead, 'worker')).toEqual({ previousStatus: 'inactive' })
    expect(() => ctx.agentTeams.interrupt(lead, 'lead')).toThrow(expect.objectContaining({ code: 'TEAM_INVALID_TARGET' }))
  })

  it('validates teammate text fields and pre-provisioning cancellation', async () => {
    const { ctx, lead } = await setup([])
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'empty-description',
      description: ' ',
      prompt: content('unused'),
      context: 'fresh',
      provider: 'spawn',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'empty-provider',
      description: 'valid description',
      prompt: content('unused'),
      context: 'fresh',
      provider: ' ',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    const controller = new AbortController()
    controller.abort(new TeamError('cancelled before provisioning', 'TEST_CANCELLED'))
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'cancelled-worker',
      description: 'never provisioned',
      prompt: content('unused'),
      context: 'fresh',
      provider: 'spawn',
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'TEST_CANCELLED' })
    expect(durable(lead).members).toEqual([])
  })

  it('treats an ordinary fork as a new Root Team and filters inherited Team state', async () => {
    const { ctx, lead } = await setup([])
    await ctx.agentTeams.createTask(lead, { subject: 'parent task', description: 'belongs to parent' })
    const handle = await ctx.agents.create({
      sessionId: SessionId('ordinary-fork'),
      seed: lead.session.snapshotEvents(),
      meta: { parentSession: lead.id, isSeeded: true },
      inheritedEventCount: SessionLogOffset(lead.session.seq),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    expect(ctx.agentTeams.membership(handle.agent)).toMatchObject({
      id: TeamId(handle.agent.id),
      role: 'lead',
      name: 'lead',
    })
    expect(durable(handle.agent)).toMatchObject({ members: [], tasks: [], pendingMessages: [] })
    await handle.dispose()
  })

  it('rejects stale Agent identities and non-Team subagent children', async () => {
    const { ctx, lead } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'ordinary worker',
      request: { prompt: content('ordinary'), parent: lead },
      signal: SIGNAL,
    })
    const live = ctx.agents.get(started.childId)
    if (live !== undefined) expect(ctx.agentTeams.tryMembership(live)).toBeUndefined()
    await waitNoAgent(ctx, started.childId)
    expect(() => ctx.agentTeams.membership(lead)).not.toThrow()

    const impostor = { ...lead } as Agent
    expect(ctx.agentTeams.tryMembership(impostor)).toBeUndefined()
    expect(() => ctx.agentTeams.membership(impostor)).toThrow(expect.objectContaining({ code: 'TEAM_NOT_MEMBER' }))

    const orphanRoot = await ctx.agents.create({
      sessionId: SessionId('orphan-ordinary-root'),
      meta: { parentSession: SessionId('absent-parent') },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(ctx.agentTeams.membership(orphanRoot.agent)).toMatchObject({ role: 'lead', name: 'lead' })
    await orphanRoot.dispose()
  })

  it('does not reinterpret an orphaned provider child or malformed parent stream as a Team root', async () => {
    const first = await setup([textResponse('ordinary child done')])
    const parent = await first.ctx.agents.create({
      sessionId: SessionId('temporary-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const started = await first.ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'ordinary child',
      request: { prompt: content('finish'), parent: parent.agent },
      signal: SIGNAL,
    })
    await waitNoAgent(first.ctx, started.childId)
    await parent.dispose()
    const orphan = await first.ctx.agents.resume({
      resumeSessionId: started.childId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(first.ctx.agentTeams.tryMembership(orphan.agent)).toBeUndefined()
    expect(teamInternals(first.ctx).roster.liveChildrenByRoot()).toEqual(new Map())
    await orphan.dispose()

    const second = await setup([])
    const child = await second.ctx.agents.create({
      sessionId: SessionId('malformed-parent-child'),
      meta: { parentSession: second.lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const journal = teamInternals(second.ctx).journal
    const state = journal.state.bind(journal)
    journal.state = () => { throw new Error('malformed Team stream') }
    expect(second.ctx.agentTeams.tryMembership(child.agent)).toBeUndefined()
    journal.state = state
    await child.dispose()
  })
})

describe('prepared Lead identity admission', () => {
  async function coldLifecycle() {
    const test = await setup([], { controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'cold-lifecycle-writer',
      permissionTableId: 'cold-lifecycle-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
    const coordinator = test.ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(test.lead) })
    await using selected = await test.ctx.agentPresets.acquireComposition('reviewer')
    if (selected.revision === undefined) throw new Error('fixture needs a revision')
    const candidate = await coordinator.create(test.lead, { sessionId: SessionId('cold-lifecycle-source'), term: 2,
      presetId: selected.id, revision: selected.revision, agentOptions: { provider: 'mock', model: 'mock' } })
    await candidate.dispose()
    const observation = await test.ctx.sessionQuery.observeSession(SessionId('cold-lifecycle-source'))
    return { ...test, coordinator, observation }
  }

  it('drains a suspended cold setup scope on registration disposal before a late Preset mount can bind it', async () => {
    const { ctx, lead, coordinator, observation, adapter } = await coldLifecycle()
    using cut = observation
    const acquire = ctx.agentPresets.acquireComposition.bind(ctx.agentPresets)
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const release = vi.fn()
    let target: Context | undefined
    let mounted = false
    vi.spyOn(ctx.agentPresets, 'acquireComposition').mockImplementationOnce(async (id) => {
      const lease = await acquire(id)
      return { ...lease,
        mount: async (agentCtx) => {
          target = agentCtx
          entered.resolve(undefined)
          await gate.promise
          const result = await lease.mount(agentCtx)
          mounted = true
          return result
        },
        [Symbol.asyncDispose]: async () => { release(); await lease[Symbol.asyncDispose]() },
      }
    })
    const prepared = await coordinator.prepareActivation(cut)
    if (prepared === undefined) throw new Error('candidate was not recognized')
    const resumed = ctx.agents.resume({ resumeSessionId: cut.header.id,
      agentOptions: { provider: 'mock', model: 'mock' }, setup: prepared.setup })
    const rejected = expect(resumed).rejects.toMatchObject({ code: 'TEAM_LEAD_PROVIDER_CLOSED' })
    await entered.promise
    let disposed = false
    const disposal = coordinator.dispose().then(() => { disposed = true })
    try {
      await expect.poll(() => disposed).toBe(true)
      await rejected
      expect(target?.fiber.uid).toBeNull()
      expect(release).toHaveBeenCalledOnce()
      expect(ctx.agents.get(cut.header.id)).toBeUndefined()
      expect(ctx.agents.get(lead.id)).toBe(lead)
    } finally {
      gate.resolve(undefined)
      await Promise.allSettled([resumed, disposal, rejected])
      await prepared[Symbol.asyncDispose]()
    }
    expect(mounted).toBe(false)
    expect(release).toHaveBeenCalledOnce()
    expect(adapter.requests).toHaveLength(0)
  })

  it('keeps a failed cold mount observable while the factory rolls its scope back', async () => {
    const { ctx, coordinator, observation } = await coldLifecycle()
    using cut = observation
    await using prepared = await coordinator.prepareActivation(cut)
    if (prepared === undefined) throw new Error('candidate was not recognized')
    await expect(ctx.agents.resume({ resumeSessionId: cut.header.id,
      agentOptions: { provider: 'mock', model: 'mock' }, setup: async (agentCtx, agent) => {
        await ctx.agentPresets.mount(agentCtx, 'standard')
        return await prepared.setup(agentCtx, agent)
      } })).rejects.toThrow('cannot replace an existing binding')
    expect(ctx.agents.get(cut.header.id)).toBeUndefined()
    await coordinator.dispose()
  })

  it('preserves caller cancellation during anchor resolution and leaves the registration reusable', async () => {
    const { ctx, lead } = await setup([], { controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'caller-cancel-writer',
      permissionTableId: 'caller-cancel-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
    const caller = new AbortController()
    const reason = new Error('caller stopped preparation')
    let abortOnce = true
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: (_id, signal?: AbortSignal) => {
      if (!abortOnce) return Promise.resolve(lead)
      abortOnce = false
      caller.abort(reason)
      expect(signal?.aborted).toBe(true)
      return Promise.reject(reason)
    } })
    await using selected = await ctx.agentPresets.acquireComposition('reviewer')
    if (selected.revision === undefined) throw new Error('fixture needs a revision')
    const request = { sessionId: SessionId('caller-cancel-candidate'), term: 2, presetId: selected.id,
      revision: selected.revision, agentOptions: { provider: 'mock', model: 'mock' } }
    await expect(coordinator.create(lead, { ...request, signal: caller.signal })).rejects.toBe(reason)
    expect(ctx.agents.get(request.sessionId)).toBeUndefined()
    const current = await coordinator.create(lead, request)
    await current.dispose()
    await coordinator.dispose()
  })

  it('releases an acquired lease when registration closes between receipt and its active check', async () => {
    const { ctx, lead } = await setup([], { controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'receipt-cancel-writer',
      permissionTableId: 'receipt-cancel-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(lead) })
    const selected = await ctx.agentPresets.acquireComposition('reviewer')
    const revision = selected.revision
    if (revision === undefined) throw new Error('fixture needs a revision')
    await selected[Symbol.asyncDispose]()
    const acquire = ctx.agentPresets.acquireComposition.bind(ctx.agentPresets)
    const released = vi.fn()
    let disposal: Promise<void> | undefined
    vi.spyOn(ctx.agentPresets, 'acquireComposition').mockImplementationOnce((id) => {
      const pending = acquire(id).then(lease => ({ ...lease,
        [Symbol.asyncDispose]: async () => { released(); await lease[Symbol.asyncDispose]() },
      }))
      void pending.then(() => { queueMicrotask(() => { disposal = coordinator.dispose() }) })
      return pending
    })
    await expect(coordinator.create(lead, { sessionId: SessionId('receipt-cancel-candidate'), term: 2,
      presetId: selected.id, revision, agentOptions: { provider: 'mock', model: 'mock' } })).rejects.toMatchObject({ code: 'TEAM_LEAD_PROVIDER_CLOSED' })
    await disposal
    expect(released).toHaveBeenCalledOnce()
    expect(ctx.agents.get(SessionId('receipt-cancel-candidate'))).toBeUndefined()
  })

  it('propagates a missing declaration without scheduling canceled-lease cleanup', async () => {
    const { ctx, lead } = await setup([], { controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'missing-declaration-writer',
      permissionTableId: 'missing-declaration-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(lead) })
    await expect(coordinator.create(lead, { sessionId: SessionId('missing-declaration-candidate'), term: 2,
      presetId: 'not-declared', revision: 'a'.repeat(64), agentOptions: { provider: 'mock', model: 'mock' } }))
      .rejects.toMatchObject({ code: 'agent-preset/not-found' })
    expect(ctx.agents.get(SessionId('missing-declaration-candidate'))).toBeUndefined()
    await coordinator.dispose()
  })

  it('drains all retained preparation leases before reporting a cleanup failure', async () => {
    const { ctx, coordinator, observation } = await coldLifecycle()
    using cut = observation
    const acquire = ctx.agentPresets.acquireComposition.bind(ctx.agentPresets)
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const released: string[] = []
    let selected = 0
    vi.spyOn(ctx.agentPresets, 'acquireComposition').mockImplementation(async (id) => {
      const lease = await acquire(id)
      const number = selected++
      return { ...lease, [Symbol.asyncDispose]: async () => {
        if (number === 1) { entered.resolve(undefined); await gate.promise }
        await lease[Symbol.asyncDispose]()
        released.push(String(number))
        if (number === 0) throw new Error('retained lease cleanup failed')
      } }
    })
    const first = await coordinator.prepareActivation(cut)
    const second = await coordinator.prepareActivation(cut)
    if (first === undefined || second === undefined) throw new Error('candidate was not recognized')
    let settled = false
    const disposal = coordinator.dispose().finally(() => { settled = true })
    const rejected = expect(disposal).rejects.toThrow('Lead activation lease cleanup failed')
    await entered.promise
    try {
      expect(settled).toBe(false)
      gate.resolve(undefined)
      await rejected
      expect(released.toSorted()).toEqual(['0', '1'])
      expect(ctx.agents.canStartInput(ctx.agents.get(SessionId('lead'))!)).toBe(false)
    } finally {
      gate.resolve(undefined)
      await Promise.allSettled([disposal, rejected])
      await first[Symbol.asyncDispose]()
      await second[Symbol.asyncDispose]()
    }
  })

  it('waits for a retained lease already being released by its caller during provider disposal', async () => {
    const { ctx, coordinator, observation } = await coldLifecycle()
    using cut = observation
    const acquire = ctx.agentPresets.acquireComposition.bind(ctx.agentPresets)
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const released = vi.fn()
    vi.spyOn(ctx.agentPresets, 'acquireComposition').mockImplementationOnce(async (id) => {
      const lease = await acquire(id)
      return { ...lease, [Symbol.asyncDispose]: async () => {
        entered.resolve(undefined)
        await gate.promise
        await lease[Symbol.asyncDispose]()
        released()
      } }
    })
    const prepared = await coordinator.prepareActivation(cut)
    if (prepared === undefined) throw new Error('candidate was not recognized')
    const release = prepared[Symbol.asyncDispose]()
    await entered.promise
    let disposed = false
    const disposal = coordinator.dispose().then(() => { disposed = true })
    try {
      // Deregistration and finished jobs only await settled Promises; this checkpoint drains them before the held lease.
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(disposed).toBe(false)
      expect(released).not.toHaveBeenCalled()
      gate.resolve(undefined)
      await Promise.all([release, disposal])
      expect(disposed).toBe(true)
      expect(released).toHaveBeenCalledOnce()
      await prepared[Symbol.asyncDispose]()
      expect(released).toHaveBeenCalledOnce()
    } finally {
      gate.resolve(undefined)
      await Promise.allSettled([release, disposal])
    }
  })

  it('cancels a suspended caller setup when the Lead registration closes and releases its leases before returning', async () => {
    const { ctx, lead, adapter } = await setup([], { controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'setup-cancel-writer',
      permissionTableId: 'setup-cancel-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
    const selected = await ctx.agentPresets.acquireComposition('reviewer')
    const revision = selected.revision
    if (revision === undefined) throw new Error('fixture needs a revision')
    await selected[Symbol.asyncDispose]()
    const acquire = ctx.agentPresets.acquireComposition.bind(ctx.agentPresets)
    const mounts: Array<ReturnType<typeof vi.fn>> = []
    const releases: Array<ReturnType<typeof vi.fn>> = []
    vi.spyOn(ctx.agentPresets, 'acquireComposition').mockImplementation(async (id) => {
      const lease = await acquire(id)
      const mount = vi.fn(lease.mount.bind(lease))
      const release = vi.fn(lease[Symbol.asyncDispose].bind(lease))
      mounts.push(mount)
      releases.push(release)
      return { ...lease, mount, [Symbol.asyncDispose]: release }
    })
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(lead) })
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const creation = coordinator.create(lead, { sessionId: SessionId('suspended-lead-setup'), term: 2,
      presetId: 'reviewer', revision, agentOptions: { provider: 'mock', model: 'mock' },
      setup: () => { entered.resolve(undefined); return gate.promise } })
    const rejected = expect(creation).rejects.toMatchObject({ code: 'TEAM_LEAD_PROVIDER_CLOSED' })
    await entered.promise
    let disposed = false
    const disposal = coordinator.dispose().then(() => { disposed = true })
    try {
      await expect.poll(() => disposed).toBe(true)
      await rejected
      expect(ctx.agents.get(SessionId('suspended-lead-setup'))).toBeUndefined()
      expect(releases.every(release => release.mock.calls.length === 1)).toBe(true)
    } finally {
      gate.resolve(undefined)
      await Promise.allSettled([creation, disposal, rejected])
    }
    expect(mounts.every(mount => mount.mock.calls.length === 0)).toBe(true)
    expect(adapter.requests).toHaveLength(0)
  })

  it('cancels a suspended cold anchor resolver on registration disposal and ignores its late result', async () => {
    const { ctx, lead } = await setup([], { controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'resolver-cancel-writer',
      permissionTableId: 'resolver-cancel-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
    let blocked = false
    let resolverSignal: AbortSignal | undefined
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<Agent>()
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: (_id, signal?: AbortSignal) => {
      if (!blocked) return Promise.resolve(lead)
      resolverSignal = signal
      entered.resolve(undefined)
      return gate.promise
    } })
    const selected = await ctx.agentPresets.acquireComposition('reviewer')
    if (selected.revision === undefined) throw new Error('fixture needs a revision')
    const candidate = await coordinator.create(lead, { sessionId: SessionId('cold-resolver-source'), term: 2,
      presetId: selected.id, revision: selected.revision, agentOptions: { provider: 'mock', model: 'mock' } })
    await selected[Symbol.asyncDispose]()
    await candidate.dispose()
    using observation = await ctx.sessionQuery.observeSession(SessionId('cold-resolver-source'))
    blocked = true
    const acquire = vi.spyOn(ctx.agentPresets, 'acquireComposition')
    const preparing = coordinator.prepareActivation(observation)
    const rejected = expect(preparing).rejects.toMatchObject({ code: 'TEAM_LEAD_PROVIDER_CLOSED' })
    await entered.promise
    let disposed = false
    const disposal = coordinator.dispose().then(() => { disposed = true })
    try {
      await expect.poll(() => disposed).toBe(true)
      await rejected
      expect(resolverSignal?.aborted).toBe(true)
    } finally {
      gate.resolve(lead)
      await Promise.allSettled([preparing, disposal, rejected])
    }
    expect(acquire).not.toHaveBeenCalled()
  })

  it.each(['success', 'release-failed', 'acquire-failed'] as const)(
    'settles %s late cold composition cleanup after registration disposal', async (outcome) => {
      const { ctx, lead } = await setup([], { controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'lease-cancel-writer',
        permissionTableId: 'lease-cancel-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
      const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(lead) })
      const selected = await ctx.agentPresets.acquireComposition('reviewer')
      if (selected.revision === undefined) throw new Error('fixture needs a revision')
      const candidate = await coordinator.create(lead, { sessionId: SessionId('cold-lease-source'), term: 2,
        presetId: selected.id, revision: selected.revision, agentOptions: { provider: 'mock', model: 'mock' } })
      await selected[Symbol.asyncDispose]()
      await candidate.dispose()
      using observation = await ctx.sessionQuery.observeSession(SessionId('cold-lease-source'))
      const acquire = ctx.agentPresets.acquireComposition.bind(ctx.agentPresets)
      const gate = Promise.withResolvers<undefined>()
      const entered = Promise.withResolvers<undefined>()
      const released = vi.fn()
      const warn = vi.spyOn(ctx.logger, 'warn')
      vi.spyOn(ctx.agentPresets, 'acquireComposition').mockImplementationOnce(async (id) => {
        const lease = await acquire(id)
        entered.resolve(undefined)
        await gate.promise
        if (outcome === 'acquire-failed') {
          await lease[Symbol.asyncDispose]()
          released()
          throw new Error('late acquisition failed')
        }
        return { ...lease, [Symbol.asyncDispose]: async () => {
          released()
          await lease[Symbol.asyncDispose]()
          if (outcome === 'release-failed') throw new Error('late lease release failed')
        } }
      })
      const preparing = coordinator.prepareActivation(observation)
      const rejected = expect(preparing).rejects.toMatchObject({ code: 'TEAM_LEAD_PROVIDER_CLOSED' })
      await entered.promise
      let disposed = false
      const disposal = coordinator.dispose().then(() => { disposed = true })
      try {
        await expect.poll(() => disposed).toBe(true)
        await rejected
        expect(released).not.toHaveBeenCalled()
      } finally {
        gate.resolve(undefined)
        await Promise.allSettled([preparing, disposal, rejected])
      }
      await expect.poll(() => released.mock.calls.length).toBe(1)
      if (outcome === 'release-failed') {
        await expect.poll(() => warn.mock.calls.length).toBe(1)
        expect(warn).toHaveBeenCalledWith('Lead preparation lease cleanup failed: Error: late lease release failed')
      }
    })

  it('keeps a persistently bound host closed after coordinator unload without changing unrelated Teams', async () => {
    const { ctx, lead } = await setup([], { controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'closed-writer',
      permissionTableId: 'closed-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(lead) })
    await coordinator.prepareAnchor(lead)
    expect(ctx.agentTeams.membership(lead).role).toBe('lead')
    await coordinator.dispose()
    expect(ctx.agents.canStartInput(lead)).toBe(false)
    expect(ctx.agentTeams.tryMembership(lead)?.role).toBe('host')
    expect(() => ctx.agentTeams.membership(lead)).toThrow(expect.objectContaining({ code: 'TEAM_NOT_MEMBER' }))
    const unrelated = await ctx.agents.create({ sessionId: SessionId('unbound-after-coordinator'),
      agentOptions: { provider: 'mock', model: 'mock' } })
    expect(ctx.agentTeams.membership(unrelated.agent).role).toBe('lead')
    await unrelated.dispose()
  })

  it('preserves cwd and explicit cancellation while committing caller setup before publication', async () => {
    const { ctx, lead } = await setup([], { controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'settings-writer',
      permissionTableId: 'settings-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: async (id) => {
      const live = ctx.agents.get(id)
      if (live === undefined) throw new Error('missing anchor')
      return live
    } })
    const host = await ctx.agents.create({ sessionId: SessionId('settings-anchor'),
      meta: { cwd: join(tmpdir(), 'lead-creation-workspace'), agentPreset: 'standard' },
      agentOptions: { provider: 'mock', model: 'mock' } })
    expect(ctx.agentTeams.leadSeat(host.agent).presetId).toBe('standard')
    await using lease = await ctx.agentPresets.acquireComposition('reviewer')
    const revision = lease.revision
    if (revision === undefined) throw new Error('fixture needs a revision')
    const commit = vi.fn()
    const current = await coordinator.create(host.agent, { sessionId: SessionId('settings-candidate'), term: 2,
      presetId: lease.id, revision, signal: new AbortController().signal,
      agentOptions: { provider: 'mock', model: 'mock' }, setup: () => ({ commit }) })
    expect(current.agent.session.header.cwd).toBe(host.agent.session.header.cwd)
    expect(commit).toHaveBeenCalledOnce()
    host.agent.session.append('team/lead/transaction', { version: 1, teamId: TeamId(host.agent.id), previousTerm: 1,
      binding: { executionId: current.agent.id, term: 2, presetId: lease.id, revision },
      extension: { id: 'settings-writer', dataJson: '{}' }, releases: [] })
    await ctx.sessions.flush(host.agent.session)
    expect(ctx.agents.canClaimInput(current.agent)).toBe(false)
    const originalGet = ctx.agents.get.bind(ctx.agents)
    const missingHost = vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === host.agent.id ? undefined : originalGet(id))
    await expect(coordinator.capture(current.agent)).rejects.toMatchObject({ code: 'TEAM_LEAD_ANCHOR_INVALID' })
    missingHost.mockRestore()
    await current.dispose()
    await host.dispose()
    await coordinator.dispose()
    expect(ctx.agentTeams.leadSeat(lead).term).toBe(1)
  })

  it('rejects missing identity or Team projections before granting initialization', async () => {
    const { ctx, lead } = await setup([], { controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'projection-writer',
      permissionTableId: 'projection-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(lead) })
    const stateOf = ctx.sessionProjections.stateOf.bind(ctx.sessionProjections)
    const missingIdentity = vi.spyOn(ctx.sessionProjections, 'stateOf').mockImplementation((session, key) =>
      key === 'teamLeadExecutionRecord' ? undefined : stateOf(session, key))
    await expect(coordinator.prepareAnchor(lead)).rejects.toThrow(/identity projection/)
    missingIdentity.mockRestore()
    const missingTeam = vi.spyOn(ctx.sessionProjections, 'stateOf').mockImplementation((session, key) =>
      key === 'agentTeam' ? undefined : stateOf(session, key))
    await expect(ctx.agents.create({ sessionId: SessionId('missing-Team-projection'),
      agentOptions: { provider: 'mock', model: 'mock' } })).rejects.toThrow(/Team projection/)
    missingTeam.mockRestore()
    await coordinator.dispose()
  })

  it('rejects a corrupt persisted identity both live and during cold preparation', async () => {
    const { ctx, lead } = await setup([], { controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'corrupt-writer',
      permissionTableId: 'corrupt-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }, true)
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(lead) })
    const corrupted = await ctx.agents.create({ sessionId: SessionId('corrupt-execution'),
      meta: { parentSession: lead.id, agentPreset: 'standard' }, agentOptions: { provider: 'mock', model: 'mock' },
      setup: (_agentCtx, agent) => {
        const marker = { version: 1 as const, teamId: TeamId(lead.id), term: 2, presetId: 'standard', revision: 'a'.repeat(64) }
        agent.session.append('team/lead/execution', marker)
        agent.session.append('team/lead/execution', marker)
      } })
    await ctx.sessions.flush(corrupted.agent.session)
    await expect(coordinator.capture(corrupted.agent)).rejects.toMatchObject({ code: 'TEAM_LEAD_IDENTITY_INVALID' })
    using cut = await ctx.sessionQuery.observeSession(corrupted.agent.id, { projectionMode: 'none' })
    await expect(coordinator.prepareActivation(cut)).rejects.toMatchObject({ code: 'TEAM_LEAD_IDENTITY_INVALID' })
    await corrupted.dispose()
    await coordinator.dispose()
  })

  it.each(['missing', 'team', 'term', 'preset', 'revision'] as const)(
    'rejects a cold preparation mounted on a different durable identity (%s)', async (change) => {
      const { ctx, lead } = await setup([], {
        controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'identity-change-writer',
          permissionTableId: 'identity-change-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 },
      }, true)
      const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(lead) })
      await using lease = await ctx.agentPresets.acquireComposition('reviewer')
      const revision = lease.revision
      if (revision === undefined) throw new Error('fixture needs a revision')
      const candidate = await coordinator.create(lead, { sessionId: SessionId('identity-change-source'), term: 2,
        presetId: lease.id, revision, agentOptions: { provider: 'mock', model: 'mock' } })
      await candidate.dispose()
      using cut = await ctx.sessionQuery.observeSession(SessionId('identity-change-source'))
      await using prepared = await coordinator.prepareActivation(cut)
      if (prepared === undefined) throw new Error('candidate identity was not recognized')
      const parentSession = change === 'team' ? SessionId('another-anchor') : lead.id
      const presetId = change === 'preset' ? 'standard' : lease.id
      await expect(ctx.agents.create({ sessionId: SessionId('wrong-preparation-target'),
        meta: { parentSession, agentPreset: presetId }, agentOptions: { provider: 'mock', model: 'mock' },
        setup: async (agentCtx, agent) => {
          if (change !== 'missing') agent.session.append('team/lead/execution', {
            version: 1, teamId: TeamId(parentSession), term: change === 'term' ? 3 : 2,
            presetId, revision: change === 'revision' ? 'b'.repeat(64) : revision,
          })
          return await prepared.setup(agentCtx, agent)
        } })).rejects.toMatchObject({ code: 'TEAM_LEAD_IDENTITY_INVALID' })
      expect(ctx.agents.get(SessionId('wrong-preparation-target'))).toBeUndefined()
      await coordinator.dispose()
    },
  )

  it('refuses an absent Preset provider and an anchor resolver returning a different Team', async () => {
    const config = { controlledMode: { kind: 'controlled' as const, requiredTaskExtensionId: 'missing-writer',
      permissionTableId: 'missing-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }
    const without = await setup([], config)
    const missing = without.ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(without.lead) })
    await expect(missing.create(without.lead, { sessionId: SessionId('missing-preset'), term: 2,
      presetId: 'reviewer', revision: 'a'.repeat(64), agentOptions: { provider: 'mock', model: 'mock' } }))
      .rejects.toMatchObject({ code: 'TEAM_PRESET_UNAVAILABLE' })
    await missing.dispose()
    const { ctx, lead } = await setup([], config, true)
    const other = await ctx.agents.create({ sessionId: SessionId('wrong-anchor'),
      agentOptions: { provider: 'mock', model: 'mock' } })
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(other.agent) })
    await using lease = await ctx.agentPresets.acquireComposition('reviewer')
    if (lease.revision === undefined) throw new Error('fixture needs a revision')
    await expect(coordinator.create(lead, { sessionId: SessionId('wrong-anchor-candidate'), term: 2,
      presetId: lease.id, revision: lease.revision, agentOptions: { provider: 'mock', model: 'mock' } }))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_ANCHOR_INVALID' })
    await other.dispose()
    await coordinator.dispose()
  })

  it('loads the stable host before resuming the committed execution in a fresh runtime without a model request', async () => {
    const config = { controlledMode: { kind: 'controlled' as const, requiredTaskExtensionId: 'cold-seat-writer',
      permissionTableId: 'cold-seat-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } }
    const first = await setup([], config, true)
    const coordinator = first.ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(first.lead),
      isReady: () => true })
    await using lease = await first.ctx.agentPresets.acquireComposition('reviewer')
    if (lease.revision === undefined) throw new Error('fixture needs a revision')
    const candidate = await coordinator.create(first.lead, { sessionId: SessionId('cold-committed-seat'), term: 2,
      presetId: lease.id, revision: lease.revision, agentOptions: { provider: 'mock', model: 'mock' } })
    first.lead.session.append('team/lead/transaction', { version: 1, teamId: TeamId(first.lead.id), previousTerm: 1,
      binding: { executionId: candidate.agent.id, term: 2, presetId: lease.id, revision: lease.revision },
      extension: { id: 'cold-seat-writer', dataJson: '{}' }, releases: [] })
    await first.ctx.sessions.flush(first.lead.session)
    await candidate.dispose()
    await coordinator.dispose()
    await first.ctx.fiber.dispose()

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentPresets, { default: 'standard' })
    await ctx.agentPresets.register({ id: 'standard', plugins: [] })
    await ctx.agentPresets.register({ id: 'reviewer', plugins: [{ name: PRESET_TOOL, config: { tool: 'review_only' } }] })
    await ctx.plugin(JsonlSessionPersistence, { root: first.storageRoot })
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    await ctx.plugin(TeamService, config)
    const adapter = new MockAdapter([])
    ctx.llm.registerAdapter(['mock'], adapter)
    const handles: import('@deepseek-ai/dsh-agent').AgentHandle[] = []
    const order: string[] = []
    ctx.on('agent/created', ({ agent }) => { order.push(agent.id) })
    const restored = ctx.agentTeams.installLeadExecutions({ isReady: () => true,
      resolveAnchor: async (id) => {
        const live = ctx.agents.get(id)
        if (live !== undefined) return live
        const host = await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
        handles.push(host)
        return host.agent
      } })
    using cut = await ctx.sessionQuery.observeSession(SessionId('cold-committed-seat'))
    await using prepared = await restored.prepareActivation(cut)
    if (prepared === undefined) throw new Error('marked execution was not prepared')
    const current = await ctx.agents.resume({ resumeSessionId: cut.header.id, setup: prepared.setup,
      agentOptions: { provider: 'mock', model: 'mock' } })
    expect(order).toEqual([first.lead.id, current.agent.id])
    const host = ctx.agents.get(first.lead.id)
    if (host === undefined) throw new Error('stable host was not activated')
    expect(ctx.agentTeams.tryMembership(host)?.role).toBe('host')
    expect(ctx.agents.canStartInput(host)).toBe(false)
    expect(ctx.agents.canClaimInput(host)).toBe(false)
    expect(ctx.agentTeams.membership(current.agent)).toMatchObject({ role: 'lead', term: 2 })
    expect(adapter.requests).toHaveLength(0)
    await current.dispose()
    for (const handle of handles.reverse()) await handle.dispose()
    await restored.dispose()
  })

  it.each(['false', 'throw'] as const)('refuses an uncertain anchor checkpoint (%s)', async (failure) => {
    const { ctx, lead } = await setup([], {
      controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'uncertain-writer',
        permissionTableId: 'uncertain-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 },
    }, true)
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(lead) })
    const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async () => {
      if (failure === 'throw') throw new Error('checkpoint failed')
      return false
    })
    await expect(coordinator.prepareAnchor(lead)).rejects.toThrow(
      failure === 'throw' ? /checkpoint failed/ : /not durably confirmed/)
    flush.mockRestore()
    await coordinator.prepareAnchor(lead)
    await using lease = await ctx.agentPresets.acquireComposition('reviewer')
    if (lease.revision === undefined) throw new Error('fixture needs a revision')
    const unconfirmed = vi.spyOn(ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(coordinator.create(lead, { sessionId: SessionId('unconfirmed-candidate'), term: 2,
      presetId: lease.id, revision: lease.revision, agentOptions: { provider: 'mock', model: 'mock' } }))
      .rejects.toThrow(/not durably confirmed/)
    unconfirmed.mockRestore()
    expect(ctx.agents.get(SessionId('unconfirmed-candidate'))).toBeUndefined()
    expect(lead.session.snapshotEvents().filter(event => event.type === 'agent/input/controller-bound')).toHaveLength(1)
    await coordinator.dispose()
  })

  it('does not treat unrelated activation as a marked execution and rejects a non-controlled anchor', async () => {
    const { ctx, lead } = await setup([], {}, true)
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(lead) })
    using cut = await ctx.sessionQuery.observeSession(lead.id)
    expect(await coordinator.prepareActivation(cut)).toBeUndefined()
    await expect(coordinator.prepareAnchor(lead)).rejects.toMatchObject({ code: 'TEAM_LEAD_ANCHOR_INVALID' })
    const ordinary = await ctx.agents.create({ sessionId: SessionId('uncontrolled-anchor'),
      agentOptions: { provider: 'mock', model: 'mock' } })
    expect(ctx.agents.isInputControlled(ordinary.agent.session)).toBe(false)
    await ordinary.dispose()
    await coordinator.dispose()
  })

  it('captures queued input, preloads its original identity without waking and releases source custody once', async () => {
    const { ctx, lead, adapter } = await setup([], {
      controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'capture-writer',
        permissionTableId: 'capture-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 },
    }, true)
    let ready = true
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(lead),
      isReady: () => ready })
    await coordinator.prepareAnchor(lead)
    const material = { message: createUserMessage({ content: content('Original non-waking facts'),
      source: { kind: 'user' } }), target: 'next-step' as const, wakeup: false }
    await ctx.agents.receiveInput(lead, material)
    ready = false
    expect(ctx.agentTeams.tryMembership(lead)?.role).toBe('host')
    await expect(spawn(ctx, lead, 'frozen-creation')).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
    const captured = await coordinator.capture(lead)
    expect(captured).toEqual([material])
    expect(lead.inbox.nextStep).toEqual([])
    await using lease = await ctx.agentPresets.acquireComposition('reviewer')
    if (lease.revision === undefined) throw new Error('fixture needs a revision')
    const candidate = await coordinator.create(lead, { sessionId: SessionId('capture-candidate'), term: 2,
      presetId: lease.id, revision: lease.revision, agentOptions: { provider: 'mock', model: 'mock' } })
    expect(await coordinator.preload(candidate.agent, material, true)).toMatchObject({ location: 'inbox' })
    expect(await coordinator.preload(candidate.agent, material, true)).toMatchObject({ location: 'inbox' })
    expect(candidate.agent.inbox.nextStep).toEqual([material.message])
    expect(adapter.requests).toHaveLength(0)
    await coordinator.release(lead, material.message.id)
    await coordinator.release(lead, material.message.id)
    expect(lead.session.snapshotEvents().filter(event => event.type === 'agent/input/released')).toHaveLength(1)
    await candidate.dispose()
    await coordinator.dispose()
  })

  it('does not publish or grant authority after creation fails and closes the disposed capability', async () => {
    const { ctx, lead } = await setup([], {
      controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'failure-writer',
        permissionTableId: 'failure-table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 },
    }, true)
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(lead) })
    await using lease = await ctx.agentPresets.acquireComposition('reviewer')
    if (lease.revision === undefined) throw new Error('fixture needs a revision')
    const request = { sessionId: SessionId('failed-candidate'), term: 2, presetId: lease.id,
      revision: lease.revision, agentOptions: { provider: 'mock', model: 'mock' } }
    await expect(coordinator.create(lead, { ...request, term: 1 })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(coordinator.create(lead, { ...request, revision: 'b'.repeat(64) }))
      .rejects.toMatchObject({ code: 'TEAM_PRESET_REVISION_MISMATCH' })
    await expect(coordinator.create(lead, { ...request, setup: () => { throw new Error('setup stopped') } }))
      .rejects.toThrow(/setup stopped/)
    expect(ctx.agents.get(request.sessionId)).toBeUndefined()
    expect(ctx.agentTeams.leadSeat(lead).term).toBe(1)
    await coordinator.dispose()
    await expect(coordinator.create(lead, request)).rejects.toMatchObject({ code: 'TEAM_LEAD_PROVIDER_CLOSED' })
  })

  it('recognizes only the bound ready Lead and keeps the original anchor dormant across repeated seats', async () => {
    const { ctx, lead, adapter } = await setup([], {
      controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'seat-writer',
        permissionTableId: 'seat-table', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096 },
    }, true)
    let ready = true
    const coordinator = ctx.agentTeams.installLeadExecutions({
      resolveAnchor: () => Promise.resolve(lead), isReady: () => ready,
    })
    expect(ctx.agentTeams.leadSeat(lead)).toMatchObject({ executionId: lead.id, term: 1 })
    await using lease = await ctx.agentPresets.acquireComposition('reviewer')
    if (lease.revision === undefined) throw new Error('fixture needs a declaration revision')
    const second = await coordinator.create(lead, { sessionId: SessionId('seat-second'), term: 2,
      presetId: lease.id, revision: lease.revision, agentOptions: { provider: 'mock', model: 'mock' } })
    ready = false
    lead.session.append('team/lead/transaction', { version: 1, teamId: TeamId(lead.id), previousTerm: 1,
      binding: { executionId: second.agent.id, term: 2, presetId: lease.id, revision: lease.revision },
      extension: { id: 'seat-writer', dataJson: '{}' }, releases: [] })
    await ctx.sessions.flush(lead.session)
    expect(ctx.agentTeams.tryMembership(lead)).toMatchObject({ role: 'host' })
    expect(ctx.agents.canStartInput(lead)).toBe(false)
    expect(ctx.agents.canClaimInput(lead)).toBe(false)
    expect(() => ctx.agentTeams.membership(lead)).toThrow(expect.objectContaining({ code: 'TEAM_NOT_MEMBER' }))
    expect(ctx.agentTeams.tryMembership(second.agent)).toBeUndefined()
    expect(ctx.agents.canStartInput(second.agent)).toBe(false)
    expect(ctx.agents.canClaimInput(second.agent)).toBe(false)
    const queued = createUserMessage({ content: content('after commit, before readiness'), source: { kind: 'user' } })
    expect(await ctx.agents.receiveInput(second.agent, { message: queued, target: 'next-turn', wakeup: true }))
      .toMatchObject({ messageId: queued.id, location: 'held' })
    expect(adapter.requests).toHaveLength(0)
    ready = true
    expect(ctx.agentTeams.membership(second.agent)).toMatchObject({ role: 'lead', term: 2 })
    expect(ctx.agentTeams.membership(second.agent).root).toBe(lead)
    expect(ctx.agents.canStartInput(second.agent)).toBe(true)
    expect(ctx.agentTeams.listMembers(second.agent)[0]).toMatchObject({ id: lead.id, name: 'lead',
      preset: { id: lease.id, revision: lease.revision } })
    const third = await coordinator.create(lead, { sessionId: SessionId('seat-third'), term: 3,
      presetId: lease.id, revision: lease.revision, agentOptions: { provider: 'mock', model: 'mock' } })
    ready = false
    lead.session.append('team/lead/transaction', { version: 1, teamId: TeamId(lead.id), previousTerm: 2,
      binding: { executionId: third.agent.id, term: 3, presetId: lease.id, revision: lease.revision },
      extension: { id: 'seat-writer', dataJson: '{}' }, releases: [] })
    await ctx.sessions.flush(lead.session)
    ready = true
    expect(ctx.agentTeams.membership(third.agent)).toMatchObject({ role: 'lead', term: 3 })
    expect(ctx.agentTeams.membership(third.agent).root).toBe(lead)
    expect(ctx.agentTeams.tryMembership(second.agent)).toBeUndefined()
    expect(ctx.agents.canStartInput(second.agent)).toBe(false)
    expect(ctx.agentTeams.leadSeat(lead)).toMatchObject({ executionId: third.agent.id, term: 3 })
    expect(adapter.requests).toHaveLength(0)
    await third.dispose()
    await second.dispose()
    await coordinator.dispose()
  })

  it('creates a durable ordinary candidate through an owned coordinator and refuses all model input', async () => {
    const { ctx, lead, adapter } = await setup([], {
      controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'lead-writer',
        permissionTableId: 'lead-table', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096 },
    }, true)
    const coordinator = ctx.agentTeams.installLeadExecutions({
      resolveAnchor: (id) => {
        const anchor = ctx.agents.get(id)
        if (anchor === undefined) return Promise.reject(new Error('anchor is absent'))
        return Promise.resolve(anchor)
      },
    })
    expect(() => ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(lead) }))
      .toThrow(expect.objectContaining({ code: 'TEAM_LEAD_PROVIDER_CONFLICT' }))
    await using lease = await ctx.agentPresets.acquireComposition('reviewer')
    if (lease.revision === undefined) throw new Error('fixture requires a declaration revision')
    const identityAtPublication: unknown[] = []
    ctx.on('agent/created', async ({ agent }) => {
      if (agent.id !== 'coordinator-candidate') return
      const persisted = await storedEvents(ctx, agent.id)
      identityAtPublication.push(persisted.find(event => event.type === 'team/lead/execution')?.data)
      expect(ctx.agents.canStartInput(agent)).toBe(false)
      expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('reviewer')
    })
    const candidate = await coordinator.create(lead, { sessionId: SessionId('coordinator-candidate'),
      term: 2, presetId: 'reviewer', revision: lease.revision,
      agentOptions: { provider: 'mock', model: 'mock' } })
    expect(identityAtPublication).toEqual([{ version: 1, teamId: TeamId(lead.id), term: 2,
      presetId: 'reviewer', revision: lease.revision }])
    expect(ctx.agents.roots()).toContain(candidate.agent)
    expect(ctx.agents.isOwnedBy(candidate.agent.id, lead)).toBe(false)
    expect(ctx.agentTeams.tryMembership(candidate.agent)).toBeUndefined()
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(1)
    await expect(ctx.agents.receiveInput(candidate.agent, { message: createUserMessage({ content: content('run now'),
      source: { kind: 'user' } }), target: 'next-turn', wakeup: true })).rejects.toThrow(/not bound and ready/)
    candidate.agent.wakePending?.()
    expect(adapter.requests).toHaveLength(0)
    await candidate.dispose()
    await coordinator.dispose()
  })

  it('binds a new controlled anchor before setup and leaves official creation unbound', async () => {
    const { ctx, lead } = await setup([], {
      controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'anchor-writer',
        permissionTableId: 'anchor-table', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096 },
    }, true)
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(lead) })
    let observed = false
    const anchor = await ctx.agents.create({ sessionId: SessionId('controlled-new-anchor'),
      agentOptions: { provider: 'mock', model: 'mock' }, setup: (_agentCtx, agent) => {
        observed = true
        expect(ctx.agents.isInputControlled(agent.session)).toBe(true)
        expect(ctx.sessionProjections.stateOf(agent.session, 'agentTeam')?.mode?.kind).toBe('controlled')
      } })
    expect(observed).toBe(true)
    await anchor.dispose()
    await coordinator.dispose()
    const official = await setup([])
    expect(official.ctx.agents.isInputControlled(official.lead.session)).toBe(false)
  })

  it('prepares the recorded Lead declaration on cold activation and refuses a changed declaration before mount', async () => {
    const { ctx, lead, adapter, removeReviewer } = await setup([], {
      controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'cold-writer',
        permissionTableId: 'cold-table', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096 },
    }, true)
    const resolve = vi.fn(() => Promise.resolve(lead))
    const coordinator = ctx.agentTeams.installLeadExecutions({ resolveAnchor: resolve })
    await using lease = await ctx.agentPresets.acquireComposition('reviewer')
    if (lease.revision === undefined) throw new Error('fixture requires a declaration revision')
    const candidate = await coordinator.create(lead, { sessionId: SessionId('cold-lead-candidate'),
      term: 2, presetId: 'reviewer', revision: lease.revision, agentOptions: { provider: 'mock', model: 'mock' } })
    await candidate.dispose()
    using cut = await ctx.sessionQuery.observeSession(SessionId('cold-lead-candidate'))
    resolve.mockClear()
    await using prepared = await coordinator.prepareActivation(cut)
    if (prepared === undefined) throw new Error('Lead activation was not prepared')
    expect(resolve).toHaveBeenCalledWith(lead.id, expect.any(AbortSignal))
    const resumed = await ctx.agents.resume({ resumeSessionId: cut.header.id,
      agentOptions: { provider: 'mock', model: 'mock' }, setup: prepared.setup })
    expect(ctx.agentPresets.composedPreset(resumed.agent.ctx)).toBe('reviewer')
    expect(ctx.agents.canStartInput(resumed.agent)).toBe(false)
    expect(ctx.agentTeams.tryMembership(resumed.agent)).toBeUndefined()
    expect(adapter.requests).toHaveLength(0)
    await resumed.dispose()
    if (removeReviewer === undefined) throw new Error('fixture requires a removable declaration')
    await removeReviewer()
    await ctx.agentPresets.register({ id: 'reviewer', plugins: [] })
    await expect(coordinator.prepareActivation(cut)).rejects.toThrow(
      expect.objectContaining({ code: 'TEAM_PRESET_REVISION_MISMATCH' }))
    expect(ctx.agents.get(cut.header.id)).toBeUndefined()
    expect(adapter.requests).toHaveLength(0)
    await coordinator.dispose()
  })

  it.each([false, true])('persists identity without a second Team or member slot (controlled=%s)', async (controlled) => {
    const { ctx, lead, adapter } = await setup([], controlled ? {
      controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'identity-writer',
        permissionTableId: 'identity-table', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096 },
    } : {}, true)
    await using composition = await ctx.agentPresets.acquireComposition('standard')
    if (composition.revision === undefined) throw new Error('standard fixture has no revision')
    const identity = { version: 1 as const, teamId: TeamId(lead.id), term: 2,
      presetId: 'standard', revision: composition.revision }
    const publicIdentities: unknown[] = []
    ctx.on('agent/created', async ({ agent }) => {
      if (agent.id !== 'prepared-lead') return
      publicIdentities.push((await storedEvents(ctx, agent.id)).find(event => event.type === 'team/lead/execution')?.data)
      expect(ctx.agentTeams.tryMembership(agent)).toBeUndefined()
    })
    const prepared = await ctx.agents.create({
      sessionId: SessionId('prepared-lead'),
      meta: { parentSession: lead.id, agentPreset: 'standard' },
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: (_agentCtx, agent) => { agent.session.append('team/lead/execution', identity) },
    })
    await ctx.sessions.flush(prepared.agent.session)
    expect(publicIdentities).toEqual([identity])
    expect(ctx.agents.roots()).toContain(prepared.agent)
    expect(prepared.agent.session.header).toMatchObject({ parentSession: lead.id, isSeeded: false })
    expect(prepared.agent.session.header.origin).toBeUndefined()
    expect(ctx.sessionProjections.stateOf(prepared.agent.session, 'teamLeadExecutionRecord')).toMatchObject({
      identity, eligible: true,
    })
    expect(ctx.agentTeams.tryMembership(prepared.agent)).toBeUndefined()
    expect(() => ctx.agentTeams.membership(prepared.agent)).toThrow(expect.objectContaining({ code: 'TEAM_NOT_MEMBER' }))
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(1)
    expect(adapter.requests).toHaveLength(0)
    await prepared.dispose()

    // Read the marker from persisted storage, not the former Agent handle.
    const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('prepared-lead'),
      agentOptions: { provider: 'mock', model: 'mock' } })
    expect(ctx.agentTeams.tryMembership(resumed.agent)).toBeUndefined()
    expect(ctx.sessionProjections.stateOf(resumed.agent.session, 'teamLeadExecutionRecord')?.identity).toEqual(identity)
    expect(adapter.requests).toHaveLength(0)
    await resumed.dispose()
  })

  it('does not grant an inherited marker authority to an ordinary fork', async () => {
    const { ctx, lead } = await setup([])
    const parent = await ctx.agents.create({ sessionId: SessionId('marked-parent'),
      meta: { parentSession: lead.id, agentPreset: 'standard' },
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: (_agentCtx, agent) => { agent.session.append('team/lead/execution', {
        version: 1, teamId: TeamId(lead.id), term: 2, presetId: 'standard', revision: 'a'.repeat(64),
      }) },
    })
    await ctx.sessions.flush(parent.agent.session)
    const seed = await storedEvents(ctx, parent.agent.id)
    const fork = await ctx.agents.create({ sessionId: SessionId('ordinary-marked-fork'), seed,
      meta: { parentSession: parent.agent.id, isSeeded: true, agentPreset: 'standard' },
      inheritedEventCount: SessionLogOffset(seed.length), agentOptions: { provider: 'mock', model: 'mock' } })
    expect(ctx.sessionProjections.stateOf(fork.agent.session, 'teamLeadExecutionRecord')?.identity).toBeNull()
    expect(ctx.agentTeams.membership(fork.agent)).toMatchObject({ id: TeamId(fork.agent.id), role: 'lead' })
    await fork.dispose()
    await parent.dispose()
  })

  it('keeps identity admission after Team reload and refuses a failed identity fold', async () => {
    const { ctx, lead, teamFiber } = await setup([])
    const prepared = await ctx.agents.create({ sessionId: SessionId('reload-prepared-lead'),
      meta: { parentSession: lead.id, agentPreset: 'standard' },
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: (_agentCtx, agent) => { agent.session.append('team/lead/execution', {
        version: 1, teamId: TeamId(lead.id), term: 2, presetId: 'standard', revision: 'a'.repeat(64),
      }) },
    })
    const stateOf = ctx.sessionProjections.stateOf.bind(ctx.sessionProjections)
    const missingProjection = vi.spyOn(ctx.sessionProjections, 'stateOf').mockImplementation((session, key) => (
      key === 'teamLeadExecutionRecord' ? undefined : stateOf(session, key)
    ))
    expect(ctx.agentTeams.tryMembership(lead)).toBeUndefined()
    missingProjection.mockRestore()
    await teamFiber.dispose()
    expect(ctx.sessionProjections.stateOf(prepared.agent.session, 'teamLeadExecutionRecord')).toBeUndefined()
    await ctx.plugin(TeamService)
    expect(ctx.agentTeams.membership(lead).role).toBe('lead')
    expect(ctx.agentTeams.tryMembership(prepared.agent)).toBeUndefined()
    prepared.agent.session.append('team/lead/execution', {
      version: 1, teamId: TeamId(lead.id), term: 3, presetId: 'standard', revision: 'a'.repeat(64),
    })
    expect(ctx.sessionProjections.stateOf(prepared.agent.session, 'teamLeadExecutionRecord')?.failure).toMatch(/duplicate/)
    expect(ctx.agentTeams.tryMembership(prepared.agent)).toBeUndefined()
    await prepared.dispose()
  })
})

describe('Team shared task DAG', () => {
  it('delivers controlled Task notices from one member to another without peer-message admission', async () => {
    const mode = { kind: 'controlled' as const, requiredTaskExtensionId: 'notice-writer',
      permissionTableId: 'test-policy', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 16 }
    const { ctx, lead } = await setup(['hang', 'hang'],
      { controlledMode: mode }, true)
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const handle = ctx.agentTeams.installTaskExtension({
      id: 'notice-writer', validateMemberGroup: () => undefined,
      create: unavailable, update: unavailable,
    })
    const sender = await spawn(ctx, lead, 'debater', { group: 'debaters', presetId: 'reviewer' })
    const target = await spawn(ctx, lead, 'collector', { group: 'collectors', presetId: 'reviewer' })
    await handle.commitRecord(lead, () => ({ recordId: 'start-debater', dataJson: '{}', notices: [{
      id: TeamMessageId('start-debater-input'), senderId: lead.id, senderName: 'lead',
      targetId: sender.member.id, content: content('Inspect the Task Board'),
    }] }))
    const senderAgent = await waitRunning(ctx, sender.member.id)
    const noticeId = TeamMessageId('member-task-notice')
    await handle.commit(senderAgent, () => ({
      updates: [{ previousRevision: null, task: {
        id: TeamTaskId('task-1'), revision: 1, subject: 'Collect evidence',
        description: 'Find a source', status: 'in_progress', ownerId: target.member.id,
        blockedBy: [], writeScopes: [],
      } }],
      dataJson: '{}',
      notices: [{ id: noticeId, senderId: sender.member.id, senderName: 'debater',
        targetId: target.member.id, content: content('Assigned Task task-1') }],
    }))
    await vi.waitFor(() => {
      expect(lead.session.snapshotEvents().filter(event => event.type === 'team/message/delivered'
        && event.data.messageId === noticeId)).toHaveLength(1)
    }, { timeout: 5_000 })
    handle.dispose()
  })

  it('commits a Task and pending teammate notice in the same durable event', async () => {
    const { ctx, lead } = await setup([])
    await Promise.resolve()
    const member = {
      id: SessionId('notice-worker'), name: 'notice-worker', description: 'notification target',
      provider: 'spawn', context: 'fresh' as const, phase: 'provisioning' as const,
    }
    lead.session.append('team/member', { version: 2, teamId: TeamId(lead.id), member })
    lead.session.append('team/member', {
      version: 2, teamId: TeamId(lead.id), member: { ...member, phase: 'active' },
    })
    await ctx.sessions.flush(lead.session)
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const handle = ctx.agentTeams.installTaskExtension({
      id: 'notice-writer', create: unavailable, update: unavailable,
    })
    const noticeId = TeamMessageId('task-notice-1')
    await handle.commit(lead, () => ({
      updates: [{ previousRevision: null, task: {
        id: TeamTaskId('task-1'), revision: 1, subject: 'notify', description: 'notify worker',
        status: 'pending', blockedBy: [], writeScopes: [],
      } }],
      dataJson: '{}',
      notices: [{ id: noticeId, senderId: lead.id, senderName: 'lead', targetId: member.id,
        content: content('Task task-1 is assigned') }],
    }))
    const event = lead.session.snapshotEvents().filter(item => item.type === 'team/task/transaction')
    expect(event).toHaveLength(1)
    expect(event[0]?.data.notices?.map(notice => notice.id)).toEqual([noticeId])
    expect(durable(lead).pendingMessages.map(notice => notice.id)).toContain(noticeId)
    await expect(ctx.agentTeams.retireTeammate(lead, 'notice-worker'))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_HAS_MESSAGES' })
    handle.dispose()
  })

  it('commits extension-only records with notices and de-duplicates under the Team lock', async () => {
    const { ctx, lead } = await setup([])
    const unavailable = async (): Promise<never> => { throw new Error('unused') }
    const handle = ctx.agentTeams.installTaskExtension({
      id: 'record-writer', create: unavailable, update: unavailable,
    })
    const member = {
      id: SessionId('record-target'), name: 'record-target', description: 'notice target',
      provider: 'spawn', context: 'fresh' as const, phase: 'provisioning' as const,
    }
    lead.session.append('team/member', { version: 2, teamId: TeamId(lead.id), member })
    lead.session.append('team/member', { version: 2, teamId: TeamId(lead.id), member: { ...member, phase: 'active' } })
    await ctx.sessions.flush(lead.session)
    const write = () => handle.commitRecord(lead, snapshot => snapshot.records.some(row => row.recordId === 'proposal-1')
      ? { existingRecordId: 'proposal-1' }
      : { recordId: 'proposal-1', dataJson: '{"kind":"proposal"}', notices: [{
        id: TeamMessageId('proposal-notice-1'), senderId: lead.id, senderName: 'lead', targetId: member.id,
        content: content('New proposal'),
      }] })
    const results = await Promise.all([write(), write()])
    expect(results.map(result => result.committed).sort()).toEqual([false, true])
    expect(ctx.agentTeams.listTasks(lead)).toEqual([])
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/extension')).toHaveLength(1)
    expect(durable(lead).pendingMessages.map(notice => notice.id)).toContain(TeamMessageId('proposal-notice-1'))
    await expect(handle.commitRecord(lead, () => ({ recordId: 'proposal-1', dataJson: '{}' })))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    const selfNotice = TeamMessageId('permission-notice-lead')
    await handle.commitRecord(lead, () => ({ recordId: 'permission-1', dataJson: '{}',
      affectsComposition: true, notices: [{ id: selfNotice, senderId: lead.id,
        senderName: 'lead', targetId: lead.id, content: content('Permissions changed') }] }))
    const binding = lead.session.snapshotEvents().find(event => event.type === 'team/extension'
      && event.data.extension.recordId === 'permission-1')
    expect(binding?.type === 'team/extension' && binding.data.affectsComposition).toBe(true)
    expect(binding?.type === 'team/extension' && binding.data.notices?.[0]?.id).toBe(selfNotice)
    await expect(handle.commit(lead, snapshot => ({ updates: [{ previousRevision: null,
      task: { id: TeamTaskId(`task-${snapshot.nextTaskNumber}`), revision: 1,
        subject: 'self notice', description: 'forbidden', status: 'pending', blockedBy: [], writeScopes: [] } }],
    dataJson: '{}', notices: [{ id: TeamMessageId('ordinary-self'), senderId: lead.id,
      senderName: 'lead', targetId: lead.id, content: content('Not a permission binding') }] })))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    handle.dispose()
  })

  it('rejects malformed or oversized extension data before any Task event is committed', async () => {
    const { ctx, lead } = await setup([], { maxTaskExtensionBytes: 8 })
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const handle = ctx.agentTeams.installTaskExtension({
      id: 'bounded-writer', create: unavailable, update: unavailable,
    })
    const first = {
      id: TeamTaskId('task-1'), revision: 1, subject: 'bounded', description: 'bounded extension',
      status: 'pending' as const, blockedBy: [], writeScopes: [],
    }
    const updates = [{ previousRevision: null, task: first }]
    await expect(handle.commit(lead, () => ({ updates, dataJson: '123456789' })))
      .rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_TOO_LARGE' })
    await expect(handle.commit(lead, () => ({ updates, dataJson: 'not-json' })))
      .rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_INVALID' })
    expect(ctx.agentTeams.listTasks(lead)).toEqual([])
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/task/transaction')).toEqual([])
    handle.dispose()
  })

  it('checks marked extension notices against the complete ordinary-message limit atomically', async () => {
    const { ctx, lead } = await setup([], { controlledMode: { kind: 'controlled',
      requiredTaskExtensionId: 'notice-writer', permissionTableId: 'test-policy',
      permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 180 },
    maxMessageBytes: 2048, maxPendingMessagesPerMember: 1 })
    vi.spyOn(teamInternals(ctx).mailbox, 'tryDispatch').mockResolvedValue(false)
    for (const name of ['first', 'second']) {
      const member = { id: SessionId(`notice-${name}`), name, description: name,
        provider: 'spawn', context: 'fresh' as const, phase: 'provisioning' as const }
      lead.session.append('team/member', { version: 2, teamId: TeamId(lead.id), member })
      lead.session.append('team/member', { version: 2, teamId: TeamId(lead.id),
        member: { ...member, phase: 'active' } })
    }
    await ctx.sessions.flush(lead.session)
    const unavailable = async (): Promise<never> => { throw new Error('not used') }
    const writer = ctx.agentTeams.installTaskExtension({ id: 'notice-writer',
      create: unavailable, update: unavailable })
    const notices = [
      { id: TeamMessageId('broadcast-first'), senderId: lead.id, senderName: 'lead',
        targetId: SessionId('notice-first'), content: content('short'), ordinaryMessageLimit: true as const },
      { id: TeamMessageId('broadcast-second'), senderId: lead.id, senderName: 'lead',
        targetId: SessionId('notice-second'), content: content('x'.repeat(300)), ordinaryMessageLimit: true as const },
    ]
    await expect(writer.commitRecord(lead, () => ({ recordId: 'broadcast-1', dataJson: '{}', notices })))
      .rejects.toMatchObject({ code: 'TEAM_MESSAGE_TOO_LARGE' })
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/extension')).toEqual([])
    const accepted = [{ ...notices[0]!, content: content('short') },
      { ...notices[1]!, content: content('short') }]
    await writer.commitRecord(lead, () => ({ recordId: 'broadcast-1', dataJson: '{}', notices: accepted }))
    const event = lead.session.snapshotEvents().find(item => item.type === 'team/extension')
    expect(event?.type === 'team/extension' ? event.data.notices : []).toHaveLength(2)
    expect(event?.type === 'team/extension' ? event.data.notices?.[0] : undefined)
      .not.toHaveProperty('ordinaryMessageLimit')
    await expect(writer.commitRecord(lead, () => ({ recordId: 'broadcast-2', dataJson: '{}',
      notices: accepted.map(notice => ({ ...notice,
        id: TeamMessageId(`again-${notice.id}`) })) })))
      .rejects.toMatchObject({ code: 'TEAM_MAILBOX_FULL' })
    expect(lead.session.snapshotEvents().filter(item => item.type === 'team/extension')).toHaveLength(1)
    writer.dispose()
  })

  it('lets one outer writer atomically update the native Board without a second Team service', async () => {
    const { ctx, lead } = await setup([])
    const routedCreate = vi.fn(async () => { throw new Error('outer create policy reached') })
    const routedUpdate = vi.fn(async () => { throw new Error('outer update policy reached') })
    const handle = ctx.agentTeams.installTaskExtension({
      id: 'test-task-writer', create: routedCreate, update: routedUpdate,
    })
    await expect(ctx.agentTeams.createTask(lead, { subject: 'routed', description: 'not a native write' }))
      .rejects.toThrow('outer create policy reached')
    expect(routedCreate).toHaveBeenCalledOnce()
    expect(() => ctx.agentTeams.installTaskExtension({
      id: 'second', create: routedCreate, update: routedUpdate,
    })).toThrow()

    const created = await handle.commit(lead, (snapshot) => {
      expect(snapshot.tasks).toEqual([])
      expect(snapshot.nextTaskNumber).toBe(1)
      const first = {
        id: TeamTaskId('task-1'), revision: 1, subject: 'source', description: 'source work',
        status: 'pending' as const, blockedBy: [], writeScopes: [],
      }
      const second = {
        id: TeamTaskId('task-2'), revision: 1, subject: 'consumer', description: 'consumer work',
        status: 'pending' as const, blockedBy: [first.id], writeScopes: [],
      }
      return { updates: [
        { previousRevision: null, task: first },
        { previousRevision: null, task: second },
      ], dataJson: JSON.stringify({ attemptPolicy: 'reviewed' }) }
    })
    expect(created.map(task => task.id)).toEqual([TeamTaskId('task-1'), TeamTaskId('task-2')])
    expect(ctx.agentTeams.listTasks(lead).map(task => task.id)).toEqual(created.map(task => task.id))
    const events = lead.session.snapshotEvents()
    expect(events.filter(event => event.type === 'team/task/transaction')).toHaveLength(1)
    expect(events.filter(event => event.type === 'team/task')).toHaveLength(0)
    expect((await handle.commit(lead, () => ({ existingTaskIds: [TeamTaskId('task-1'), TeamTaskId('task-2')] })))
      .map(task => task.id)).toEqual(created.map(task => task.id))
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/task/transaction')).toHaveLength(1)
    await expect(handle.commit(lead, () => ({ existingTaskIds: [TeamTaskId('task-404')] })))
      .rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: TeamTaskId('task-1'), expectedRevision: 1, action: 'edit', subject: 'routed',
    })).rejects.toThrow('outer update policy reached')
    expect(routedUpdate).toHaveBeenCalledOnce()

    const changed = await handle.commit(lead, snapshot => ({
      updates: [
        { previousRevision: 1, task: { ...snapshot.tasks[0]!, revision: 2, status: 'deleted' } },
        { previousRevision: 1, task: { ...snapshot.tasks[1]!, revision: 2, blockedBy: [] } },
      ],
      dataJson: JSON.stringify({ graphEdit: true }),
    }))
    expect(changed.map(task => task.revision)).toEqual([2, 2])
    expect(ctx.agentTeams.listTasks(lead).map(task => task.id)).toEqual([TeamTaskId('task-2')])
    await expect(handle.commit(lead, () => ({
      updates: [{ previousRevision: 1, task: { ...durable(lead).tasks[1]!, revision: 2 } }],
      dataJson: '{}',
    }))).rejects.toMatchObject({ code: 'TEAM_TASK_STALE_REVISION' })
    handle.dispose()
    await expect(handle.commit(lead, () => ({ updates: [], dataJson: '{}' })))
      .rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: TeamTaskId('task-2'), expectedRevision: 2, action: 'edit', subject: 'bypass review',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    const native = await ctx.agentTeams.createTask(lead, { subject: 'native again', description: 'default writer' })
    expect(native.id).toBe(TeamTaskId('task-3'))
    expect((await ctx.agentTeams.updateTask(lead, {
      taskId: native.id, expectedRevision: native.revision, action: 'edit', subject: 'native edit',
    })).subject).toBe('native edit')

    const other = ctx.agentTeams.installTaskExtension({
      id: 'another-writer', create: routedCreate, update: routedUpdate,
    })
    await expect(other.commit(lead, snapshot => ({
      updates: [{ previousRevision: 2, task: { ...snapshot.tasks[1]!, revision: 3, subject: 'hijacked' } }],
      dataJson: '{}',
    }))).rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    other.dispose()
  })

  it('fails loudly when the durable numeric task id space is exhausted', async () => {
    const { ctx, lead } = await setup([])
    const id = TeamTaskId(`task-${Number.MAX_SAFE_INTEGER}`)
    lead.session.append('team/task', {
      version: 2,
      teamId: TeamId(lead.id),
      task: {
        id,
        revision: 1,
        subject: 'last numeric task',
        description: 'occupies the final safe numeric task id',
        status: 'pending',
        blockedBy: [],
        writeScopes: [],
      },
    })
    await ctx.sessions.flush(lead.session)

    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'cannot allocate',
      description: 'no safe numeric task id remains',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_LIMIT' })
  })

  it('bounds non-deleted tasks while retaining deleted task ids as tombstones', async () => {
    const { ctx, lead } = await setup([], { maxTasks: 1 })
    const first = await ctx.agentTeams.createTask(lead, { subject: 'first', description: 'first task' })
    await expect(ctx.agentTeams.createTask(lead, { subject: 'overflow', description: 'overflow task' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_LIMIT' })

    const deleted = await ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'delete',
    })
    const second = await ctx.agentTeams.createTask(lead, { subject: 'second', description: 'second task' })
    expect(deleted.status).toBe('deleted')
    expect(second.id).toBe(TeamTaskId('task-2'))
    expect(ctx.agentTeams.getTask(lead, first.id).status).toBe('deleted')
    expect(ctx.agentTeams.listTasks(lead).map(task => task.id)).toEqual([second.id])
  })

  it('enforces CAS, ownership, dependencies, transitions, and write-scope warnings', async () => {
    const { ctx, lead } = await setup(['hang', 'hang', textResponse('beta integrated update')])
    const firstMember = await spawn(ctx, lead, 'alpha')
    const alpha = await waitRunning(ctx, firstMember.member.id)
    const secondMember = await spawn(ctx, lead, 'beta')
    const beta = await waitRunning(ctx, secondMember.member.id)

    const first = await ctx.agentTeams.createTask(alpha, {
      subject: 'first',
      description: 'first task',
      writeScopes: ['src', './src/', 'src'],
    })
    const second = await ctx.agentTeams.createTask(beta, {
      subject: 'second',
      description: 'second task',
      blockedBy: [first.id],
      writeScopes: ['src/feature'],
    })
    expect(first.writeScopes).toEqual(['src'])
    await expect(ctx.agentTeams.updateTask(beta, {
      taskId: second.id,
      expectedRevision: second.revision,
      action: 'claim',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })

    const claimed = await ctx.agentTeams.updateTask(alpha, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'claim',
    })
    await expect(ctx.agentTeams.updateTask(beta, {
      taskId: first.id,
      expectedRevision: claimed.revision,
      action: 'claim',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_ALREADY_CLAIMED' })
    expect(ctx.agentTeams.getTask(beta, second.id)).toMatchObject({
      ready: false,
      writeScopeWarnings: [`write scopes overlap with ${first.id}`],
    })
    await expect(ctx.agentTeams.updateTask(beta, {
      taskId: first.id,
      expectedRevision: claimed.revision,
      action: 'edit',
      subject: 'stolen',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_UNAUTHORIZED' })
    await expect(ctx.agentTeams.updateTask(alpha, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_STALE_REVISION' })

    const completed = await ctx.agentTeams.updateTask(alpha, {
      taskId: first.id,
      expectedRevision: claimed.revision,
      action: 'complete',
    })
    expect(completed.status).toBe('completed')
    expect(ctx.agentTeams.getTask(beta, second.id).ready).toBe(true)
    const secondClaim = await ctx.agentTeams.updateTask(beta, {
      taskId: second.id,
      expectedRevision: second.revision,
      action: 'claim',
    })
    const released = await ctx.agentTeams.updateTask(beta, {
      taskId: second.id,
      expectedRevision: secondClaim.revision,
      action: 'release',
    })
    expect(released).toMatchObject({ status: 'pending', ready: true })
    expect('ownerId' in released).toBe(false)

    ctx.agentTeams.interrupt(lead, 'alpha')
    ctx.agentTeams.interrupt(lead, 'beta')
    await Promise.all([waitNoAgent(ctx, alpha.id), waitNoAgent(ctx, beta.id)])
  })

  it('rejects malformed scopes and every invalid dependency relation', async () => {
    const { ctx, lead } = await setup([])
    const first = await ctx.agentTeams.createTask(lead, { subject: 'one', description: 'one' })
    const second = await ctx.agentTeams.createTask(lead, {
      subject: 'two', description: 'two', blockedBy: [first.id],
    })
    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'bad', description: 'bad', blockedBy: [TeamTaskId('missing')],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'set_dependencies',
      blockedBy: [second.id],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_DEPENDENCY_CYCLE' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'set_dependencies',
      blockedBy: [first.id],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_DEPENDENCY_CYCLE' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'set_dependencies',
      blockedBy: [second.id, second.id],
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    for (const scope of ['', '.', '..', '/root', 'C:\\root', 'C:root', 'a//b', 'a/../b']) {
      await expect(ctx.agentTeams.createTask(lead, {
        subject: 'scope', description: 'scope', writeScopes: [scope],
      })).rejects.toMatchObject({ code: 'TEAM_INVALID_WRITE_SCOPE' })
    }
  })

  it('rejects incomplete mutations, invalid transitions, and deletion of a live blocker', async () => {
    const { ctx, lead } = await setup([])
    await expect(ctx.agentTeams.createTask(lead, { subject: ' ', description: 'invalid' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.createTask(lead, { subject: 'invalid', description: '' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.createTask(lead, { subject: 'x'.repeat(201), description: 'too long' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    const blocker = await ctx.agentTeams.createTask(lead, { subject: 'blocker', description: 'blocker' })
    await ctx.agentTeams.createTask(lead, {
      subject: 'dependent', description: 'dependent', blockedBy: [blocker.id],
    })
    expect(() => ctx.agentTeams.getTask(lead, TeamTaskId('missing')))
      .toThrow(expect.objectContaining({ code: 'TEAM_TASK_NOT_FOUND' }))
    for (const action of ['release', 'complete', 'reopen'] as const) {
      await expect(ctx.agentTeams.updateTask(lead, {
        taskId: blocker.id,
        expectedRevision: blocker.revision,
        action,
      })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    }
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id,
      expectedRevision: blocker.revision,
      action: 'edit',
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id,
      expectedRevision: blocker.revision,
      action: 'set_dependencies',
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id,
      expectedRevision: blocker.revision,
      action: 'delete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_HAS_DEPENDENTS' })
  })

  it('supports Lead reassignment, completion, reopen, and deletion permissions', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'owner')
    const owner = await waitRunning(ctx, started.member.id)
    const task = await ctx.agentTeams.createTask(owner, { subject: 'lifecycle', description: 'lifecycle' })
    const assigned = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'reassign',
      owner: 'owner',
    })
    await expect(ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: assigned.revision,
      action: 'reassign',
      owner: 'lead',
    })).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    const complete = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: assigned.revision,
      action: 'complete',
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: complete.revision,
      action: 'reassign',
      owner: 'lead',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    const reopened = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: complete.revision,
      action: 'reopen',
    })
    const claimed = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: reopened.revision,
      action: 'claim',
    })
    const deleted = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'delete',
    })
    expect(deleted.status).toBe('deleted')
    expect(ctx.agentTeams.listTasks(lead)).toEqual([])
    await expect(ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: deleted.revision,
      action: 'edit',
      subject: 'late',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_DELETED' })
    ctx.agentTeams.interrupt(lead, 'owner')
    await waitNoAgent(ctx, owner.id)
  })

  it('covers partial edits, Lead ownership, unassignment, and blocked reassignment', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'editor')
    const editor = await waitRunning(ctx, started.member.id)
    const blocker = await ctx.agentTeams.createTask(lead, { subject: 'blocker', description: 'blocker' })
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'draft',
      description: 'draft description',
      blockedBy: [blocker.id],
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: TeamTaskId('missing-update'), expectedRevision: 1, action: 'delete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: 'editor',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })

    const leadClaim = await ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id, expectedRevision: blocker.revision, action: 'claim',
    })
    expect(leadClaim.ownerName).toBe('lead')
    const completedBlocker = await ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id, expectedRevision: leadClaim.revision, action: 'complete',
    })
    expect(completedBlocker.status).toBe('completed')
    const assigned = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: 'editor',
    })
    const subject = await ctx.agentTeams.updateTask(editor, {
      taskId: task.id, expectedRevision: assigned.revision, action: 'edit', subject: 'edited subject',
    })
    const description = await ctx.agentTeams.updateTask(editor, {
      taskId: task.id,
      expectedRevision: subject.revision,
      action: 'edit',
      description: 'edited description',
    })
    const scopes = await ctx.agentTeams.updateTask(editor, {
      taskId: task.id,
      expectedRevision: description.revision,
      action: 'edit',
      writeScopes: ['src/nested'],
    })
    expect(scopes).toMatchObject({
      subject: 'edited subject',
      description: 'edited description',
      writeScopes: ['src/nested'],
    })
    const unassigned = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: scopes.revision, action: 'reassign', owner: ' ',
    })
    expect(unassigned).toMatchObject({ status: 'pending' })
    expect('ownerId' in unassigned).toBe(false)

    const broad = await ctx.agentTeams.createTask(lead, {
      subject: 'broad scope', description: 'broad scope', writeScopes: ['src'],
    })
    const narrow = await ctx.agentTeams.createTask(lead, {
      subject: 'narrow scope', description: 'narrow scope', writeScopes: ['src/nested'],
    })
    const disjoint = await ctx.agentTeams.createTask(lead, {
      subject: 'disjoint scope', description: 'disjoint scope', writeScopes: ['docs'],
    })
    await ctx.agentTeams.updateTask(lead, {
      taskId: broad.id, expectedRevision: broad.revision, action: 'claim',
    })
    await ctx.agentTeams.updateTask(lead, {
      taskId: narrow.id, expectedRevision: narrow.revision, action: 'claim',
    })
    await ctx.agentTeams.updateTask(lead, {
      taskId: disjoint.id, expectedRevision: disjoint.revision, action: 'claim',
    })
    expect(ctx.agentTeams.getTask(lead, broad.id).writeScopeWarnings)
      .toEqual([`write scopes overlap with ${narrow.id}`])

    ctx.agentTeams.interrupt(lead, 'editor')
    await waitNoAgent(ctx, editor.id)
  })
})

describe('Team mailbox and waiting', () => {
  it('steers a message addressed to the Lead and checkpoints its receipt', async () => {
    const { ctx, lead } = await setup(['hang'])
    const message: TeamMessageSnapshot = {
      id: TeamMessageId('steer-lead-message'),
      senderId: SessionId('team-worker'),
      senderName: 'worker',
      targetId: lead.id,
      content: content('progress report'),
    }
    lead.session.append('team/message/queued', {
      version: 2,
      teamId: TeamId(lead.id),
      message,
    })

    await expect(teamInternals(ctx).mailbox.tryDispatch(lead, message, SIGNAL)).resolves.toBe(true)
    expect(lead.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(input => input.source.kind === 'team-message'
        && input.source.messageId === message.id))).toBe(true)
    expect(durable(lead).pendingMessages).toEqual([])
    lead.cancel({ kind: 'parent' })
    await lead.whenIdle()
  })

  it('acknowledges steered messages persisted by a busy Lead before model claim', async () => {
    const { ctx, lead, teamFiber } = await setup(['hang', 'hang'], { maxPendingMessagesPerMember: 1 })
    const started = await spawn(ctx, lead, 'lead-reporter')
    const reporter = await waitRunning(ctx, started.member.id)
    lead.followup(createUserMessage({ content: content('keep the Lead busy'), source: { kind: 'user' } }))
    await waitRunning(ctx, lead.id)

    const first = await ctx.agentTeams.sendMessage(reporter, {
      target: 'lead', content: content('first progress report'), signal: SIGNAL,
    })
    const second = await ctx.agentTeams.sendMessage(reporter, {
      target: 'lead', content: content('second progress report'), signal: SIGNAL,
    })
    expect([first.status, second.status]).toEqual(['accepted', 'accepted'])
    expect(lead.status).toBe('running')
    expect(durable(lead).pendingMessages).toEqual([])

    const messageIds = new Set([first.messageId, second.messageId])
    const persisted = await storedEvents(ctx, lead.id)
    const receiptOrder = persisted.flatMap((event) => {
      if (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message =>
        message.source.kind === 'team-message' && messageIds.has(message.source.messageId))) {
        return ['agent/inbox/spliced']
      }
      if (event.type === 'team/message/delivered' && messageIds.has(event.data.messageId)) {
        return ['team/message/delivered']
      }
      return []
    })
    expect(receiptOrder).toEqual([
      'agent/inbox/spliced',
      'team/message/delivered',
      'agent/inbox/spliced',
      'team/message/delivered',
    ])

    const receiptCount = lead.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'team-message'
        && messageIds.has(message.source.messageId))).length
    await teamFiber.dispose()
    await ctx.plugin(TeamService, { maxPendingMessagesPerMember: 1 })
    await vi.waitFor(() => { expect(durable(lead).pendingMessages).toEqual([]) })
    expect(lead.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'team-message'
        && messageIds.has(message.source.messageId)))).toHaveLength(receiptCount)

    lead.cancel({ kind: 'parent' })
    await lead.whenIdle()
  })

  it('flushes a live pending receipt before acknowledgement without inserting a duplicate', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'pending-target')
    const target = await waitRunning(ctx, started.member.id)
    const immediate = await ctx.agentTeams.sendMessage(lead, {
      target: 'pending-target',
      content: content('live steer receipt'),
      signal: SIGNAL,
    })
    expect(immediate.status).toBe('accepted')
    expect(durable(lead).pendingMessages).toEqual([])
    expect(target.inbox.nextStep.some(item => item.source.kind === 'team-message'
      && item.source.messageId === immediate.messageId)).toBe(true)

    const message: TeamMessageSnapshot = {
      id: TeamMessageId('live-pending-message'),
      senderId: lead.id,
      senderName: 'lead',
      targetId: target.id,
      content: content('durable pending receipt'),
    }
    lead.session.append('team/message/queued', {
      version: 2,
      teamId: TeamId(lead.id),
      message,
    })
    await ctx.sessions.flush(lead.session)
    target.inject(createUserMessage({
      content: content('durable pending receipt'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: message.id,
        senderId: lead.id,
        senderName: 'lead',
      },
    }))

    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const flushed: SessionId[] = []
    const flushSpy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      flushed.push(session.id)
      return flush(session)
    })
    const delivered = await teamInternals(ctx).mailbox.tryDispatch(lead, message, SIGNAL)

    expect(delivered).toBe(true)
    expect(flushed.slice(0, 2)).toEqual([target.id, lead.id])
    expect(target.inbox.nextStep.filter(item => item.source.kind === 'team-message'
      && item.source.messageId === message.id)).toHaveLength(1)
    expect(durable(lead).pendingMessages).toEqual([])

    const disappearing: TeamMessageSnapshot = {
      ...message,
      id: TeamMessageId('disappearing-pending-message'),
      content: content('canceled before checkpoint'),
    }
    lead.session.append('team/message/queued', {
      version: 2,
      teamId: TeamId(lead.id),
      message: disappearing,
    })
    await flush(lead.session)
    const disappearingInput = createUserMessage({
      content: content('canceled before checkpoint'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: disappearing.id,
        senderId: lead.id,
        senderName: 'lead',
      },
    })
    target.inject(disappearingInput)
    flushSpy.mockImplementationOnce(async (session) => {
      target.inbox.remove(disappearingInput.id)
      return flush(session)
    })
    await expect(teamInternals(ctx).mailbox.tryDispatch(lead, disappearing, SIGNAL)).resolves.toBe(false)
    expect(durable(lead).pendingMessages.map(pending => pending.id)).toEqual([disappearing.id])

    ctx.agentTeams.interrupt(lead, 'pending-target')
    target.cancel({ kind: 'parent' })
    await waitNoAgent(ctx, target.id)
  })

  it('acknowledges steered messages accepted by a busy target inbox', async () => {
    const { ctx, lead } = await setup(['hang'], { maxPendingMessagesPerMember: 1 })
    const started = await spawn(ctx, lead, 'busy-target')
    const target = await waitRunning(ctx, started.member.id)
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const flushed: SessionId[] = []
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      flushed.push(session.id)
      return flush(session)
    })

    const first = await ctx.agentTeams.sendMessage(lead, {
      target: 'busy-target', content: content('first steered message'), signal: SIGNAL,
    })

    expect(first.status).toBe('accepted')
    expect(flushed).toEqual([lead.id, target.id, lead.id])
    expect(durable(lead).pendingMessages).toEqual([])
    expect(target.inbox.nextStep.some(message => message.source.kind === 'team-message'
      && message.source.messageId === first.messageId)).toBe(true)

    flushed.length = 0
    const second = await ctx.agentTeams.sendMessage(lead, {
      target: 'busy-target', content: content('second steered message'), signal: SIGNAL,
    })

    expect(second.status).toBe('accepted')
    expect(flushed).toEqual([lead.id, target.id, lead.id])
    expect(durable(lead).pendingMessages).toEqual([])
    expect(target.inbox.nextStep.filter(message => message.source.kind === 'team-message'
      && (message.source.messageId === first.messageId || message.source.messageId === second.messageId)))
      .toHaveLength(2)

    ctx.agentTeams.interrupt(lead, 'busy-target')
    target.cancel({ kind: 'parent' })
    await waitNoAgent(ctx, target.id)
  })

  it('serializes concurrent Steer delivery admission for one target', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'ordered-target')
    const target = await waitRunning(ctx, started.member.id)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const admitted: string[] = []
    vi.spyOn(ctx.subagents as unknown as HostPromptDeliverer, deliverSubagentPrompt)
      .mockImplementation(async (_parent, _childId, blocks, source) => {
        const last = blocks.at(-1)
        const text = last?.type === 'text' ? last.text : ''
        admitted.push(text)
        if (text === 'first steer') {
          entered.resolve(undefined)
          await release.promise
        }
        const input = createUserMessage({ content: blocks, source })
        target.inject(input)
        return input.id
      })

    const first = ctx.agentTeams.sendMessage(lead, {
      target: 'ordered-target', content: content('first steer'), signal: SIGNAL,
    })
    await entered.promise
    let secondSettled = false
    const second = ctx.agentTeams.sendMessage(lead, {
      target: 'ordered-target', content: content('second steer'), signal: SIGNAL,
    }).finally(() => { secondSettled = true })
    await vi.waitFor(() => { expect(durable(lead).pendingMessages).toHaveLength(2) })
    expect(admitted).toEqual(['first steer'])
    expect(secondSettled).toBe(false)

    release.resolve(undefined)
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: 'accepted' },
      { status: 'accepted' },
    ])
    expect(admitted).toEqual(['first steer', 'second steer'])

    ctx.agentTeams.interrupt(lead, 'ordered-target')
    target.cancel({ kind: 'parent' })
    await waitNoAgent(ctx, target.id)
  })

  it('delivers persisted mail before the later message that cold-resumes its target', async () => {
    const { ctx, lead } = await setup([textResponse('target initial'), 'hang', 'hang'])
    const started = await spawn(ctx, lead, 'reordered-target')
    await waitNoAgent(ctx, started.member.id)
    const earlier: TeamMessageSnapshot = {
      id: TeamMessageId('earlier-message'),
      senderId: lead.id,
      senderName: 'lead',
      targetId: started.member.id,
      content: content('earlier steer'),
    }
    lead.session.append('team/message/queued', {
      version: 2,
      teamId: TeamId(lead.id),
      message: earlier,
    })
    await ctx.sessions.flush(lead.session)

    const later = await ctx.agentTeams.sendMessage(lead, {
      target: 'reordered-target', content: content('later steer'), signal: SIGNAL,
    })
    expect(later.status).toBe('accepted')
    const target = await waitRunning(ctx, started.member.id)
    await vi.waitFor(() => {
      const accepted = target.session.snapshotEvents().flatMap(event => event.type === 'agent/inbox/spliced'
        ? event.data.inserted.flatMap(message => message.source.kind === 'team-message'
          ? [message.source.messageId]
          : [])
        : [])
      expect(accepted).toEqual([earlier.id, later.messageId])
    })

    ctx.agentTeams.interrupt(lead, 'reordered-target')
    target.cancel({ kind: 'parent' })
    await waitNoAgent(ctx, target.id)
  })

  it('deduplicates live target history and contains inspection and delivery failures', async () => {
    const { ctx, lead } = await setup(['hang', textResponse('inactive target initial')])
    const liveStarted = await spawn(ctx, lead, 'live-target')
    const live = await waitRunning(ctx, liveStarted.member.id)
    const internal = teamInternals(ctx).mailbox
    const message: TeamMessageSnapshot = {
      id: TeamMessageId('live-recorded-message'),
      senderId: lead.id,
      senderName: 'lead',
      targetId: live.id,
      content: content('already in live history'),
    }
    lead.session.append('team/message/queued', {
      version: 2, teamId: TeamId(lead.id), message,
    })
    await ctx.sessions.flush(lead.session)
    live.session.append('user/message', createUserMessage({
      content: content('different Team message first'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: TeamMessageId('other-message'),
        senderId: lead.id,
        senderName: 'lead',
      },
    }), { surfaceOp: 'append' })
    live.session.append('user/message', createUserMessage({
      content: content('already in live history'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: message.id,
        senderId: lead.id,
        senderName: 'lead',
      },
    }), { surfaceOp: 'append' })
    await expect(internal.tryDispatch(lead, message, SIGNAL)).resolves.toBe(true)
    await internal.markDelivered(lead, message.id, live.id)
    await expect(internal.tryDispatch(lead, message, SIGNAL)).resolves.toBe(true)

    const wrongTarget: TeamMessageSnapshot = {
      ...message,
      id: TeamMessageId('wrong-target-message'),
    }
    lead.session.append('team/message/queued', {
      version: 2, teamId: TeamId(lead.id), message: wrongTarget,
    })
    await ctx.sessions.flush(lead.session)
    await internal.markDelivered(lead, wrongTarget.id, SessionId('wrong-target'))
    await expect(internal.serializeTarget(wrongTarget.targetId, async () => true)).resolves.toBe(true)
    const serialEntered = Promise.withResolvers<undefined>()
    const releaseSerial = Promise.withResolvers<undefined>()
    const serialFirst = internal.serializeTarget(wrongTarget.targetId, async () => {
      serialEntered.resolve(undefined)
      await releaseSerial.promise
      return true
    })
    await serialEntered.promise
    const serialSecond = internal.serializeTarget(wrongTarget.targetId, async () => true)
    releaseSerial.resolve(undefined)
    await expect(Promise.all([serialFirst, serialSecond])).resolves.toEqual([true, true])

    const warnings: string[] = []
    ctx.logger.warn = ((value: unknown) => { warnings.push(String(value)) }) as typeof ctx.logger.warn
    const failedAck = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('acknowledgement flush failed'))
    live.session.append('user/message', createUserMessage({
      content: content('acknowledgement failure'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: wrongTarget.id,
        senderId: lead.id,
        senderName: 'lead',
      },
    }), { surfaceOp: 'append' })
    await vi.waitFor(() => {
      expect(warnings.some(warning => warning.includes('acknowledgement flush failed'))).toBe(true)
    })
    failedAck.mockRestore()

    const inactiveStarted = await spawn(ctx, lead, 'inactive-target')
    await waitNoAgent(ctx, inactiveStarted.member.id)
    const openRead = vi.spyOn(ctx.sessionPersistence, 'open').mockRejectedValueOnce(new Error('read unavailable'))
    const uncertain = await ctx.agentTeams.sendMessage(lead, {
      target: 'inactive-target', content: content('inspection failure'), signal: SIGNAL,
    })
    expect(uncertain.status).toBe('queued')
    openRead.mockRestore()

    vi.spyOn(ctx.subagents as unknown as HostPromptDeliverer, deliverSubagentPrompt)
      .mockRejectedValueOnce(new Error('delivery unavailable'))
    const failed = await ctx.agentTeams.sendMessage(lead, {
      target: 'inactive-target', content: content('delivery failure'), signal: SIGNAL,
    })
    expect(failed.status).toBe('queued')
    expect(warnings.some(warning => warning.includes('read unavailable'))).toBe(true)
    expect(warnings.some(warning => warning.includes('delivery unavailable'))).toBe(true)

    ctx.agentTeams.interrupt(lead, 'live-target')
    await waitNoAgent(ctx, live.id)
  })

  it('cold-resumes an inactive sibling with sender attribution', async () => {
    const { ctx, lead } = await setup(['hang', 'hang'])
    const alphaStarted = await spawn(ctx, lead, 'alpha')
    const alpha = await waitRunning(ctx, alphaStarted.member.id)
    const betaStarted = await spawn(ctx, lead, 'beta')
    const beta = await waitRunning(ctx, betaStarted.member.id)
    ctx.agentTeams.interrupt(lead, 'beta')
    await waitNoAgent(ctx, beta.id)

    const first = await ctx.agentTeams.sendMessage(alpha, {
      target: 'beta', content: content('first update'), signal: SIGNAL,
    })
    expect(first.status).toBe('accepted')
    await waitNoAgent(ctx, betaStarted.member.id)
    await vi.waitFor(() => { expect(durable(lead).pendingMessages).toEqual([]) })

    const stored = await storedEvents(ctx, betaStarted.member.id)
    const peerMessages = stored.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'team-message')
    expect(peerMessages.map((event) => {
      if (event.type !== 'user/message') return undefined
      const block = event.data.content.at(-1)
      return block?.type === 'text' ? block.text : undefined
    })).toEqual(['first update'])
    expect(peerMessages.map(event => event.type === 'user/message'
      ? event.data.content[0]?.type === 'text' && event.data.content[0].text
      : undefined)).toEqual([
      expect.stringMatching(/^Team message .* from alpha:$/u),
    ])
    expect(peerMessages.map(event => event.type === 'user/message' && event.data.source.kind === 'team-message'
      ? [event.data.source.messageId, event.data.source.senderName]
      : undefined)).toEqual([
      [first.messageId, 'alpha'],
    ])

    ctx.agentTeams.interrupt(lead, 'alpha')
    await waitNoAgent(ctx, alpha.id)
  })

  it('enforces message byte and pending-count limits without encouraging retry after enqueue', async () => {
    const { ctx, lead } = await setup([textResponse('idle')], {
      maxMessageBytes: 256,
      maxPendingMessagesPerMember: 1,
    })
    const target = await spawn(ctx, lead, 'target')
    await waitNoAgent(ctx, target.member.id)
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'target', content: content('x'.repeat(300)), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_TOO_LARGE' })
    vi.spyOn(ctx.sessionPersistence, 'open').mockRejectedValueOnce(new Error('temporary read failure'))
    const queued = await ctx.agentTeams.sendMessage(lead, {
      target: 'target', content: content('one'), signal: SIGNAL,
    })
    expect(queued.status).toBe('queued')
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'target', content: content('two'), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MAILBOX_FULL' })
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'lead', content: content('self'), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_SELF_MESSAGE' })
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'missing', content: content('unknown target'), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    const controller = new AbortController()
    controller.abort(new TeamError('cancelled before queue', 'TEST_CANCELLED'))
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'target', content: content('cancelled'), signal: controller.signal,
    })).rejects.toMatchObject({ code: 'TEST_CANCELLED' })
  })

  it('interrupts only the current turn and retains an already accepted follow-up', async () => {
    const { ctx, lead } = await setup(['hang', textResponse('after interrupt')])
    const started = await spawn(ctx, lead, 'worker')
    const worker = await waitRunning(ctx, started.member.id)
    const followup = await ctx.agentTeams.sendMessage(lead, {
      target: 'worker', content: content('retained follow-up'), signal: SIGNAL,
    })
    expect(followup.status).toBe('accepted')
    expect(ctx.agentTeams.interrupt(lead, 'worker')).toEqual({ previousStatus: 'running' })
    await vi.waitFor(() => { expect(worker.status).toBe('idle') })
    expect(worker.inbox.nextStep.some(message => message.source.kind === 'team-message'
      && message.source.messageId === followup.messageId)).toBe(true)
    worker.cancel({ kind: 'parent' })
    await waitNoAgent(ctx, worker.id)
  })

  it('waits for one change, supports cancellation, times out, and releases waiters on HMR disposal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-wait-'))
    roots.push(storageRoot)
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    const fiber = await ctx.plugin(TeamService)
    const service = ctx.agentTeams
    const lead = await ctx.agentLoop.create(SessionId('wait-lead'), {})

    await expect(service.waitForChange(lead, 9_999, SIGNAL))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_TIMEOUT' })
    const alreadyAborted = new AbortController()
    alreadyAborted.abort(new TeamError('cancelled before wait', 'TEST_CANCELLED'))
    await expect(service.waitForChange(lead, 10_000, alreadyAborted.signal))
      .rejects.toMatchObject({ code: 'TEST_CANCELLED' })

    const changed = service.waitForChange(lead, 10_000, SIGNAL)
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const flushEntered = Promise.withResolvers<undefined>()
    const releaseFlush = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      flushEntered.resolve(undefined)
      await releaseFlush.promise
      return await flush(session)
    })
    let waitSettled = false
    void changed.finally(() => { waitSettled = true })
    const creating = service.createTask(lead, { subject: 'wake', description: 'wake waiter' })
    await flushEntered.promise
    expect(waitSettled).toBe(false)
    releaseFlush.resolve(undefined)
    await creating
    await expect(changed).resolves.toEqual({ timedOut: false })

    const controller = new AbortController()
    const cancelled = service.waitForChange(lead, 10_000, controller.signal)
    controller.abort(new TeamError('cancelled', 'TEST_CANCELLED'))
    await expect(cancelled).rejects.toMatchObject({ code: 'TEST_CANCELLED' })

    const stringAbort = new AbortController()
    const firstWaiter = service.waitForChange(lead, 10_000, stringAbort.signal)
    const secondWaiter = service.waitForChange(lead, 10_000, SIGNAL)
    stringAbort.abort('string cancellation')
    await expect(firstWaiter).rejects.toMatchObject({
      code: 'TEAM_WAIT_ABORTED',
      message: 'wait_agent aborted: string cancellation',
    })
    await service.createTask(lead, { subject: 'second waiter', description: 'second waiter remains registered' })
    await expect(secondWaiter).resolves.toEqual({ timedOut: false })

    const objectAbort = new AbortController()
    const objectCancelled = service.waitForChange(lead, 10_000, objectAbort.signal)
    objectAbort.abort({ kind: 'user' })
    await expect(objectCancelled).rejects.toMatchObject({
      code: 'TEAM_WAIT_ABORTED',
      message: "wait_agent aborted: { kind: 'user' }",
    })

    await service.createTask(lead, { subject: 'already changed', description: 'edge-triggered wait' })
    vi.useFakeTimers()
    const timeout = service.waitForChange(lead, 10_000, SIGNAL)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(timeout).resolves.toEqual({ timedOut: true })
    vi.useRealTimers()

    const disposed = service.waitForChange(lead, 10_000, SIGNAL)
    await fiber.dispose()
    await expect(disposed).resolves.toEqual({ timedOut: false })
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('disposes live teammate Activations and their waits when the Team service unloads', async () => {
    const { ctx, lead, teamFiber } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'dispose-worker')
    await waitRunning(ctx, started.member.id)
    const waiting = ctx.agentTeams.waitForChange(lead, 10_000, SIGNAL)

    await teamFiber.dispose()

    await expect(waiting).resolves.toEqual({ timedOut: false })
    expect(ctx.agents.get(started.member.id)).toBeUndefined()
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('closes creation admission and drains an in-flight spawn before unload completes', async () => {
    const { ctx, lead, teamFiber } = await setup(['hang'])
    const service = ctx.agentTeams
    const start = ctx.subagents.startContinuable.bind(ctx.subagents)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let childId: SessionId | undefined
    vi.spyOn(ctx.subagents, 'startContinuable').mockImplementation(async (spec) => {
      childId = spec.childId
      entered.resolve(undefined)
      await release.promise
      return start(spec)
    })
    const spawning = spawn(ctx, lead, 'disposing-worker')
    const rejected = expect(spawning).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
    await entered.promise

    const disposal = teamFiber.dispose()
    await Promise.resolve()
    await expect(service.waitForChange(lead, 3_600_000, SIGNAL)).resolves.toEqual({ timedOut: false })
    await expect(service.spawnTeammate(lead, {
      name: 'late-worker',
      description: 'must not enter after disposal',
      prompt: content('late task'),
      context: 'fresh',
      provider: 'spawn',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
    release.resolve(undefined)

    await rejected
    await disposal
    if (childId !== undefined) expect(ctx.agents.get(childId)).toBeUndefined()
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('retains an in-flight creation cleanup failure during disposal', async () => {
    const { ctx } = await setup([])
    const internal = teamInternals(ctx)
    const cleanupFailure = new Error('creation cleanup failed')
    const rejected = Promise.reject(cleanupFailure)
    void rejected.catch(() => undefined)
    internal.roster.inFlightCreations.add(rejected)

    await expect(internal.disposeRuntime()).rejects.toMatchObject({ errors: [cleanupFailure] })
  })

  it('recognizes wrapped and coded runtime cancellation during disposal settlement', async () => {
    const open = new TeamRuntimeLifecycle(100)
    const ordinaryFailure = new Error('ordinary failure before disposal')
    const openFailures: unknown[] = []
    await open.settle([Promise.reject(ordinaryFailure)], openFailures)
    expect(openFailures).toEqual([ordinaryFailure])

    const lifecycle = new TeamRuntimeLifecycle(100)
    lifecycle.close()
    const failures: unknown[] = []
    await lifecycle.settle([
      Promise.reject(new Error('wrapped cancellation', { cause: lifecycle.reason })),
      Promise.reject(new TeamError('translated cancellation', 'TEAM_DISPOSED')),
    ], failures)
    expect(failures).toEqual([])

    const cyclic = new Error('unrelated cyclic failure')
    cyclic.cause = cyclic
    await lifecycle.settle([Promise.reject(cyclic)], failures)
    expect(failures).toEqual([cyclic])
  })

  it('disposes a live child even after its durable member edge becomes failed', async () => {
    const { ctx, lead } = await setup(['hang'])
    const childId = SessionId('failed-live-child')
    const member = {
      id: childId,
      name: 'failed-live-worker',
      description: 'failed-live-worker responsibility',
      provider: 'spawn',
      context: 'fresh' as const,
      phase: 'provisioning' as const,
    }
    lead.session.append('team/member', {
      version: 2,
      teamId: TeamId(lead.id),
      member,
    })
    await ctx.subagents.startContinuable({
      childId,
      provider: 'spawn',
      label: member.description,
      request: { prompt: content('failed child task'), parent: lead },
      signal: SIGNAL,
    })
    await waitRunning(ctx, childId)
    lead.session.append('team/member', {
      version: 2,
      teamId: TeamId(lead.id),
      member: {
        ...member,
        phase: 'failed',
        error: 'creation cleanup is pending',
      },
    })
    await ctx.sessions.flush(lead.session)
    expect(ctx.agentTeams.listMembers(lead)[1]?.status).toBe('failed')

    const internal = ctx.agentTeams as unknown as { disposeRuntime(): Promise<void> }
    await internal.disposeRuntime()
    expect(ctx.agents.get(childId)).toBeUndefined()
  })

  it('aborts and awaits an admitted cold mailbox dispatch during disposal', async () => {
    const { ctx, lead } = await setup([textResponse('worker done')])
    const started = await spawn(ctx, lead, 'mailbox-worker')
    await waitNoAgent(ctx, started.member.id)
    const entered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.subagents as unknown as HostPromptDeliverer, deliverSubagentPrompt)
      .mockImplementation(async (_parent, _childId, _content, _source, signal) => {
        entered.resolve(undefined)
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted.resolve(undefined)
            void release.promise.then(() => {
              const reason: unknown = signal.reason
              reject(reason instanceof Error ? reason : new Error(String(reason)))
            })
          }, { once: true })
        })
      })

    const sending = ctx.agentTeams.sendMessage(lead, {
      target: 'mailbox-worker',
      content: content('resume during disposal'),
      signal: SIGNAL,
    })
    await entered.promise
    const internal = ctx.agentTeams as unknown as { disposeRuntime(): Promise<void> }
    let disposed = false
    const disposal = internal.disposeRuntime().then(() => { disposed = true })
    await aborted.promise
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve(undefined)

    await expect(sending).resolves.toMatchObject({ status: 'queued' })
    await disposal
    expect(disposed).toBe(true)
    expect(ctx.agents.get(started.member.id)).toBeUndefined()
  })

  it('awaits an admitted asynchronous acknowledgement before disposal completes', async () => {
    const { ctx, lead } = await setup([])
    const message: TeamMessageSnapshot = {
      id: TeamMessageId('dispose-ack-message'),
      senderId: SessionId('sender'),
      senderName: 'sender',
      targetId: lead.id,
      content: content('acknowledge before disposal'),
    }
    lead.session.append('team/message/queued', {
      version: 2,
      teamId: TeamId(lead.id),
      message,
    })
    await ctx.sessions.flush(lead.session)

    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    let blockReceipt = true
    const flushSpy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (blockReceipt && session === lead.session) {
        blockReceipt = false
        entered.resolve(undefined)
        await release.promise
      }
      return flush(session)
    })
    lead.session.append('user/message', createUserMessage({
      content: content('acknowledge before disposal'),
      source: {
        kind: 'team-message',
        teamId: TeamId(lead.id),
        messageId: message.id,
        senderId: message.senderId,
        senderName: message.senderName,
      },
    }), { surfaceOp: 'append' })

    const internal = ctx.agentTeams as unknown as { disposeRuntime(): Promise<void> }
    let disposed = false
    const disposal = internal.disposeRuntime().then(() => { disposed = true })
    await entered.promise
    await Promise.resolve()
    const disposedBeforeRelease = disposed
    release.resolve(undefined)
    await disposal

    expect(disposedBeforeRelease).toBe(false)
    expect(disposed).toBe(true)
    expect(durable(lead).pendingMessages).toEqual([])
    flushSpy.mockRestore()
  })

  it('bounds Team runtime disposal when a continuation drain never settles', { timeout: 30_000 }, async () => {
    const { ctx, lead, teamFiber } = await setup(['hang'], { disposalTimeoutMs: 25 })
    const started = await spawn(ctx, lead, 'stuck-worker')
    await waitRunning(ctx, started.member.id)
    const drain = vi.spyOn(ctx.subagents, 'drainContinuableChildren')
      .mockImplementation(() => new Promise(() => {}))

    const outcome = await Promise.race([
      teamFiber.dispose().then(() => 'disposed'),
      new Promise<'hung'>((resolve) => { setTimeout(() => { resolve('hung') }, 1_000) }),
    ])
    expect(outcome).toBe('disposed')
    expect(drain).toHaveBeenCalledWith(lead, [started.member.id])
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('bounds disposal while an admitted creation ignores cancellation', async () => {
    const { ctx, lead } = await setup([], { disposalTimeoutMs: 25 })
    const internal = teamInternals(ctx)
    internal.roster.inFlightCreations.add(new Promise(() => {}))

    await expect(internal.disposeRuntime()).rejects.toBeInstanceOf(AggregateError)
    await expect(ctx.agentTeams.spawnTeammate(lead, {
      name: 'after-timeout',
      description: 'admission remains closed',
      prompt: content('must reject'),
      context: 'fresh',
      provider: 'spawn',
      signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
    await expect(ctx.agentTeams.sendMessage(lead, {
      target: 'nobody', content: content('must reject'), signal: SIGNAL,
    })).rejects.toMatchObject({ code: 'TEAM_DISPOSED' })
    await expect(internal.mailbox.tryDispatch(lead, {
      id: TeamMessageId('post-disposal-message'),
      senderId: lead.id,
      senderName: 'lead',
      targetId: lead.id,
      content: content('must not dispatch'),
    }, SIGNAL)).resolves.toBe(false)
  })

  it('contains recovery callback failures and ignores work scheduled after disposal', async () => {
    const { ctx, lead, teamFiber } = await setup([])
    const warnings: string[] = []
    ctx.logger.warn = ((value: unknown) => { warnings.push(String(value)) }) as typeof ctx.logger.warn
    const internal = teamInternals(ctx)
    internal.recoverFor = async () => { throw new Error('forced recovery failure') }
    internal.scheduleRecovery(lead)
    await Promise.resolve()
    await Promise.resolve()
    expect(warnings.some(warning => warning.includes('forced recovery failure'))).toBe(true)

    lead.session.append('user/message', createUserMessage({
      content: content('orphan Team source'),
      source: {
        kind: 'team-message',
        teamId: TeamId('absent-team'),
        messageId: TeamMessageId('absent-team-message'),
        senderId: SessionId('absent-sender'),
        senderName: 'absent',
      },
    }), { surfaceOp: 'append' })
    await Promise.resolve()

    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    internal.recoverFor = async () => {
      entered.resolve(undefined)
      await release.promise
      throw new Error('failure after disposal')
    }
    internal.scheduleRecovery(lead)
    await entered.promise
    await teamFiber.dispose()
    release.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()
    internal.scheduleRecovery(lead)
    await Promise.resolve()
  })

  it('reports contained teardown failures without retaining the Team service', async () => {
    const { ctx, lead, teamFiber } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'failing-drain')
    await waitRunning(ctx, started.member.id)
    vi.spyOn(ctx.subagents, 'drainContinuableDescendants').mockRejectedValueOnce(new Error('drain failure'))

    await teamFiber.dispose()
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('reconciles mismatched persisted children and ignores a concurrently settled member', async () => {
    const first = await setup([])
    const liveId = SessionId('live-provisioning-child')
    const live = await first.ctx.agents.create({
      sessionId: liveId,
      meta: { parentSession: first.lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const provisioning = {
      id: liveId,
      name: 'mismatched-child',
      description: 'mismatched persisted child',
      provider: 'spawn',
      context: 'fresh' as const,
      phase: 'provisioning' as const,
    }
    first.lead.session.append('team/member', {
      version: 2, teamId: TeamId(first.lead.id), member: provisioning,
    })
    const reconcileFirst = teamInternals(first.ctx).roster
    await reconcileFirst.reconcileProvisioning(first.lead, SIGNAL)
    expect(durable(first.lead).members[0]?.phase).toBe('provisioning')
    live.agent.session.append('user/message', createUserMessage({
      content: content('persist mismatched child'), source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await first.ctx.sessions.flush(live.agent.session)
    await live.dispose()
    await reconcileFirst.reconcileProvisioning(first.lead, SIGNAL)
    expect(durable(first.lead).members[0]).toMatchObject({
      phase: 'failed',
      error: 'persisted child Session does not match the provisioned continuation',
    })

    const second = await setup([])
    const childId = SessionId('concurrently-settled-child')
    const member = { ...provisioning, id: childId, name: 'concurrent-child' }
    second.lead.session.append('team/member', {
      version: 2, teamId: TeamId(second.lead.id), member,
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(second.ctx.sessionPersistence, 'open').mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      throw new Error('late inspection failure')
    })
    const reconcileSecond = teamInternals(second.ctx).roster
    const reconciling = reconcileSecond.reconcileProvisioning(second.lead, SIGNAL)
    await entered.promise
    second.lead.session.append('team/member', {
      version: 2,
      teamId: TeamId(second.lead.id),
      member: { ...member, phase: 'failed', error: 'settled elsewhere' },
    })
    release.resolve(undefined)
    await reconciling
    expect(durable(second.lead).members[0]).toMatchObject({
      phase: 'failed', error: 'settled elsewhere',
    })
  })
})
