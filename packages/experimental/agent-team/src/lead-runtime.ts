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
import type { Config, TeamLeadContext, TeamLeadDeliveryReceipt, TeamMessageId } from './types.ts'
import { TeamId } from './types.ts'
import type { TeamLeadBinding, TeamLeadSeat } from './lead-seat.ts'
import { leadCoordinationActive, leadCoordinationFrozen } from './lead-coordination.ts'
import { maintainExecution, prepareControlledClaim, resumeConfirmedStarts, wakeAdmittedInput } from './execution-maintenance.ts'
import type { TeamExecutionMaintenanceRequest, TeamExecutionMaintenanceScope } from './execution-maintenance-types.ts'

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
  /** Optional controlled cold activation; absence retains queued mail rather than choosing a default composition.
   * @param id - exact recorded current or historical execution identity.
   * @param signal - registration and mailbox cancellation.
   * @returns the exact live prepared execution without driving its model.
   */
  resolveExecution?(id: SessionId, signal?: AbortSignal): Promise<Agent>
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
  /** Persist source-held input without changing its original message id, source, queue or wake intent.
   * @param source - exact current or historical Lead execution owning held input.
   * @returns capture-specific native queue identities after the source and anchor flush succeed.
   */
  queueHeld(source: Agent): Promise<readonly TeamMessageId[]>
  /** Preload the committed recipient through the ordinary target-local mailbox sequence without waking.
   * @param anchor - exact stable controlled Team host.
   * @param expectedSeat - execution and term that must still be current.
   * @returns sole native receipts after target and anchor durability succeed.
   */
  preloadLeadMail(anchor: Agent, expectedSeat: Pick<TeamLeadSeat, 'executionId' | 'term'>): Promise<readonly TeamLeadDeliveryReceipt[]>
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

/** Native mailbox operations carried only by the input controller's owning capability. */
export interface LeadMailRuntime {
  bind(input: InputControllerHandle | undefined): void
  queueHeld(source: Agent, input: InputControllerHandle, signal: AbortSignal): Promise<readonly TeamMessageId[]>
  preloadLeadMail(anchor: Agent, expectedSeat: Pick<TeamLeadSeat, 'executionId' | 'term'>,
    input: InputControllerHandle, signal: AbortSignal): Promise<readonly TeamLeadDeliveryReceipt[]>
}

/** Stop awaiting external preparation or a queued read when its registration or caller closes.
 * @param pending - operation whose own late completion must remain contained.
 * @param signal - authoritative cancellation, preserving its original reason.
 * @returns the operation result only while that ownership is still open.
 */
