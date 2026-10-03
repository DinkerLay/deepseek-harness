/** Agent Teams service façade over roster, mailbox, task, and runtime lifecycle owners. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { TeamActivity } from './activity.ts'
import { applyCompositionTransition, compositionOf } from './composition.ts'
import { errorMessage, TeamError } from './error.ts'
import { TeamJournal } from './journal.ts'
import { leadExecutionProjection } from './lead-execution.ts'
import { TeamLeadExecutions } from './lead-runtime.ts'
import type { LeadExecutionProvider, LeadExecutionHandle } from './lead-runtime.ts'
import { TeamLeadCoordinators } from './lead-coordinator.ts'
import type { TeamLeadCoordinator, TeamLeadCoordinatorHandle } from './lead-coordinator.ts'
import { leadCoordinationActive } from './lead-coordination.ts'
import { TeamRuntimeLifecycle } from './lifecycle.ts'
import { TeamMailbox } from './mailbox.ts'
import { teamProjectionDefinition } from './projection.ts'
import { TeamRoster } from './roster.ts'
import type { TeamMembership } from './roster.ts'
import { TeamTaskBoard } from './task-board.ts'
import type { TeamTaskExtension, TeamTaskExtensionHandle } from './task-extension.ts'
import { TeamId, TeamTaskId } from './types.ts'
import type {
  Config,
  TeamCompositionSnapshot,
  TeamCompositionState,
  TeamCompositionTransition,
  TeamControlledMode,
  CreateTeamTaskRequest,
  SendTeamMessageRequest,
  SendTeamMessageResult,
  SpawnTeammateRequest,
  SpawnTeammateResult,
  TeamMemberView,
  TeamMessageId,
  TeamTaskView,
  TeamWaitResult,
  UpdateTeamTaskRequest,
} from './types.ts'

export type * from './types.ts'
export type { TeamMembership } from './roster.ts'
export type { TeamLeadExecutionIdentity } from './lead-execution.ts'
export type { TeamLeadBinding, TeamLeadSeat, TeamLeadCommitPlan } from './lead-seat.ts'
export type { TeamLeadCoordination, TeamLeadTransition, TeamLeadCoordinationPhase } from './lead-coordination.ts'
export type { TeamLeadCoordinator, TeamLeadCoordinatorHandle, TeamLeadCoordinatorRecord, TeamLeadCoordinatorCommit,
  TeamLeadBlocker, TeamLeadSafePointHandle, TeamLeadCoordinatorOperation, TeamLeadCoordinatorSnapshot,
  TeamLeadCoordinatorRecordBuilder, TeamLeadCoordinatorMaterial } from './lead-coordinator.ts'
export type { CreateLeadExecutionRequest, LeadExecutionProvider, LeadExecutionHandle, LeadActivationPreparation } from './lead-runtime.ts'
export type { TeamExtensionRecordBuilder, TeamTaskExtension, TeamTaskExtensionHandle, TeamTaskTransactionBuilder } from './task-extension.ts'
export { TeamId, TeamMessageId, TeamTaskId, TeamLeadOperationId } from './types.ts'
export { TeamError } from './error.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeams: TeamService
  }
  interface Events {
    /** A coordinated native Team checkpoint was durably confirmed; observers refresh runtime admission.
     * @mode parallel
     * @param anchor - exact stable Team journal owner after successful confirmation.
     */
    'agent-team/confirmed'(anchor: Agent): void
  }
}

const DEFAULT_MAX_MEMBERS = 16
const DEFAULT_MAX_TASKS = 256
const DEFAULT_MAX_PENDING_MESSAGES = 64
const DEFAULT_MAX_MESSAGE_BYTES = 65_536
const DEFAULT_MAX_TASK_EXTENSION_BYTES = 262_144
const DEFAULT_DISPOSAL_TIMEOUT_MS = 5_000

/** Validate one positive safe-integer deployment limit. */
function positiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TeamError(`${name} must be a positive safe integer`, 'TEAM_INVALID_CONFIG')
  }
  return value
}

/** Agent Teams service backed by the exact live Lead Session log. */
export class TeamService extends Service {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents']

