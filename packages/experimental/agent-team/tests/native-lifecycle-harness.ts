import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { InputControllerId, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { onTestFinished, vi } from 'vitest'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService, { TeamId, type Config, type TeamMemberSnapshot, type TeamMessageSnapshot } from '../src/index.ts'
import type { TeamState } from '../src/projection.ts'
import { TestSessionQuery } from './test-session-query.ts'

const signal = new AbortController().signal

/** Read the authoritative state used by roster and mailbox operations.
 * @param ctx - real native Team composition.
 * @param lead - exact live journal owner.
 * @returns current validated Team state.
 */
export function nativeState(ctx: Context, lead: Agent): TeamState {
  const state = ctx.sessionProjections.stateOf(lead.session, 'agentTeam')
  if (state === undefined || state.failure !== undefined) throw new Error('fixture Team state is unavailable')
  return state
}

interface NativeTestInternals {
  mailbox: {
    tryDispatch(root: Agent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean>
    scheduleRetry(root: Agent, message: TeamMessageSnapshot): void
    markDelivered(root: Agent, messageId: TeamMessageSnapshot['id'], targetId: SessionIdType): Promise<void>
    recoverFor(agent: Agent, signal: AbortSignal): Promise<void>
    pendingDispatches(): readonly Promise<unknown>[]
  }
  roster: {
    recoverFor(agent: Agent, signal: AbortSignal): Promise<void>
    reconcileProvisioning(root: Agent, signal: AbortSignal): Promise<void>
    reconcileRetiring(root: Agent, signal: AbortSignal): Promise<void>
    finishRetirement(root: Agent, id: SessionIdType): Promise<void>
    settleProvisioning(root: Agent, terminal: TeamMemberSnapshot): Promise<'active' | 'failed'>
    failRegisteredMember(root: Agent, id: SessionIdType, reason: string): Promise<void>
    tryMembership(agent: Agent): unknown
  }
}

/** Access lifecycle owners without publishing test operations on the service.
 * @param ctx - real native Team composition.
 * @returns the package-private owners under test.
 */
export function nativeInternals(ctx: Context): NativeTestInternals {
  return { mailbox: Reflect.get(ctx.agentTeams, 'mailbox') as NativeTestInternals['mailbox'],
    roster: Reflect.get(ctx.agentTeams, 'roster') as NativeTestInternals['roster'] }
}

/** Mount production Team, Preset, continuation and JSONL services around a scripted model.
 * @param options - owner-local configuration and model responses.
 * @returns real lifecycle handles, model observations, and member creation.
 */
export async function nativeHarness(options: {
  controlled?: boolean
  config?: Config
  script?: ConstructorParameters<typeof MockAdapter>[0]
  validateGroup?: (caller: Agent, group: string | undefined) => void
  writer?: boolean
  presets?: boolean
} = {}) {
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-lifecycle-'))
  onTestFinished(async () => {
    vi.useRealTimers()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
  let removeReviewer: (() => Promise<void>) | undefined
  if (options.presets !== false) {
    await ctx.plugin(AgentPresets, { default: 'standard' })
    await ctx.agentPresets.register({ id: 'standard', name: 'Standard', plugins: [] })
    removeReviewer = await ctx.agentPresets.register({ id: 'reviewer', name: 'Reviewer', plugins: [] })
  }
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  const spawnFiber = await ctx.plugin(Spawn, { providerName: 'spawn' })
  const config: Config = { ...options.controlled === false ? {} : {
    controlledMode: { kind: 'controlled', requiredTaskExtensionId: 'lifecycle-writer',
      permissionTableId: 'table', permissionRevision: 'revision', maxOrdinaryMessageBytes: 4096 },
  }, ...options.config }
  const fiber = await ctx.plugin(TeamService, config)
  const adapter = new MockAdapter(options.script ?? [])
  ctx.llm.registerAdapter(['mock'], adapter)
  const leadHandle = await ctx.agents.create({ sessionId: SessionId('native-lifecycle-lead'),
    agentOptions: { provider: 'mock', model: 'mock' } })
  const lead = leadHandle.agent
  const policy = { admission: 'accept' as 'accept' | 'hold' | 'reject', rejectMessageId: undefined as string | undefined }
  const controller = ctx.agents.registerInputController(InputControllerId('native-lifecycle-fixture'), {
    admit: (_agent, input) => policy.admission === 'reject'
      || input.message.source.kind === 'team-message' && input.message.source.messageId === policy.rejectMessageId
      ? { kind: 'reject', reason: 'fixture custody rejected' }
      : { kind: policy.admission }, canStart: () => false, canClaim: () => false,
  })
  controller.bind(lead.session)
  const unavailable = async (): Promise<never> => { throw new Error('Task writer not used by lifecycle fixture') }
  const writer = options.writer === false ? undefined : ctx.agentTeams.installTaskExtension({
    id: 'lifecycle-writer', validateMemberGroup: options.validateGroup ?? (() => {}),
    assessSettlementNotice: () => 'suppress', create: unavailable, update: unavailable,
  })
  onTestFinished(() => { writer?.dispose() })
  const spawn = (name: string, request: { group?: string
    presetId?: string
    applicationId?: string
    slotId?: string
    expectedPresetRevision?: string
    signal?: AbortSignal } = {}) => ctx.agentTeams.spawnTeammate(lead, {
    name, description: 'Lifecycle fixture member', prompt: [{ type: 'text', text: 'Initial work' }],
    context: 'fresh', provider: 'spawn', ...request, signal: request.signal ?? signal,
  })
  const queue = async (message: TeamMessageSnapshot) => {
    lead.session.append('team/message/queued', { version: 2, teamId: TeamId(lead.id), message })
    await ctx.sessions.flush(lead.session)
  }
  return { ctx, lead, leadHandle, adapter, fiber, spawnFiber, root, policy, controller, writer, removeReviewer, spawn, queue, signal }
}
