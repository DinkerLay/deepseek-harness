/** Host-owned delegated execution. Business controllers retain authority across Lead replacement. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { freezeMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { installSubagentArchiveAdmission } from './archive-admission.ts'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import {
  appendDelegatedPolicyOverrides, applyDelegatedComposition, captureDelegatedPolicyOverrides,
  childSessionMeta, resolveChildAgentOptions, resolveChildDepth, type ChildComposition,
} from './child-agent.ts'
import {
  hostDelegationProjection, delegationMessageId, delegationMessageDigest, type DelegationOwnerId, type DelegationRequestId,
  type HostDelegatedDescriptor, type HostDelegatedState,
} from './host-owned-state.ts'

export { DelegationOwnerId, DelegationRequestId, delegationMessageId } from './host-owned-state.ts'
export type { HostDelegatedDescriptor, HostDelegatedState } from './host-owned-state.ts'

/** Host creation input; caller authorization must precede this trusted API. */
export interface CreateHostDelegatedAgent {
  readonly ownerId: DelegationOwnerId
  readonly sessionId: SessionId
  readonly source: Agent
  readonly presetId: string
  /** Expected captured declaration digest when the controller already reserved a specific revision. */
  readonly presetRevision?: string
  readonly agentOptions?: AgentOptions
  readonly composition: ChildComposition
  readonly signal?: AbortSignal
}
/** Deployment depth budget for delegated execution. */
export interface HostDelegatedConfig { maxDepth: number }

declare module '@deepseek-ai/cordis' {
  interface Context { hostDelegatedAgents: HostDelegatedAgents }
}

/** Real Agent handles owned by a Host plugin, never by a disposable Lead Agent. */
export default class HostDelegatedAgents extends Service {
  static inject = ['agents', 'sessions', 'agentPresets', 'sessionProjections', 'sessionQuery', 'sessionPersistence']
  static Config: z<HostDelegatedConfig> = z.object({ maxDepth: z.number().step(1).min(1).required() })
  private readonly owner: Context
  private readonly handles = new Map<SessionId, AgentHandle>()
  private readonly pending = new Map<SessionId, Promise<unknown>>()
  private closed = false

  constructor(ctx: Context, private readonly config: HostDelegatedConfig) {
    super(ctx, 'hostDelegatedAgents')
    if (scopeOf(ctx) !== undefined) throw new Error('Host delegated execution must be mounted outside Agent scopes')
    this.owner = ctx
    ctx.sessionProjections.register(hostDelegationProjection)
    installSubagentArchiveAdmission(ctx)
    ctx.effect(() => async () => {
      this.closed = true
      await Promise.allSettled([...this.pending.values()])
      await Promise.all([...this.handles.values()].map(handle => handle.dispose()))
      this.handles.clear()
    })
  }

  private run<T>(id: SessionId, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Host delegated execution is closed'))
    const promise = (this.pending.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => {
      if (this.closed) throw new Error('Host delegated execution is closed')
      return operation()
    })
    this.pending.set(id, promise)
    void promise.finally(() => { if (this.pending.get(id) === promise) this.pending.delete(id) }).catch(() => undefined)
    return promise
  }

  private state(agent: Agent, ownerId: DelegationOwnerId): HostDelegatedState & { descriptor: HostDelegatedDescriptor } {
    const state = this.owner.sessionProjections.stateOf(agent.session, 'hostDelegation')
    if (state?.descriptor?.ownerId !== ownerId) throw new Error('Host delegated execution owner mismatch')
    if (state.retired) throw new Error('Host delegated execution is retired')
    return { ...state, descriptor: state.descriptor }
  }

  private async flush(agent: Agent): Promise<void> {
    if (!await this.owner.sessions.flush(agent.session)) throw new Error('Host delegated execution requires durable Session writes')
  }