export async function cancellable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
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
  private executionResolver: ((id: SessionId, signal: AbortSignal) => Promise<Agent>) | undefined
  private lifetime: AbortSignal | undefined
  private readonly occupations = new Set<SessionId>()
  private readonly maintenanceJobs = new Set<Promise<unknown>>()
  constructor(private readonly ctx: Context, private readonly journal: TeamJournal,
    private readonly mode: Config['controlledMode'],
    private readonly workAdmitted: (anchor: Agent, input: AgentInput) => boolean,
    private readonly hasWorkPolicy: () => boolean,
    private readonly workPolicyAvailable: (anchor: Agent) => boolean) {}

  /** Occupy the existing Lead controller for exact, short execution maintenance.
   * @param caller - actual current Lead authorizing the operation.
   * @param request - exact seat/turn identity and synchronous caller-owned recheck.
   * @param signal - caller lifetime; admitted callback work is drained on cancellation.
   * @param callback - live maintenance or exclusive original stored input custody.
   * @returns only after obsolete-work disposition and original-input handback settle.
   */
  async maintain<T>(caller: Agent, request: TeamExecutionMaintenanceRequest, signal: AbortSignal,
    callback: (scope: TeamExecutionMaintenanceScope) => Promise<T>): Promise<T> {
    const input = this.input, lifetime = this.lifetime, target = request.target
    if (input === undefined || lifetime === undefined || target.kind !== 'lead') throw new TeamError('Lead input owner is unavailable', 'TEAM_LEAD_PROVIDER_CLOSED')
    const anchor = this.liveAnchor(caller)
    const identity = () => {
      const state = this.journal.state(anchor), seat = this.seat(anchor)
      return seat.executionId === target.executionId && seat.term === target.term
        && !leadCoordinationActive(state.leadCoordination) && state.composition?.phase !== 'applying' && this.isReady(anchor) && this.workPolicyAvailable(anchor)
    }
    const unavailable = (): never => { throw new TeamError('Lead seat changed before maintenance', 'TEAM_LEAD_STALE_TERM') }
    const assertCurrent = () => {
      lifetime.throwIfAborted()
      this.journal.assertCallerWrite(anchor, caller)
      if (!this.isCurrent(caller, anchor) || !identity()) unavailable()
    }
    const job = (async () => {
      await this.journal.transact(anchor.id, () => {
        assertCurrent(); signal.throwIfAborted(); request.assertCurrent?.()
        if (this.occupations.has(target.executionId)) throw new TeamError('Lead maintenance is already occupied', 'TEAM_LEAD_NOT_READY')
        this.occupations.add(target.executionId)
        return Promise.resolve()
      })
      let completed = false
      try {
        const result = await maintainExecution(this.ctx, request, AbortSignal.any([signal, lifetime]), { input, lifetime, assertCurrent,
          transact: action => this.journal.transact(anchor.id, action),
          canHandback: identity, admitted: material => this.workAdmitted(anchor, material),
          // Lead authority requires this exact live caller; a bare stored reader cannot replace it.
          withStored: unavailable,
        }, callback)
        completed = true
        return result
      } finally {
        this.occupations.delete(target.executionId)
        const execution = this.ctx.agents.get(target.executionId)
        if (completed && !lifetime.aborted && identity() && execution !== undefined) {
          wakeAdmittedInput(this.ctx, execution, material => this.workAdmitted(anchor, material))
        }
      }
    })()
    this.maintenanceJobs.add(job)
    try { return await job } finally { this.maintenanceJobs.delete(job) }
  }

  /** Native dispatch cannot bypass the same short input-controller occupation.
   * @param anchor - exact stable native Team journal owner.
   * @returns whether the current Lead may receive work under its existing controller.
   */
  canReceive(anchor: Agent): boolean {
    return this.isReady(anchor) && !this.occupations.has(this.seat(anchor).executionId) && this.workPolicyAvailable(anchor)
  }

  /** Drain scoped maintenance after native Team admission closes. */
  async settleMaintenance(): Promise<void> { await Promise.allSettled([...this.maintenanceJobs]) }

  /** Install one Host coordinator and its input policy under the caller's lifetime.
   * @param owner - coordinator registration scope.
   * @param provider - stable anchor activation.
   * @param mail - existing mailbox's private native input and non-waking preload operations.
   * @returns creation and activation capabilities, never a seat commit capability.
   */
  install(owner: Context, provider: LeadExecutionProvider, mail: LeadMailRuntime): LeadExecutionHandle {
    if (this.input !== undefined) throw new TeamError('Lead execution provider is already installed', 'TEAM_LEAD_PROVIDER_CONFLICT')
    let active = true
    const registrationAbort = new AbortController()
    const jobs = new Set<Promise<unknown>>()
    const preparations = new Map<PresetCompositionLease, Promise<void> | undefined>()
    const resolutions = new Map<SessionId, Promise<Agent>>()
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
    // Current Lead executions refused a start or claim while a Team write was being confirmed; that confirmation resumes them.
    const refused = new Set<Agent>()
    // Claim preparation passed its checks on a confirmed Team cut; a write appended after them does not refuse that claim.
    const prepared = new WeakSet<Agent>()
    const awaitsConfirmation = (agent: Agent, anchor: Agent): boolean =>
      this.isReady(anchor) && !this.occupations.has(agent.id) && !this.journal.recordsConfirmed(anchor)
    const runnable = (agent: Agent) => {
      const anchor = this.liveAnchor(agent)
      if (!this.isCurrent(agent, anchor)) return
      if (this.canReceive(anchor)) return (material: AgentInput) => this.workAdmitted(anchor, material)
      if (awaitsConfirmation(agent, anchor)) refused.add(agent)
    }
    const gate = (agent: Agent): boolean => runnable(agent) !== undefined
    const input = owner.agents.registerInputController(controllerId, {
      admit: (agent, material) => {
        const anchor = this.liveAnchor(agent)
        const current = this.isCurrent(agent, anchor)
        if (!this.workAdmitted(anchor, material)) return { kind: 'reject', reason: 'Task work input is no longer schedulable' }
        const kind: string = material.message.source.kind
        if (!current && kind === 'user-question-reply') return { kind: 'reject', reason: 'question reply belongs to a superseded execution' }
        if (current && this.canReceive(anchor)) return { kind: 'accept' }
        const identity = this.identity(agent.session)
        if (identity === null || identity.term <= this.seat(anchor).term) {
          return { kind: 'hold' }
        }
        return { kind: 'reject', reason: 'Lead execution is not bound and ready' }
      },
      canStart: gate,
      canClaim: (agent) => {
        const anchor = this.liveAnchor(agent)
        return prepared.has(agent) && this.isCurrent(agent, anchor) && awaitsConfirmation(agent, anchor) || gate(agent)
      },
      prepareClaim: async (agent, signal) => {
        prepared.delete(agent)
        const anchor = this.liveAnchor(agent)
        if (this.isCurrent(agent, anchor) && this.canReceive(anchor) && this.hasWorkPolicy()) {
          await prepareControlledClaim(this.ctx, input, agent, material => this.workAdmitted(anchor, material), signal, () => {
            if (!this.isCurrent(agent, anchor) || !this.canReceive(anchor)) throw new TeamError('Lead changed before input claim', 'TEAM_LEAD_STALE_TERM')
          }, action => this.journal.transactConfirmed(anchor, action))
          prepared.add(agent)
        }
      },
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
    this.lifetime = registrationAbort.signal
    this.provider = provider
    const resolveExecution = provider.resolveExecution?.bind(provider)
    this.executionResolver = resolveExecution === undefined ? undefined : (id, incoming) => {
      const signal = AbortSignal.any([registrationAbort.signal, incoming])
      const existing = resolutions.get(id)
      if (existing !== undefined) return cancellable(existing, signal)
      const pending = own(async () => {
        const execution = await cancellable(Promise.resolve().then(() => resolveExecution(id, signal)), signal)
        assertActive(signal)
        return execution
      }, signal)
      resolutions.set(id, pending)
      const settled = () => { resolutions.delete(id) }
      void pending.then(settled, settled)
      return pending
    }
    mail.bind(input)
    const dispose = owner.effect(() => async () => {
      active = false
      refused.clear()
      registrationAbort.abort(new TeamError('Lead execution provider has closed', 'TEAM_LEAD_PROVIDER_CLOSED'))
      try {
        await input.dispose()
        await Promise.allSettled([...jobs])
        await Promise.allSettled([...this.maintenanceJobs])
        mail.bind(undefined)
        const released = await Promise.allSettled([...preparations.keys()].map(releasePreparation))
        const failures = released.filter(result => result.status === 'rejected').map((result) => {
          const reason: unknown = result.reason
          return reason
        })
        if (failures.length > 0) throw new AggregateError(failures, 'Lead activation lease cleanup failed')
      } finally {
        this.input = undefined
        this.lifetime = undefined
        this.provider = undefined
        this.executionResolver = undefined
      }
    }, 'agentTeams.leadExecutions()')
    const handle: LeadExecutionHandle = {
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
      queueHeld: source => own(async (signal) => {
        const context = this.context(this.liveAnchor(source))
        const identity = this.identity(source.session)
        const term = identity?.term ?? 1
        if (owner.agents.get(source.id) !== source || !this.isAuthor(context.anchor, source.id, term)) {
          throw new TeamError('input source has no legitimate Lead execution identity', 'TEAM_NOT_MEMBER')
        }
        return await cancellable(mail.queueHeld(source, input, signal), signal)
      }),
      preloadLeadMail: (anchor, expectedSeat) => own(async (signal) => {
        this.assertAnchor(anchor)
        return await cancellable(mail.preloadLeadMail(anchor, expectedSeat, input, signal), signal)
      }),
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
    const forward = (agent: Agent): void => {
      if (!active) return
      const state = owner.agents.inputControlState(agent.session)
      if (state.controllerId !== controllerId || !state.records.some(record => record.location === 'held')) return
      const anchor = this.liveAnchor(agent)
      if (this.occupations.has(agent.id) || this.isCurrent(agent, anchor) && !this.canReceive(anchor)) return
      void handle.queueHeld(agent).catch((error: unknown) => {
        if (active) owner.logger.warn(`Lead held input remains with its source: ${String(error)}`)
      })
    }
    owner.on('session/event', (session, event) => {
      if (event.type === 'team/lead/transaction' || event.type === 'team/extension') {
        for (const agent of owner.agents.list()) forward(agent)
        return
      }
      if (event.type !== 'agent/input/held' || event.data.captured === true || event.data.controllerId !== controllerId) return
      const source = owner.agents.get(session.id)
      if (source !== undefined) forward(source)
    })
    owner.on('agent/created', ({ agent }) => { forward(agent) })
    owner.on('agent-team/confirmed', () => {
      for (const agent of owner.agents.list()) forward(agent)
      resumeConfirmedStarts(this.ctx, refused, runnable)
    })
    for (const agent of owner.agents.list()) forward(agent)
    return handle
  }

  /** Read the stable seat without interpreting the product's transition records.
   * @param anchor - exact live journal owner.
   * @returns initial term one or the last native binding.
   */
  seat(anchor: Agent): TeamLeadSeat {
    return this.journal.state(anchor).lead ?? { executionId: anchor.id, term: 1,
      ...anchor.session.header.agentPreset === undefined ? {} : { presetId: anchor.session.header.agentPreset } }
  }

  /** Read the current binding and exact live execution independently of readiness.
   * @param anchor - exact live stable Team owner.
   * @returns detached seat data and the matching live recipient, if loaded.
   */
  context(anchor: Agent): TeamLeadContext {
    const seat = this.seat(anchor)
    const candidate = this.ctx.agents.get(seat.executionId)
    const execution = candidate !== undefined && this.isCurrent(candidate, anchor) ? candidate : undefined
    return { anchor, seat: { ...seat }, ...execution === undefined ? {} : { execution },
      ready: execution !== undefined && this.isReady(anchor) }
  }

  /** Restore only the committed recipient through its registered Host owner.
   * @param anchor - exact stable Team host.
   * @param signal - mailbox lifecycle cancellation.
   * @returns the matching live context after a seat and identity recheck.
   */
  async resolveCurrent(anchor: Agent, signal: AbortSignal): Promise<TeamLeadContext> {
    signal.throwIfAborted()
    const before = this.context(anchor)
    if (before.execution !== undefined) return before
    const resolve = this.executionResolver
    if (resolve === undefined) throw new TeamError('current Lead execution is unloaded and has no activation provider', 'TEAM_LEAD_ANCHOR_INVALID')
    const execution = await resolve(before.seat.executionId, signal)
    signal.throwIfAborted()
    const seat = this.seat(anchor)
    if (seat.executionId !== before.seat.executionId || seat.term !== before.seat.term) {
      throw new TeamError('Lead seat changed during recipient activation', 'TEAM_LEAD_STALE_TERM')
    }
    if (execution.id !== seat.executionId || this.ctx.agents.get(execution.id) !== execution || !this.isCurrent(execution, anchor)) {
      throw new TeamError('Lead activation returned another execution or identity', 'TEAM_LEAD_IDENTITY_INVALID')
    }
    return this.context(anchor)
  }

  /** Restore a legitimate historical source only for receipt-scoped custody cleanup.
   * @param anchor - exact stable controlled host.
   * @param id - source recorded by the native transfer.
   * @param signal - mailbox lifecycle cancellation.
   * @returns the exact quiet historical execution.
   */
  async resolveSource(anchor: Agent, id: SessionId, signal: AbortSignal): Promise<Agent> {
    signal.throwIfAborted()
    const live = this.ctx.agents.get(id)
    let source: Agent
    if (live !== undefined) source = live
    else {
      const resolve = this.executionResolver
      if (resolve === undefined) throw new TeamError('held input source is unloaded and has no cleanup activation provider', 'TEAM_LEAD_ANCHOR_INVALID')
      source = await resolve(id, signal)
    }
    signal.throwIfAborted()
    const marker = this.identity(source.session)
    const binding = this.journal.state(anchor).leadHistory?.find(item => item.executionId === id)
    if (source.id !== id || this.ctx.agents.get(id) !== source || marker === null
      || marker.teamId !== TeamId(anchor.id) || binding === undefined || binding.term !== marker.term
      || binding.presetId !== marker.presetId || binding.revision !== marker.revision
      || this.isCurrent(source, anchor)) {
      throw new TeamError('cleanup source is not a quiet historical Lead execution', 'TEAM_LEAD_IDENTITY_INVALID')
    }
    return source
  }

  /** Resolve a marked execution's anchor for read-only consumers, without granting a Team role.
   * @param agent - exact live marked execution.
   * @returns its validated stable controlled anchor.
   */
  anchorForRead(agent: Agent): Agent {
    if (this.ctx.agents.get(agent.id) !== agent) throw new TeamError('Agent is no longer live', 'TEAM_NOT_MEMBER')
    return this.liveAnchor(agent)
  }

  /** Validate a server-recorded current or historical Lead author.
   * @param anchor - stable Team journal owner.
   * @param executionId - recorded content author.
   * @param term - recorded term; omission infers only the anchor's implicit initial seat.
   * @returns whether that exact execution and term legitimately held this Team's seat.
   */
  isAuthor(anchor: Agent, executionId: SessionId, term?: number): boolean {
    if (executionId === anchor.id) return term === undefined || term === 1
    return term !== undefined && (this.journal.state(anchor).leadHistory ?? [])
      .some(binding => binding.executionId === executionId && binding.term === term)
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

  /** Validate an unbound candidate against its own recorded immutable identity.
   * @param agent - exact candidate already loaded by its creation owner.
   * @param anchor - stable Team journal owner.
   * @param binding - proposed native seat binding.
   * @returns whether the execution marker exactly matches this proposal.
   */
  matchesBinding(agent: Agent, anchor: Agent, binding: TeamLeadBinding): boolean {
    const identity = this.identity(agent.session)
    return identity !== null && agent.session.header.parentSession === anchor.id
      && identity.teamId === TeamId(anchor.id) && agent.id === binding.executionId
      && identity.term === binding.term && identity.presetId === binding.presetId && identity.revision === binding.revision
  }

  /** Read the optional coordinator's current readiness without granting a missing provider authority.
   * @param anchor - stable Team journal owner.
   * @returns initial execution readiness or the installed provider's decision.
   */
  isReady(anchor: Agent): boolean {
    if (!this.journal.coordinationConfirmed(anchor)) return false
    if (leadCoordinationFrozen(this.journal.state(anchor).leadCoordination)) return false
    if (this.provider === undefined && this.isInputBound(anchor)) return false
    return this.provider?.isReady?.(anchor) ?? this.seat(anchor).term === 1
  }

  /** Keep incumbent read authority while a native transition freezes its model writes.
   * @param anchor - exact stable journal owner.
   * @returns whether the current seat may expose collaboration reads.
   */
  hasSeatAuthority(anchor: Agent): boolean {
    const coordination = this.journal.state(anchor).leadCoordination
    return leadCoordinationActive(coordination) && coordination?.previousTerm === this.seat(anchor).term
      || this.isReady(anchor)
  }

  /** Recognize durable native ownership even while its provider is temporarily unloaded.
   * @param anchor - stable Team host whose own input-control binding is read.
   * @returns whether the native Lead controller owns this Session, not another optional controller.
   */
  isInputBound(anchor: Agent): boolean {
    return this.ctx.agents.inputControlState(anchor.session).controllerId === controllerId
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
