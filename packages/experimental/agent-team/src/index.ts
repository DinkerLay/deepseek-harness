/** Agent Teams service façade over roster, mailbox, task, and runtime lifecycle owners. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { TeamActivity } from './activity.ts'
import { errorMessage, TeamError } from './error.ts'
import { TeamJournal } from './journal.ts'
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
export type { TeamTaskExtension, TeamTaskExtensionHandle, TeamTaskTransactionBuilder } from './task-extension.ts'
export { TeamId, TeamMessageId, TeamTaskId } from './types.ts'
export { TeamError } from './error.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeams: TeamService
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
    }), z.const(undefined)]),
    maxMembers: z.number().step(1).min(1).default(DEFAULT_MAX_MEMBERS),
    maxActiveMembers: z.number().step(1).min(1).default(DEFAULT_MAX_MEMBERS),
    maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
    maxPendingMessagesPerMember: z.number().step(1).min(1).default(DEFAULT_MAX_PENDING_MESSAGES),
    maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
    maxTaskExtensionBytes: z.number().step(1).min(1).default(DEFAULT_MAX_TASK_EXTENSION_BYTES),
    disposalTimeoutMs: z.number().step(1).min(1).default(DEFAULT_DISPOSAL_TIMEOUT_MS),
  })

  /** Validated deployment limits used by every Team operation. */
  private readonly config: Required<Omit<Config, 'controlledMode'>> & Pick<Config, 'controlledMode'>

  private readonly activity: TeamActivity
  private readonly lifecycle: TeamRuntimeLifecycle
  private readonly journal: TeamJournal
  private readonly roster: TeamRoster
  private readonly mailbox: TeamMailbox
  private readonly tasks: TeamTaskBoard

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentTeams')
    this.config = {
      ...config.controlledMode === undefined ? {} : { controlledMode: config.controlledMode },
      maxMembers: positiveLimit('maxMembers', config.maxMembers ?? DEFAULT_MAX_MEMBERS),
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
    this.roster = new TeamRoster(
      ctx, this.journal, this.lifecycle, this.config.maxMembers, this.config.maxActiveMembers,
    )
    this.mailbox = new TeamMailbox(
      ctx,
      this.journal,
      this.roster,
      this.lifecycle,
      this.config.maxPendingMessagesPerMember,
      this.config.maxMessageBytes,
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
    )

    ctx.on('session/event', (session, event) => { this.mailbox.observeSessionEvent(session, event) })
    ctx.on('agent/created', async ({ agent, source }) => {
      await this.initializeControlledMode(agent, source)
      this.scheduleRecovery(agent)
    })
    ctx.on('agent/status', ({ agent }) => {
      const membership = this.roster.tryMembership(agent)
      if (membership !== undefined) this.activity.notify(membership.id)
    })
    ctx.effect(() => {
      const disposeProjection = ctx.root.sessionProjections.register(teamProjectionDefinition)
      return async () => {
        try {
          await this.disposeRuntime()
        } finally {
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

  /**
   * Read the immutable controlled-mode binding, if this Team opted in.
   * @param agent - exact live Team caller.
   * @returns the durable controlled-mode binding, or undefined for an official Team.
   */
  controlledMode(agent: Agent): TeamControlledMode | undefined {
    return this.journal.state(this.roster.membership(agent).root).mode
  }

  /**
   * Read the installed Task writer's running-Attempt admission for one exact member.
   * @param agent - exact live Team member.
   * @returns whether the member has a running product Attempt.
   */
  hasRunningAttempt(agent: Agent): boolean {
    this.roster.membership(agent)
    return this.tasks.hasRunningAttempt(agent)
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
   * @returns the retired roster row.
   */
  async retireTeammate(caller: Agent, targetName: string): Promise<TeamMemberView> {
    return await this.roster.retire(caller, targetName)
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