  /** Create a delegated execution, or recover the same reserved identity after an uncertain creation.
   * @param request - admitted owner, source Agent and explicit preset.
   * @returns the real Agent after its ownership and delegation policy are durably recorded.
   */
  create(request: CreateHostDelegatedAgent): Promise<Agent> {
    // Capture permissions and route before the first await; future Lead changes cannot widen this delegation.
    const depth = resolveChildDepth(request.source, this.config.maxDepth)
    const policies = captureDelegatedPolicyOverrides(request.source)
    const options = resolveChildAgentOptions(request.source, request.agentOptions, depth)
    const meta = childSessionMeta(request.source, depth, false)
    const composition = snapshotJsonValue(request.composition)
    if (composition === undefined) return Promise.reject(new Error('Delegated composition must be lossless JSON'))
    return this.run(request.sessionId, async () => {
      if (this.owner.agents.get(request.source.id) !== request.source) throw new Error('Delegating source is no longer live')
      request.signal?.throwIfAborted()
      if (await this.owner.sessionPersistence.stat(request.sessionId) !== undefined) {
        const agent = await this.restore(request.ownerId, request.sessionId, request.signal)
        if (this.state(agent, request.ownerId).descriptor.presetId !== request.presetId) throw new Error('Reserved delegation preset mismatch')
        return agent
      }
      await using preset = await this.owner.agentPresets.acquireComposition(request.presetId)
      if (preset.revision === undefined) throw new Error('Delegated preset declaration is not durably identifiable')
      if (request.presetRevision !== undefined && request.presetRevision !== preset.revision) throw new Error('Reserved delegated preset revision changed')
      const descriptor: HostDelegatedDescriptor = {
        version: 1, ownerId: request.ownerId, presetId: preset.id, presetRevision: preset.revision,
        options: {
          subagentDepth: depth,
          ...(options.provider === undefined ? {} : { provider: options.provider }),
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        }, composition,
      }
      const handle = await this.owner.agents.create({
        sessionId: request.sessionId, meta: { ...meta, agentPreset: preset.id }, agentOptions: descriptor.options,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        setup: async (ctx, child) => {
          await preset.mount(ctx)
          child.session.append('subagent/host-owned', descriptor)
          appendDelegatedPolicyOverrides(child.session, policies)
          applyDelegatedComposition(ctx, composition)
        },
      })
      this.handles.set(request.sessionId, handle)
      try { await this.flush(handle.agent); return handle.agent }
      catch (error) { await handle.dispose(); this.handles.delete(request.sessionId); throw error }
    })
  }

  /** Recover an execution without a live parent; owner, preset revision and retirement are checked before publication.
   * @param ownerId - admitted durable controller identity.
   * @param sessionId - reserved execution session.
   * @param signal - cancellation before publication.
   * @returns the live delegated Agent.
   */
  resume(ownerId: DelegationOwnerId, sessionId: SessionId, signal?: AbortSignal): Promise<Agent> {
    return this.run(sessionId, () => this.restore(ownerId, sessionId, signal))
  }

  private async restore(ownerId: DelegationOwnerId, sessionId: SessionId, signal?: AbortSignal): Promise<Agent> {
    const resident = this.handles.get(sessionId)
    if (resident !== undefined) {
      if (this.owner.agents.get(sessionId) !== resident.agent) throw new Error('Host delegated execution is no longer resident')
      this.state(resident.agent, ownerId); return resident.agent
    }
    using observation = await this.owner.sessionQuery.observeSession(sessionId, { projectionMode: 'all', ...(signal === undefined ? {} : { signal }) })
    const events = observation.events.filter(event => event.type === 'subagent/host-owned')
    if (events.length !== 1 || events[0]?.data.ownerId !== ownerId) throw new Error('Host delegated execution owner mismatch')
    const descriptor = events[0].data
    if (observation.events.some(event => event.type === 'subagent/host-retired')) throw new Error('Host delegated execution is retired')
    await using preset = await this.owner.agentPresets.acquireComposition(descriptor.presetId)
    if (preset.revision !== descriptor.presetRevision) throw new Error('Delegated preset declaration changed; automatic recovery refused')
    const handle = await this.owner.agents.resume({
      resumeSessionId: sessionId, agentOptions: descriptor.options,
      ...(signal === undefined ? {} : { signal }),
      setup: async (ctx, child) => {
        const actual = this.state(child, ownerId).descriptor
        if (JSON.stringify(actual) !== JSON.stringify(descriptor)) throw new Error('Delegated creation record changed during recovery')
        if (child.session.header.origin !== 'subagent') throw new Error('Host execution is not a delegated session')
        await preset.mount(ctx)
        applyDelegatedComposition(ctx, actual.composition)
      },
    })
    this.handles.set(sessionId, handle)
    return handle.agent
  }

