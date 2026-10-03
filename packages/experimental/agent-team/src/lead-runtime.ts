/** Host-owned preparation of ordinary Lead executions; no model tool exposes this capability. */

import type { Context } from '@deepseek-ai/cordis'
import { InputControllerId, type Agent, type AgentHandle, type AgentOptions, type AgentSetup,
  type InputControllerHandle, type AgentInput, type InputReceipt } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { PresetCompositionLease } from '@deepseek-ai/dsh-agent-preset-registry'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { leadExecutionProjection, type TeamLeadExecutionIdentity } from './lead-execution.ts'
import { TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { Config } from './types.ts'
import { TeamId } from './types.ts'
import type { TeamLeadSeat } from './lead-seat.ts'

/** A caller-owned candidate creation request, not a seat change. */
export interface CreateLeadExecutionRequest {
  readonly sessionId: SessionId
  readonly term: number
  readonly presetId: string
  readonly revision: string
  readonly agentOptions: AgentOptions
  readonly setup?: AgentSetup
  readonly signal?: AbortSignal
}

/** Product activation resolves the stable anchor without starting its model. */
export interface LeadExecutionProvider {
  /** @param id - durable Team anchor.
   * @param signal - preparation cancellation; resolver-owned activation must observe it.
   * @returns the exact live anchor after its controlled initialization.
   */
  resolveAnchor(id: SessionId, signal?: AbortSignal): Promise<Agent>
  /** Optional product readiness; absence admits only the initial anchor.
   * @param anchor - stable Team journal owner.
   * @returns whether the committed current execution may run and consume input.
   */
  isReady?(anchor: Agent): boolean
}

/** Composition retained for one cold activation and released by its API caller. */
export interface LeadActivationPreparation extends AsyncDisposable {
  readonly setup: AgentSetup
}

/** Authenticated Host coordinator capability; absent from the model's tool catalog. */
export interface LeadExecutionHandle {
  /** Bind a current-format live anchor before its first coordinated transition.
   * @param anchor - exact controlled Team host.
   * @returns durable initialization; uncertain persistence rejects.
   */
  prepareAnchor(anchor: Agent): Promise<void>
  /** Preserve an execution's pending inputs before moving them through the Team queue.
   * @param agent - controlled anchor or one of its ordinary executions.
   * @returns original input identities and wake intent after source custody is durable.
   */
  capture(agent: Agent): Promise<readonly AgentInput[]>
  /** Write coordinated material without waking its receiving execution.
   * @param agent - controlled anchor or ordinary execution.
   * @param input - original input identity, source and wake intent.
   * @param prepend - whether to place summary material before pending next-step input.
   * @returns the receiving execution's durable custody receipt.
   */
  preload(agent: Agent, input: AgentInput, prepend?: boolean): Promise<InputReceipt>
  /** Settle captured source custody only after the native queue confirms its transfer.
   * @param agent - controlled source execution.
   * @param messageId - exact captured identity.
   */
  release(agent: Agent, messageId: MessageId): Promise<void>
  /** Create an unbound ordinary execution; it cannot run or mutate the Team.
   * @param anchor - exact stable Team host.
   * @param request - identity, expected declaration, and captured execution settings.
   * @returns the owned ordinary Agent lifecycle, after identity is durable.
   */
  create(anchor: Agent, request: CreateLeadExecutionRequest): Promise<AgentHandle>
  /** Prepare a marked cold execution before any target Preset mounts.
   * @param observation - retained immutable Session cut.
   * @returns an exact-revision composition or undefined for an unrelated Session.
   */
  prepareActivation(observation: SessionObservation): Promise<LeadActivationPreparation | undefined>
  /** Remove this provider and close the persistently bound executions. */
  dispose(): Promise<void>
}

const controllerId = InputControllerId('native-team-lead')

/** Stop awaiting an external preparation when its registration or caller closes. */
async function cancellable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined)
    signal.throwIfAborted()
  }
  const cancelled = Promise.withResolvers<never>()
  const abort = () => { const reason: unknown = signal.reason; cancelled.reject(reason) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([pending, cancelled.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Owns optional Lead input policy and pre-publication composition. */
export class TeamLeadExecutions {
  private input: InputControllerHandle | undefined
  private provider: LeadExecutionProvider | undefined
  constructor(private readonly ctx: Context, private readonly journal: TeamJournal,
    private readonly mode: Config['controlledMode']) {}

  /** Install one Host coordinator and its input policy under the caller's lifetime.
   * @param owner - coordinator registration scope.
   * @param provider - stable anchor activation.
   * @returns creation and activation capabilities, never a seat commit capability.
   */
  install(owner: Context, provider: LeadExecutionProvider): LeadExecutionHandle {
    if (this.input !== undefined) throw new TeamError('Lead execution provider is already installed', 'TEAM_LEAD_PROVIDER_CONFLICT')
    let active = true
    const registrationAbort = new AbortController()
    const jobs = new Set<Promise<unknown>>()
    const preparations = new Map<PresetCompositionLease, Promise<void> | undefined>()
    const assertActive = (signal = registrationAbort.signal) => {
      if (!active) throw new TeamError('Lead execution provider has closed', 'TEAM_LEAD_PROVIDER_CLOSED')
      signal.throwIfAborted()
    }
    const own = <T>(operation: (signal: AbortSignal) => Promise<T>, signal = registrationAbort.signal): Promise<T> => {
      const job = Promise.resolve().then(() => { assertActive(signal); return operation(signal) })
      jobs.add(job)
      void job.then(() => { jobs.delete(job) }, () => { jobs.delete(job) })
      return job
    }
    const acquire = async (id: string, signal: AbortSignal): Promise<PresetCompositionLease> => {
      assertActive(signal)
      const pending = this.presets().acquireComposition(id)
      let lease: PresetCompositionLease
      try {
        lease = await cancellable(pending, signal)
      } catch (error: unknown) {
        if (signal.aborted) void pending.then(lease => lease[Symbol.asyncDispose](), () => undefined)
          .catch((failure: unknown) => { owner.logger.warn(`Lead preparation lease cleanup failed: ${String(failure)}`) })
        throw error
      }
      try { assertActive(signal) } catch (error: unknown) { await lease[Symbol.asyncDispose](); throw error }
      return lease
    }
    const releasePreparation = (lease: PresetCompositionLease): Promise<void> => {
      const releasing = preparations.get(lease)
      if (releasing !== undefined) return releasing
      if (!preparations.has(lease)) return Promise.resolve()
      const released = Promise.resolve(lease[Symbol.asyncDispose]())
      preparations.set(lease, released)
      const settled = () => { preparations.delete(lease) }
      void released.then(settled, settled)
      return released
    }
    const prepareSession = (session: Session, signal = registrationAbort.signal) => own(async () => {
      const identity = this.identity(session)
      if (identity === null) return
      await this.anchor(provider, identity, signal)
      assertActive(signal)
      await using lease = await acquire(identity.presetId, signal)
      this.checkRevision(lease.revision, identity.revision)
      assertActive(signal)
    }, signal)
    const input = owner.agents.registerInputController(controllerId, {
      admit: (agent) => {
        const anchor = this.liveAnchor(agent)
        if (this.isCurrent(agent, anchor) && this.isReady(anchor)) return { kind: 'accept' }
        const identity = this.identity(agent.session)
        if (identity === null || identity.term <= this.seat(anchor).term) {
          return { kind: 'hold' }
        }
        return { kind: 'reject', reason: 'Lead execution is not bound and ready' }
      },
      canStart: (agent) => { const anchor = this.liveAnchor(agent); return this.isCurrent(agent, anchor) && this.isReady(anchor) },
      canClaim: (agent) => { const anchor = this.liveAnchor(agent); return this.isCurrent(agent, anchor) && this.isReady(anchor) },
      initialize: (session, source) => {
        const identity = this.identity(session)
        if (identity !== null) { input.bind(session); return }
        if (session.header.origin === 'subagent'
          || session.header.parentSession !== undefined && !session.header.isSeeded) return
        const state = this.ctx.sessionProjections.stateOf(session, 'agentTeam')
        if (state === undefined || state.failure !== undefined) throw new Error('Team projection is unavailable or invalid')
        if (source === 'startup' && state.mode === undefined && this.mode !== undefined) {
          session.append('team/mode', { version: 1, teamId: TeamId(session.id), mode: this.mode })
          input.bind(session)
        } else if (state.mode?.kind === 'controlled') input.bind(session)
      },
      prepare: session => prepareSession(session),
    })
    this.input = input
    this.provider = provider
    const dispose = owner.effect(() => async () => {
      active = false
      registrationAbort.abort(new TeamError('Lead execution provider has closed', 'TEAM_LEAD_PROVIDER_CLOSED'))
      try {
        await input.dispose()
        await Promise.allSettled([...jobs])
        const released = await Promise.allSettled([...preparations.keys()].map(releasePreparation))
        const failures = released.filter(result => result.status === 'rejected').map((result) => {
          const reason: unknown = result.reason
          return reason
        })
        if (failures.length > 0) throw new AggregateError(failures, 'Lead activation lease cleanup failed')
      } finally {
        this.input = undefined
        this.provider = undefined
      }
    }, 'agentTeams.leadExecutions()')
    return {
      prepareAnchor: anchor => own(async () => {
        this.assertAnchor(anchor)
        input.bind(anchor.session)
        if (!await owner.sessions.flush(anchor.session)) throw new Error('Lead anchor binding was not durably confirmed')
        assertActive()
      }),
      capture: agent => own(async () => { this.liveAnchor(agent); return await input.holdPending(agent) }),
      preload: (agent, material, prepend) => own(async () => {
        this.liveAnchor(agent)
        return await input.preload(agent, material, prepend)
      }),
      release: (agent, messageId) => own(async () => { this.liveAnchor(agent); await input.release(agent, messageId) }),
      create: (anchor, request) => own(async (signal) => {
        this.assertAnchor(anchor)
        if (!Number.isSafeInteger(request.term) || request.term < 2) throw new TeamError('Lead term must be a safe integer after term one', 'TEAM_INVALID_ARGUMENT')
        input.bind(anchor.session)
        if (!await owner.sessions.flush(anchor.session)) throw new Error('Lead anchor binding was not durably confirmed')
        assertActive(signal)
        await using lease = await acquire(request.presetId, signal)
        this.checkRevision(lease.revision, request.revision)
        assertActive(signal)
        return await owner.agents.create({
          sessionId: request.sessionId,
          meta: { parentSession: anchor.id, agentPreset: lease.id,
            ...anchor.session.header.cwd === undefined ? {} : { cwd: anchor.session.header.cwd } },
          agentOptions: request.agentOptions,
          signal,
          setup: (agentCtx, agent) => own(async () => {
            assertActive(signal)
            agent.session.append('team/lead/execution', { version: 1, teamId: TeamId(anchor.id),
              term: request.term, presetId: lease.id, revision: request.revision })
            input.bind(agent.session)
            await prepareSession(agent.session, signal)
            assertActive(signal)
            const commit = await cancellable(Promise.resolve(request.setup?.(agentCtx, agent)), signal)
            assertActive(signal)
            await lease.mount(agentCtx)
            assertActive(signal)
            return { commit: () => { assertActive(signal); this.assertAnchor(anchor); commit?.commit() } }
          }, signal),
        })
      }, request.signal === undefined ? registrationAbort.signal : AbortSignal.any([registrationAbort.signal, request.signal])),
      prepareActivation: observation => own(async (signal) => {
        let record = leadExecutionProjection.init(observation.header, observation.inheritedEventCount)
        for (const event of observation.events) record = leadExecutionProjection.apply(record, event)
        if (record.failure !== undefined) throw new TeamError(record.failure, 'TEAM_LEAD_IDENTITY_INVALID')
        const identity = record.identity
        if (identity === null) return undefined
        const anchor = await this.anchor(provider, identity, signal)
        assertActive(signal)
        const lease = await acquire(identity.presetId, signal)
        try {
          this.checkRevision(lease.revision, identity.revision)
          assertActive(signal)
        } catch (error: unknown) {
          await lease[Symbol.asyncDispose]()
          throw error
        }
        preparations.set(lease, undefined)
        return {
          setup: (agentCtx, agent) => own(async (setupSignal) => {
            assertActive(setupSignal)
            const actual = this.identity(agent.session)
            if (actual === null || actual.teamId !== identity.teamId || actual.term !== identity.term
              || actual.presetId !== identity.presetId || actual.revision !== identity.revision) {
              throw new TeamError('Lead execution identity changed during activation', 'TEAM_LEAD_IDENTITY_INVALID')
            }
            input.bind(agent.session)
            try {
              await cancellable(lease.mount(agentCtx), setupSignal)
              assertActive(setupSignal)
            } catch (error: unknown) {
              if (setupSignal.aborted) await agentCtx.fiber.dispose()
              throw error
            }
            return { commit: () => { assertActive(setupSignal); this.assertAnchor(anchor) } }
          }),
          [Symbol.asyncDispose]: () => releasePreparation(lease),
        }
      }),
      dispose: async () => { await dispose() },
    }
  }

  /** Read the stable seat without interpreting the product's transition records.
   * @param anchor - exact live journal owner.
   * @returns initial term one or the last native binding.
   */
  seat(anchor: Agent): TeamLeadSeat {
    return this.journal.state(anchor).lead ?? { executionId: anchor.id, term: 1,
      ...anchor.session.header.agentPreset === undefined ? {} : { presetId: anchor.session.header.agentPreset } }
  }

  /** Test exact execution identity against the native seat.
   * @param agent - candidate live execution.
   * @param anchor - stable Team journal owner.
   * @returns whether the id, term and composition match the current binding.
   */
  isCurrent(agent: Agent, anchor: Agent): boolean {
    const seat = this.seat(anchor)
    if (agent.id !== seat.executionId) return false
    const identity = this.identity(agent.session)
    return identity === null ? agent === anchor && seat.term === 1
      : identity.teamId === TeamId(anchor.id) && identity.term === seat.term
        && identity.presetId === seat.presetId && identity.revision === seat.revision
  }

  /** Read the optional coordinator's current readiness without granting a missing provider authority.
   * @param anchor - stable Team journal owner.
   * @returns initial execution readiness or the installed provider's decision.
   */
  isReady(anchor: Agent): boolean {
    if (this.provider === undefined && this.ctx.agents.inputControlState(anchor.session).controllerId === controllerId) return false
    return this.provider?.isReady?.(anchor) ?? this.seat(anchor).term === 1
  }

  private liveAnchor(agent: Agent): Agent {
    const identity = this.identity(agent.session)
    if (identity === null) { this.assertAnchor(agent); return agent }
    const anchor = this.ctx.agents.get(SessionId(identity.teamId))
    if (anchor === undefined) throw new TeamError('Lead anchor must be loaded before execution', 'TEAM_LEAD_ANCHOR_INVALID')
    this.assertAnchor(anchor)
    return anchor
  }

  private identity(session: Session): TeamLeadExecutionIdentity | null {
    const record = this.ctx.sessionProjections.stateOf(session, 'teamLeadExecutionRecord')
    if (record === undefined) throw new Error('Lead identity projection is not registered')
    if (record.failure !== undefined) throw new TeamError(record.failure, 'TEAM_LEAD_IDENTITY_INVALID')
    return record.identity
  }

  private presets() {
    const registry = this.ctx.get('agentPresets')
    if (registry === undefined) throw new TeamError('Lead execution requires an Agent Preset registry', 'TEAM_PRESET_UNAVAILABLE')
    return registry
  }

  private checkRevision(actual: string | undefined, expected: string): void {
    if (actual !== expected) throw new TeamError('Lead Preset declaration differs from its recorded revision; restore that definition', 'TEAM_PRESET_REVISION_MISMATCH')
  }

  private assertAnchor(anchor: Agent): void {
    if (this.ctx.agents.get(anchor.id) !== anchor || this.identity(anchor.session) !== null
      || this.journal.state(anchor).mode?.kind !== 'controlled') {
      throw new TeamError('Lead execution requires its exact live controlled Team anchor', 'TEAM_LEAD_ANCHOR_INVALID')
    }
  }

  private async anchor(provider: LeadExecutionProvider, identity: TeamLeadExecutionIdentity, signal: AbortSignal): Promise<Agent> {
    const anchorId = SessionId(identity.teamId)
    const anchor = await cancellable(provider.resolveAnchor(anchorId, signal), signal)
    signal.throwIfAborted()
    if (anchor.id !== anchorId) throw new TeamError('Lead anchor resolver returned another Session', 'TEAM_LEAD_ANCHOR_INVALID')
    this.assertAnchor(anchor)
    return anchor
  }
}