  static Config: z<Config> = z.object({
    controlledMode: z.union([z.object({
      kind: z.const('controlled'),
      requiredTaskExtensionId: z.string().required(),
      permissionTableId: z.string().required(),
      permissionRevision: z.string().required(),
      maxOrdinaryMessageBytes: z.number().step(1).min(1).required(),
    }), z.const(undefined)]),
    defaultMemberPresetId: z.string(),
    messageRetryDelayMs: z.number().step(1).min(1).default(500),
    maxMessageRetries: z.number().step(1).min(1).default(5),
    maxMembers: z.number().step(1).min(1).default(DEFAULT_MAX_MEMBERS),
    maxActiveMembers: z.number().step(1).min(1).default(DEFAULT_MAX_MEMBERS),
    maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
    maxPendingMessagesPerMember: z.number().step(1).min(1).default(DEFAULT_MAX_PENDING_MESSAGES),
    maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
    maxTaskExtensionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_TASK_EXTENSION_BYTES),
    disposalTimeoutMs: z.number().step(1).min(1).default(DEFAULT_DISPOSAL_TIMEOUT_MS),
  })

  /** Validated deployment limits used by every Team operation. */
  private readonly config: Required<Omit<Config, 'controlledMode' | 'defaultMemberPresetId'>>
    & Pick<Config, 'controlledMode' | 'defaultMemberPresetId'>

  private readonly activity: TeamActivity
  private readonly lifecycle: TeamRuntimeLifecycle
  private readonly journal: TeamJournal
  private readonly roster: TeamRoster
  private readonly mailbox: TeamMailbox
  private readonly tasks: TeamTaskBoard
  private readonly leadExecutions: TeamLeadExecutions
  private readonly leadCoordinators: TeamLeadCoordinators

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentTeams')
    this.config = {
      ...config.defaultMemberPresetId === undefined ? {} : { defaultMemberPresetId: config.defaultMemberPresetId },
      ...config.controlledMode === undefined ? {} : { controlledMode: {
        kind: config.controlledMode.kind,
        requiredTaskExtensionId: config.controlledMode.requiredTaskExtensionId,
        permissionTableId: config.controlledMode.permissionTableId,
        permissionRevision: config.controlledMode.permissionRevision,
        maxOrdinaryMessageBytes: positiveLimit('controlledMode.maxOrdinaryMessageBytes',
          config.controlledMode.maxOrdinaryMessageBytes),
      } },
      maxMembers: positiveLimit('maxMembers', config.maxMembers ?? DEFAULT_MAX_MEMBERS),
      messageRetryDelayMs: positiveLimit('messageRetryDelayMs', config.messageRetryDelayMs ?? 500),
      maxMessageRetries: positiveLimit('maxMessageRetries', config.maxMessageRetries ?? 5),
      maxActiveMembers: positiveLimit('maxActiveMembers', config.maxActiveMembers ?? DEFAULT_MAX_MEMBERS),
      maxTasks: positiveLimit('maxTasks', config.maxTasks ?? DEFAULT_MAX_TASKS),
      maxPendingMessagesPerMember: positiveLimit(
        'maxPendingMessagesPerMember',
        config.maxPendingMessagesPerMember ?? DEFAULT_MAX_PENDING_MESSAGES,
      ),
      maxMessageBytes: positiveLimit('maxMessageBytes', config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES),
      maxTaskExtensionBytes: positiveLimit(
        'maxTaskExtensionBytes', config.maxTaskExtensionBytes ?? DEFAULT_MAX_TASK_EXTENSION_BYTES,
      ),
      disposalTimeoutMs: positiveLimit(
        'disposalTimeoutMs',
        config.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS,
      ),
    }

    this.activity = new TeamActivity()
    this.lifecycle = new TeamRuntimeLifecycle(this.config.disposalTimeoutMs)
    this.journal = new TeamJournal(ctx, (root) => { this.activity.notify(TeamId(root.id)) },
      this.config.controlledMode !== undefined)
    this.leadExecutions = new TeamLeadExecutions(ctx, this.journal, this.config.controlledMode)
    this.roster = new TeamRoster(
      ctx, this.journal, this.lifecycle, this.config.maxMembers, this.config.maxActiveMembers,
      (caller, group) => { this.tasks.validateMemberGroup(caller, group) },
      this.config.defaultMemberPresetId,
      anchor => this.leadExecutions.hasSeatAuthority(anchor),
    )
    this.mailbox = new TeamMailbox(
      ctx,
      this.journal,
      this.roster,
      this.lifecycle,
      this.config.maxPendingMessagesPerMember,
      this.config.maxMessageBytes,
      this.config.messageRetryDelayMs,
      this.config.maxMessageRetries,
      agent => this.leadContext(agent),
      (anchor, signal) => this.leadExecutions.resolveCurrent(anchor, signal),
      (anchor, id, signal) => this.leadExecutions.resolveSource(anchor, id, signal),
      anchor => this.leadExecutions.isReady(anchor),
      anchor => this.leadExecutions.isInputBound(anchor),
    )
    this.tasks = new TeamTaskBoard(
      this.journal, this.config.maxTasks, this.config.maxTaskExtensionBytes,
      this.config.maxPendingMessagesPerMember, this.config.maxMessageBytes,
      agent => this.roster.membership(agent),
      () => this.lifecycle.disposed,
      (root) => {
        void this.mailbox.recoverFor(root, this.lifecycle.signal).catch((error: unknown) => {
          if (!this.lifecycle.disposed) this.ctx.logger.warn(`Team Task notice dispatch failed: ${errorMessage(error)}`)
        })
      },
      agent => this.leadContext(agent).anchor,
    )
    this.leadCoordinators = new TeamLeadCoordinators(ctx, this.journal, this.leadExecutions, this.tasks, this.config)

    ctx.effect(() => ctx.subagents.registerSettlementNoticePolicy(async (facts) => {
      const root = ctx.agents.get(facts.parentSessionId)
      if (root === undefined) return undefined
      const state = this.journal.state(root)
      const member = state.mode?.kind === 'controlled'
        ? state.members.find(candidate => candidate.id === facts.childSessionId) : undefined
      if (member === undefined) return undefined
      const taskIds = await this.tasks.unsubmittedTaskIds(root, facts)
      const notice = { action: 'send' as const, subject: `Teammate ${member.name}`,
        ...taskIds === undefined || taskIds.length === 0 ? {} : {
          detail: `Unsubmitted Tasks: ${taskIds.join(', ')}.`,
        } }
      if (facts.stopReason !== 'completed' || member.phase !== 'provisioning'
        && member.phase !== 'active' || taskIds !== undefined && taskIds.length > 0) return notice
      return await this.tasks.assessSettlementNotice(root, facts) === 'suppress' ? 'suppress' : notice
    }, (facts) => {
      const root = ctx.agents.get(facts.parentSessionId)
      if (root === undefined) return undefined
      const state = this.journal.state(root)
      const member = state.mode?.kind === 'controlled'
        ? state.members.find(candidate => candidate.id === facts.childSessionId) : undefined
      if (member === undefined) return undefined
      return { action: 'send', subject: `Teammate ${member.name}` }
    }), 'agentTeams.settlementNoticePolicy()')

    ctx.on('session/event', (session, event) => {
      this.mailbox.observeSessionEvent(session, event)
      if (event.type === 'team/lead/transaction' || event.type === 'team/extension' && ctx.agents.isInputControlled(session)) {
        const anchor = ctx.agents.get(session.id)
        if (anchor !== undefined) this.scheduleRecovery(anchor)
      }
    })
    ctx.on('agent/created', async ({ agent, source }) => {
      await this.initializeControlledMode(agent, source)
      this.scheduleRecovery(agent)
    })
    ctx.on('agent-team/confirmed', (anchor) => { this.scheduleRecovery(anchor) })
    ctx.on('agent/status', ({ agent }) => {
      const membership = this.roster.tryMembership(agent)
      if (membership !== undefined) this.activity.notify(membership.id)
    })
    ctx.effect(() => {
      const disposeProjection = ctx.root.sessionProjections.register(teamProjectionDefinition)
      const disposeLeadIdentity = ctx.root.sessionProjections.register(leadExecutionProjection)
      return async () => {
        try {
          await this.disposeRuntime()
        } finally {
          disposeLeadIdentity()
          disposeProjection()
        }
      }
    }, 'agentTeams.runtimeLifecycle()')
    for (const agent of ctx.agents.list()) this.scheduleRecovery(agent)
  }

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its root, Team identity, role, and model-facing name.
   */
  membership(agent: Agent): TeamMembership {
    return this.roster.membership(agent)
  }

  /** Install one authenticated Host owner of ordinary Lead execution preparation.
   * @param provider - stable anchor activation, without driving its model.
   * @returns an owner-scoped creation and cold-activation capability; no seat authority is granted.
   */
  installLeadExecutions(provider: LeadExecutionProvider): LeadExecutionHandle {
    return this.leadExecutions.install(this.ctx, provider, {
      bind: (input) => { this.mailbox.bindLeadInput(input) },
      queueHeld: (source, input, signal) => this.mailbox.queueHeld(source, input, signal),
      preloadLeadMail: (anchor, seat, input, signal) => this.mailbox.preloadLeadMail(anchor, seat, input, signal),
    })
  }

  /** Install the independent Host-only owner of native Lead coordination.
   * @param coordinator - registered opaque namespace, distinct from the Task writer.
   * @returns owned durable records, safe-point occupation and atomic seat commit.
   */
  installLeadCoordinator(coordinator: TeamLeadCoordinator): TeamLeadCoordinatorHandle {
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    return this.leadCoordinators.install(coordinator)
  }

  /** Read the stable Team host and committed execution independently of operation authority.
   * @param agent - exact live Team member, dormant host or marked execution.
   * @returns the current seat, optional live execution, and execution readiness.
   */
  leadContext(agent: Agent): import('./types.ts').TeamLeadContext {
    const membership = this.roster.tryMembership(agent)
    const anchor = membership?.root ?? this.leadExecutions.anchorForRead(agent)
    return this.leadExecutions.context(anchor)
  }

  /** Verify recorded current or historical Lead authorship without granting current authority.
   * @param agent - exact live Team reader.
   * @param executionId - actual recorded author.
   * @param term - recorded author term, or omitted to infer the anchor's implicit initial seat.
   * @returns whether the native seat history validates that author.
   */
  isLeadAuthor(agent: Agent, executionId: import('@deepseek-ai/dsh-session').SessionId, term?: number): boolean {
    return this.leadExecutions.isAuthor(this.leadContext(agent).anchor, executionId, term)
  }

  /** Read the stable seat through an exact live Team caller, including its dormant host.
   * @param agent - exact live anchor, member or current execution.
   * @returns detached native seat identity; no activation or write occurs.
   */
  leadSeat(agent: Agent): import('./lead-seat.ts').TeamLeadSeat {
    const membership = this.roster.tryMembership(agent)
    if (membership === undefined) throw new TeamError('Agent has no current Team identity', 'TEAM_NOT_MEMBER')
    return { ...this.leadExecutions.seat(membership.root) }
  }

  /**
   * Read the immutable controlled-mode binding, if this Team opted in.
   * @param agent - exact live Team caller.
   * @returns the durable controlled-mode binding, or undefined for an official Team.
   */
  controlledMode(agent: Agent): TeamControlledMode | undefined {
    return this.journal.state(this.roster.membership(agent).root).mode
  }

  /**
   * Read the durable Team composition policy; an untouched Team is dynamic.
   * @param agent - exact live Team member whose root owns the policy.
   * @returns a detached current policy value.
   */
  composition(agent: Agent): TeamCompositionState {
    return structuredClone(compositionOf(this.journal.state(this.roster.membership(agent).root).composition))
  }

  /**
   * Read one detached Team snapshot while native roster and Task writes are serialized.
   * @param caller - exact live Lead.
   * @param read - bounded Host callback that must not enter another Team transaction.
   * @returns the callback result from the same locked roster cut.
   */
  async readCompositionLocked<T>(
    caller: Agent, read: (snapshot: TeamCompositionSnapshot) => T | Promise<T>,
  ): Promise<T> {
    const membership = this.roster.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead reads composition', 'TEAM_LEAD_REQUIRED')
    const root = membership.root
    return await this.journal.transact(root.id, async () => {
      if (this.ctx.agents.get(root.id) !== root) throw new TeamError('Team Lead is no longer live', 'TEAM_NOT_MEMBER')
      return await read(this.compositionSnapshot(root))
    })
  }

  /**
   * Commit one Host-authored composition transition under the native Team lock.
   * Model tools do not expose this method. The builder may decline with undefined.
   * @param caller - exact live Lead used for the native Team identity.
   * @param build - Host planner that checks its own policy against a detached current snapshot.
   * @returns the committed policy, or the unchanged policy after a declined plan.
   */
  async commitComposition(
    caller: Agent,
    build: (snapshot: TeamCompositionSnapshot) => TeamCompositionTransition | undefined
      | Promise<TeamCompositionTransition | undefined>,
  ): Promise<TeamCompositionState> {
    const membership = this.roster.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead changes composition', 'TEAM_LEAD_REQUIRED')
    const root = membership.root
    return await this.journal.transact(root.id, async () => {
      if (this.ctx.agents.get(root.id) !== root) throw new TeamError('Team Lead is no longer live', 'TEAM_NOT_MEMBER')
      const state = this.journal.assertCallerWrite(root, caller)
      const transition = await build(this.compositionSnapshot(root))
      if (transition === undefined) return structuredClone(compositionOf(state.composition))
      this.journal.assertCallerWrite(root, caller)
      if (transition.kind === 'begin' && leadCoordinationActive(state.leadCoordination)) {
        throw new TeamError('Profile application conflicts with Lead coordination', 'TEAM_COMPOSITION_APPLYING')
      }
      const next = applyCompositionTransition(state.composition, transition, state.members)
      await this.journal.appendAndFlush(root, 'team/composition', {
        version: 1, teamId: membership.id, transition,
      })
      return structuredClone(next)
    })
  }

  private compositionSnapshot(root: Agent): TeamCompositionSnapshot {
    const state = this.journal.state(root)
    return { composition: structuredClone(compositionOf(state.composition)),
      members: structuredClone(state.members), tasks: structuredClone(state.tasks),
      maxMembers: this.config.maxMembers, maxActiveMembers: this.config.maxActiveMembers }
  }

  /**
   * Read the configured teammate Preset used when a spawn request omits one.
   * @returns configured Preset id, or undefined to inherit the Lead.
   */
  defaultMemberPresetId(): string | undefined {
    return this.config.defaultMemberPresetId
  }

  /**
   * Read product-owned next-action hints after a controlled member releases work.
   * @param agent - exact live Team member.
   * @returns text supplied by the installed extension without Team interpretation.
   */
  releaseHints(agent: Agent): readonly string[] {
    this.roster.membership(agent)
    return this.tasks.extensionReleaseHints(agent)
  }

  /**
   * List the runtime-enriched roster visible to one Team member.
   * @param agent - exact live Team member.
   * @returns Lead and teammate rows in creation order.
   */
  listMembers(agent: Agent): TeamMemberView[] {
    return this.roster.list(this.roster.membership(agent))
  }

  /**
   * Create one named, continuable direct child of the Team Lead.
   * @param caller - exact live Lead Agent.
   * @param request - immutable name, description, prompt, context mode, provider, and cancellation.
   * Controlled Teams replace the prompt and require fresh context.
   * @returns the active roster row.
   */
  async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult> {
    return await this.roster.spawn(caller, request)
  }

  /**
   * Retire a teammate after its assignments and pending messages are settled.
   * The member name and Session history remain available for audit.
   * @param caller - exact live Lead Agent.
   * @param targetName - immutable teammate name.
   * @param applicationId - matching in-progress user application, absent for an ordinary dynamic Team.
   * @returns the retired roster row.
   */
  async retireTeammate(caller: Agent, targetName: string, applicationId?: string): Promise<TeamMemberView> {
    return await this.roster.retire(caller, targetName, applicationId)
  }

  /**
   * Queue one durable peer message, then attempt immediate delivery.
   * @param caller - exact live sending Team member.
   * @param request - target name, content, and pre-queue cancellation.
   * @returns durable message identity and immediate-delivery observation.
   */
  async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
    return await this.mailbox.send(caller, request)
  }

  /**
   * Cancel a teammate's undelivered messages before retiring an unavailable member.
   * @param caller - exact live Lead Agent.
   * @param targetName - immutable teammate name.
   * @param reason - durable explanation for cancellation.
   * @returns ids of messages cancelled by this call.
   */
  async cancelPendingMessages(caller: Agent, targetName: string, reason: string): Promise<readonly TeamMessageId[]> {
    return await this.mailbox.cancelPending(caller, targetName, reason)
  }

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param caller - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    return await this.tasks.create(caller, this.roster.membership(caller), request)
  }

  /**
   * Install one product Task writer while retaining the native Team Board and Session log.
   * @param writer - create/update policy and stable extension event identifier.
   * @returns an effect-owned transaction capability and disposer.
   */
  installTaskExtension(writer: TeamTaskExtension): TeamTaskExtensionHandle {
    return this.tasks.installExtension(writer)
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param caller - exact live Team member reading the task.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  getTask(caller: Agent, id: TeamTaskId): TeamTaskView {
    return this.tasks.get(this.roster.membership(caller), id)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param caller - exact live Team member reading the board.
   * @returns detached current task views.
   */
  listTasks(caller: Agent): TeamTaskView[] {
    return this.tasks.list(this.roster.membership(caller))
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param caller - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision.
   */
  async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView> {
    return await this.tasks.update(caller, this.roster.membership(caller), request)
  }

  /**
   * Wait for the next Team-domain or member-status change.
   * @param caller - exact live Team member waiting for activity.
   * @param timeoutMs - bounded wait duration from ten seconds through one hour.
   * @param signal - caller cancellation for the wait only.
   * @returns one observed change or a timeout result.
   */
  async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    const membership = this.roster.membership(caller)
    return await this.activity.wait(membership.id, timeoutMs, signal)
  }

  /**
   * Interrupt one live teammate turn without clearing its pending inbox.
   * @param caller - exact live Lead Agent.
   * @param targetName - durable teammate name.
   * @returns the target status sampled before cancellation.
   */
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' } {
    return this.roster.interrupt(caller, targetName)
  }

  /**
   * Resolve a caller without throwing, used by scoped-tool installation and observers.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for non-Team subagents and stale identities.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    return this.roster.tryMembership(agent)
  }

  /** Write the mode before any Team tool can be installed on a new root Agent. */
  private async initializeControlledMode(agent: Agent, source: string): Promise<void> {
    const configured = this.config.controlledMode
    if (configured === undefined || source !== 'startup') return
    const membership = this.roster.tryMembership(agent)
    if (membership?.role !== 'lead') return
    const root = membership.root
    await this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      if (state.mode !== undefined) return
      // A historical product Team must not be silently converted by a resumed
      // or incorrectly republished Agent. It remains read-only under this bundle.
      if (state.members.length > 0 || state.tasks.length > 0 || state.messages.length > 0) return
      await this.journal.appendAndFlush(root, 'team/mode', {
        version: 1, teamId: TeamId(root.id), mode: configured,
      })
    })
  }

  /** Queue one contained recovery pass after publication has unwound. */
  private scheduleRecovery(agent: Agent): void {
    queueMicrotask(() => {
      if (this.lifecycle.disposed) return
      void this.recoverFor(agent).catch((error: unknown) => {
        if (this.lifecycle.disposed) return
        this.ctx.logger.warn(`Agent Teams recovery for "${agent.id}" failed: ${errorMessage(error)}`)
      })
    })
  }

  /** Reconcile roster provisioning before retrying that member's pending mailbox. */
  private async recoverFor(agent: Agent): Promise<void> {
    await this.roster.recoverFor(agent, this.lifecycle.signal)
    await this.mailbox.recoverFor(agent, this.lifecycle.signal)
  }

  /** Stop Team-owned live branches and release every waiter before service disposal completes. */
  private async disposeRuntime(): Promise<void> {
    this.lifecycle.close()
    this.activity.close()

    const failures: unknown[] = []
    await this.lifecycle.settle(this.roster.pendingCreations(), failures)
    await this.lifecycle.settle(this.mailbox.pendingDispatches(), failures)
    for (const [root, childIds] of this.roster.liveChildrenByRoot()) {
      try {
        await this.roster.stopTeammates(root, childIds)
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Agent Teams runtime disposal failed')
  }
}

export default TeamService