  /** Durably deliver once through the real inbox. A duplicate returns its original message identity, even after recovery.
   * @param ownerId - admitted controller identity.
   * @param sessionId - recipient execution.
   * @param requestId - stable outbox delivery identity.
   * @param text - exact model-visible input.
   * @param senderSessionId - actual originating Agent execution.
   * @returns accepted message identity; this does not mean the model completed the task.
   */
  send(
    ownerId: DelegationOwnerId, sessionId: SessionId, requestId: DelegationRequestId, text: string, senderSessionId: SessionId,
  ): Promise<MessageId> {
    return this.run(sessionId, async () => {
      const agent = await this.restore(ownerId, sessionId)
      const digest = delegationMessageDigest(senderSessionId, text)
      const messageId = delegationMessageId(ownerId, requestId)
      const existing = this.state(agent, ownerId).deliveries[messageId]
      if (existing !== undefined) {
        if (existing.digest !== digest) throw new Error('Delegated message request identity conflict')
        await this.flush(agent)
        this.owner.agents.wakePending(agent)
        return existing.messageId
      }
      const message = freezeMessage({ id: messageId, role: 'user' as const, content: [{ type: 'text' as const, text }],
        source: { kind: 'agent-message' as const, form: 'relay' as const, senderSessionId } })
      agent.followup(message)
      await this.flush(agent)
      return message.id
    })
  }

  /** Cancel queued/running work and await quiescence without retiring the reusable execution.
   * @param ownerId - admitted controller identity.
   * @param sessionId - execution whose current work is stopped.
   */
  interrupt(ownerId: DelegationOwnerId, sessionId: SessionId): Promise<void> {
    return this.run(sessionId, async () => {
      const agent = await this.restore(ownerId, sessionId)
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      await this.flush(agent)
    })
  }

  /** Permanently close delivery after quiescence, retain history and release the actual Agent handle.
   * @param ownerId - admitted controller identity.
   * @param sessionId - execution to retire.
   * @returns whether a durable execution existed; false confirms an unused reservation.
   */
  retire(ownerId: DelegationOwnerId, sessionId: SessionId): Promise<boolean> {
    return this.run(sessionId, async () => {
      if (!this.handles.has(sessionId) && await this.owner.sessionPersistence.stat(sessionId) === undefined) return false
      using observation = await this.owner.sessionQuery.observeSession(sessionId)
      if (observation.events.some(event => event.type === 'subagent/host-retired' && event.data.ownerId === ownerId)) {
        const resident = this.handles.get(sessionId)
        if (resident !== undefined) {
          await this.flush(resident.agent)
          await resident.dispose()
          this.handles.delete(sessionId)
        }
        return true
      }
      const agent = await this.restore(ownerId, sessionId)
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      agent.session.append('subagent/host-retired', { ownerId })
      await this.flush(agent)
      const handle = this.handles.get(sessionId)
      if (handle === undefined) throw new Error('Host delegation lost its execution handle')
      await handle.dispose()
      this.handles.delete(sessionId)
      return true
    })
  }
}
