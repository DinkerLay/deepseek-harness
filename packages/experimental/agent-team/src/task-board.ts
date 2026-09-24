/** Shared Team task DAG commands and runtime-enriched views. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamMembership } from './roster.ts'
import { TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamState } from './projection.ts'
import { resolveActiveMember } from './roster.ts'
import { assertTaskGraphCandidate, TeamTaskGraphError } from './task-graph.ts'
import type { TeamTaskGraphViolation } from './task-graph.ts'
import { applyTaskTransaction, TeamTaskTransactionError } from './task-transaction.ts'
import type { TeamTaskExtension, TeamTaskExtensionHandle, TeamTaskTransactionBuilder } from './task-extension.ts'
import { TeamId, TeamTaskId } from './types.ts'
import type {
  CreateTeamTaskRequest,
  TeamMessageSnapshot,
  TeamTaskSnapshot,
  TeamTaskTransactionUpdate,
  TeamTaskView,
  UpdateTeamTaskRequest,
} from './types.ts'
import { projectTaskView, taskReady } from './task-view.ts'
import { requiredText, writeScope } from './validation.ts'

const TASK_GRAPH_ERROR_CODES: Record<TeamTaskGraphViolation, string> = {
  missing: 'TEAM_TASK_NOT_FOUND',
  duplicate: 'TEAM_INVALID_ARGUMENT',
  cycle: 'TEAM_TASK_DEPENDENCY_CYCLE',
}

/** Owns Team task limits, authorization, transitions, and derived views. */
export class TeamTaskBoard {
  private extension: { readonly writer: TeamTaskExtension; readonly handle: TeamTaskExtensionHandle } | undefined

  /**
   * @param journal - authoritative Lead-log transaction owner.
   * @param maxTasks - maximum non-deleted tasks retained by one Team.
   * @param maxTaskExtensionBytes - byte limit for the extension-owned JSON in one event.
   * @param maxPendingMessagesPerMember - maximum unsettled Team notices for a target.
   * @param maxMessageBytes - maximum sender-framed Team notice size.
   * @param membershipOf - resolves the exact current caller inside each transaction.
   * @param isDisposed - Team runtime admission cutoff.
   * @param dispatchNotices - non-throwing post-commit mailbox wakeup.
   */
  constructor(
    private readonly journal: TeamJournal,
    private readonly maxTasks: number,
    private readonly maxTaskExtensionBytes: number,
    private readonly maxPendingMessagesPerMember: number,
    private readonly maxMessageBytes: number,
    private readonly membershipOf: (caller: Agent) => TeamMembership,
    private readonly isDisposed: () => boolean,
    private readonly dispatchNotices: (root: Agent) => void,
  ) {}

  /**
   * Install one optional Task writer without replacing the native Team service.
   * @param writer - product create/update implementation and stable event identifier.
   * @returns an effect-owned commit capability and disposer.
   */
  installExtension(writer: TeamTaskExtension): TeamTaskExtensionHandle {
    if (this.isDisposed()) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    if (this.extension !== undefined) throw new TeamError('Team Task extension is already installed', 'TEAM_TASK_EXTENSION_CONFLICT')
    const id = requiredText(writer.id, 'extension id', 200)
    const handle: TeamTaskExtensionHandle = {
      commit: async (caller, build) => await this.commitExtension(writer, id, caller, build),
      dispose: () => { if (this.extension?.handle === handle) this.extension = undefined },
    }
    this.extension = { writer, handle }
    return handle
  }

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param caller - exact live member creating the Task.
   * @param membership - exact caller membership resolved by the Team roster.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async create(caller: Agent, membership: TeamMembership, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    const extension = this.extension
    if (extension !== undefined) return await extension.writer.create(caller, request, extension.handle)
    const { root } = membership
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const active = state.tasks.filter(task => task.status !== 'deleted').length
      if (active >= this.maxTasks) {
        throw new TeamError(`Team task limit ${this.maxTasks} reached`, 'TEAM_TASK_LIMIT')
      }
      const id = TeamTaskId(`task-${state.nextTaskNumber}`)
      if (state.tasks.some(task => task.id === id)) {
        throw new TeamError('Team task id space exhausted', 'TEAM_TASK_LIMIT')
      }
      const task: TeamTaskSnapshot = {
        id,
        revision: 1,
        subject: requiredText(request.subject, 'subject', 200),
        description: requiredText(request.description, 'description', 16_384),
        status: 'pending',
        blockedBy: this.dependencies(request.blockedBy ?? [], state),
        writeScopes: this.writeScopes(request.writeScopes ?? []),
      }
      this.assertTaskGraph(state, task)
      await this.journal.appendAndFlush(root, 'team/task', { version: 2, teamId: TeamId(root.id), task })
      return projectTaskView(state, task)
    })
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param membership - exact caller membership resolved by the Team roster.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  get(membership: TeamMembership, id: TeamTaskId): TeamTaskView {
    const { root } = membership
    const state = this.journal.state(root)
    const task = state.tasks.find(candidate => candidate.id === id)
    if (task === undefined) throw new TeamError(`team task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
    return projectTaskView(state, task)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param membership - exact caller membership resolved by the Team roster.
   * @returns detached current task views.
   */
  list(membership: TeamMembership): TeamTaskView[] {
    const { root } = membership
    const state = this.journal.state(root)
    return state.tasks
      .filter(task => task.status !== 'deleted')
      .map(task => projectTaskView(state, task))
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param caller - exact live Team member authorizing the mutation.
   * @param membership - caller role and exact live Lead.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision.
   */
  async update(
    caller: Agent,
    membership: TeamMembership,
    request: UpdateTeamTaskRequest,
  ): Promise<TeamTaskView> {
    const extension = this.extension
    if (extension !== undefined) return await extension.writer.update(caller, request, extension.handle)
    const root = membership.root
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const current = state.tasks.find(task => task.id === request.taskId)
      if (current === undefined) throw new TeamError(`team task "${request.taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
      if (current.revision !== request.expectedRevision) {
        throw new TeamError(
          `stale team task "${current.id}" revision ${request.expectedRevision}; current revision is ${current.revision}`,
          'TEAM_TASK_STALE_REVISION',
        )
      }
      if (current.status === 'deleted') throw new TeamError(`team task "${current.id}" is deleted`, 'TEAM_TASK_DELETED')
      const lead = membership.role === 'lead'
      const owner = current.ownerId === caller.id
      const authorizeOwner = (): void => {
        if (!lead && !owner) throw new TeamError('task mutation requires its owner or Team Lead', 'TEAM_TASK_UNAUTHORIZED')
      }
      let next: TeamTaskSnapshot
      switch (request.action) {
        case 'claim':
          if (current.ownerId !== undefined && current.ownerId !== caller.id) {
            throw new TeamError(`team task "${current.id}" is owned by another member`, 'TEAM_TASK_ALREADY_CLAIMED')
          }
          if (current.status !== 'pending' || !taskReady(state, current)) {
            throw new TeamError(`team task "${current.id}" is not ready to claim`, 'TEAM_TASK_BLOCKED')
          }
          next = { ...current, status: 'in_progress', ownerId: caller.id }
          break
        case 'release':
          authorizeOwner()
          if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can be released', 'TEAM_TASK_INVALID_TRANSITION')
          next = this.withoutOwner({ ...current, status: 'pending' })
          break
        case 'edit':
          authorizeOwner()
          if (request.subject === undefined && request.description === undefined && request.writeScopes === undefined) {
            throw new TeamError('task edit requires subject, description, or write_scopes', 'TEAM_INVALID_ARGUMENT')
          }
          next = {
            ...current,
            ...request.subject === undefined ? {} : { subject: requiredText(request.subject, 'subject', 200) },
            ...request.description === undefined
              ? {}
              : { description: requiredText(request.description, 'description', 16_384) },
            ...request.writeScopes === undefined ? {} : { writeScopes: this.writeScopes(request.writeScopes) },
          }
          break
        case 'set_dependencies':
          authorizeOwner()
          if (request.blockedBy === undefined) throw new TeamError('set_dependencies requires blocked_by', 'TEAM_INVALID_ARGUMENT')
          next = { ...current, blockedBy: this.dependencies(request.blockedBy, state, current.id) }
          break
        case 'complete':
          authorizeOwner()
          if (current.status !== 'in_progress') throw new TeamError('only an in-progress task can complete', 'TEAM_TASK_INVALID_TRANSITION')
          next = { ...current, status: 'completed' }
          break
        case 'reopen':
          authorizeOwner()
          if (current.status !== 'completed') throw new TeamError('only a completed task can reopen', 'TEAM_TASK_INVALID_TRANSITION')
          next = this.withoutOwner({ ...current, status: 'pending' })
          break
        case 'reassign': {
          if (!lead) throw new TeamError('only the Team Lead can reassign tasks', 'TEAM_LEAD_REQUIRED')
          if (current.status !== 'pending' && current.status !== 'in_progress') {
            throw new TeamError(
              'only a pending or in-progress task can be reassigned',
              'TEAM_TASK_INVALID_TRANSITION',
            )
          }
          if (request.owner === undefined || request.owner.trim().length === 0) {
            next = this.withoutOwner({ ...current, status: 'pending' })
            break
          }
          if (!taskReady(state, current)) throw new TeamError(`team task "${current.id}" is blocked`, 'TEAM_TASK_BLOCKED')
          const assignee = resolveActiveMember(root, state, request.owner)
          next = { ...current, status: 'in_progress', ownerId: assignee.id }
          break
        }
        case 'delete': {
          authorizeOwner()
          const dependent = state.tasks.find(task =>
            task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id))
          if (dependent !== undefined) {
            throw new TeamError(`team task "${current.id}" still blocks "${dependent.id}"`, 'TEAM_TASK_HAS_DEPENDENTS')
          }
          next = { ...current, status: 'deleted' }
          break
        }
        /* v8 ignore next 2 -- TeamTaskAction is closed and every member is handled above. */
        default:
          throw new TeamError(`unsupported task action ${String(request.action)}`, 'TEAM_INVALID_ARGUMENT')
      }
      const task: TeamTaskSnapshot = {
        ...next,
        revision: current.revision + 1,
      }
      this.assertTaskGraph(state, task)
      await this.journal.appendAndFlush(root, 'team/task', { version: 2, teamId: TeamId(root.id), task })
      return projectTaskView(state, task)
    })
  }

  /** Commit one extension proposal under the same native Team lock used by default Task commands. */
  private async commitExtension(
    writer: TeamTaskExtension,
    extensionId: string,
    caller: Agent,
    build: TeamTaskTransactionBuilder,
  ): Promise<TeamTaskView[]> {
    if (this.isDisposed()) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    if (this.extension?.writer !== writer) throw new TeamError('Team Task extension is no longer installed', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
    const initial = this.membershipOf(caller)
    const root = initial.root
    const result = await this.journal.transact(root.id, async () => {
      if (this.isDisposed()) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
      if (this.extension?.writer !== writer) throw new TeamError('Team Task extension is no longer installed', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
      if (this.membershipOf(caller).root !== root) throw new TeamError('Team member changed during Task transaction', 'TEAM_NOT_MEMBER')
      const state = this.journal.state(root)
      const plan = build({
        tasks: structuredClone(state.tasks),
        members: structuredClone(state.members),
        nextTaskNumber: state.nextTaskNumber,
      })
      if (Buffer.byteLength(plan.dataJson, 'utf8') > this.maxTaskExtensionBytes) {
        throw new TeamError(`Task extension data exceeds ${this.maxTaskExtensionBytes} bytes`, 'TEAM_TASK_EXTENSION_TOO_LARGE')
      }
      try {
        JSON.parse(plan.dataJson)
      } catch {
        throw new TeamError('Task extension data must be valid JSON', 'TEAM_TASK_EXTENSION_INVALID')
      }
      const updates: TeamTaskTransactionUpdate[] = plan.updates.map(update => ({
        previousRevision: update.previousRevision,
        task: structuredClone(update.task),
      }))
      let next: ReturnType<typeof applyTaskTransaction>
      try {
        next = applyTaskTransaction(state.tasks, state.nextTaskNumber, updates)
      } catch (error: unknown) {
        if (error instanceof TeamTaskGraphError) {
          throw new TeamError(error.message, TASK_GRAPH_ERROR_CODES[error.violation], { cause: error })
        }
        if (error instanceof TeamTaskTransactionError) {
          const code = error.violation === 'stale' ? 'TEAM_TASK_STALE_REVISION'
            : error.violation === 'id-space' ? 'TEAM_TASK_LIMIT' : 'TEAM_INVALID_ARGUMENT'
          throw new TeamError(error.message, code, { cause: error })
        }
        throw error
      }
      if (next.tasks.filter(task => task.status !== 'deleted').length > this.maxTasks) {
        throw new TeamError(`Team task limit ${this.maxTasks} reached`, 'TEAM_TASK_LIMIT')
      }
      for (const update of updates) {
        const prior = state.tasks.find(task => task.id === update.task.id)
        const ownerId = update.task.ownerId
        if (update.task.status === 'in_progress' && ownerId === undefined) {
          throw new TeamError(`in-progress Task "${update.task.id}" needs an owner`, 'TEAM_INVALID_ARGUMENT')
        }
        if (ownerId !== undefined && ownerId !== prior?.ownerId && ownerId !== root.id
          && !state.members.some(member => member.id === ownerId && member.phase === 'active')) {
          throw new TeamError(`Task "${update.task.id}" owner is not active`, 'TEAM_MEMBER_NOT_FOUND')
        }
      }
      const notices: TeamMessageSnapshot[] = (plan.notices ?? []).map(notice => structuredClone(notice))
      const seen = new Set<string>()
      const sender = this.membershipOf(caller)
      for (const notice of notices) {
        if (notice.senderId !== caller.id || notice.senderName !== sender.name || notice.targetId === caller.id) {
          throw new TeamError(`Task notice "${notice.id}" has an invalid sender or target`, 'TEAM_INVALID_ARGUMENT')
        }
        if (seen.has(notice.id) || state.messages.some(message => message.id === notice.id)) {
          throw new TeamError(`Task notice "${notice.id}" already exists`, 'TEAM_INVALID_ARGUMENT')
        }
        seen.add(notice.id)
        if (notice.targetId !== root.id && !state.members.some(member =>
          member.id === notice.targetId && member.phase === 'active')) {
          throw new TeamError(`Task notice "${notice.id}" target is not active`, 'TEAM_MEMBER_NOT_FOUND')
        }
        const pending = state.messages.filter(message => message.targetId === notice.targetId
          && !state.delivered.includes(message.id)
          && !state.cancelled.some(item => item.messageId === message.id)).length
          + notices.filter(candidate => candidate.targetId === notice.targetId && candidate !== notice).length
        if (pending >= this.maxPendingMessagesPerMember) {
          throw new TeamError('Task notice target has too many pending messages', 'TEAM_MAILBOX_FULL')
        }
        const framed = [{ type: 'text', text: `Team message ${notice.id} from ${notice.senderName}:` }, ...notice.content]
        if (Buffer.byteLength(JSON.stringify(framed), 'utf8') > this.maxMessageBytes) {
          throw new TeamError(`Task notice "${notice.id}" exceeds ${this.maxMessageBytes} bytes`, 'TEAM_MESSAGE_TOO_LARGE')
        }
      }
      await this.journal.appendAndFlush(root, 'team/task/transaction', {
        version: 1, teamId: TeamId(root.id), updates,
        extension: { id: extensionId, dataJson: plan.dataJson },
        ...notices.length === 0 ? {} : { notices },
      })
      const committed = this.journal.state(root)
      return { views: updates.map(update => projectTaskView(committed, update.task)), hasNotices: notices.length > 0 }
    })
    if (result.hasNotices) this.dispatchNotices(root)
    return result.views
  }

  /** Validate and de-duplicate dependency ids against the current task graph. */
  private dependencies(
    values: readonly TeamTaskId[],
    state: TeamState,
    self?: TeamTaskId,
  ): TeamTaskId[] {
    const seen = new Set<TeamTaskId>()
    const result: TeamTaskId[] = []
    for (const id of values) {
      if (id === self) throw new TeamError('a team task cannot block itself', 'TEAM_TASK_DEPENDENCY_CYCLE')
      if (seen.has(id)) throw new TeamError(`duplicate blocker "${id}"`, 'TEAM_INVALID_ARGUMENT')
      const task = state.tasks.find(candidate => candidate.id === id)
      if (task === undefined || task.status === 'deleted') {
        throw new TeamError(`blocker task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
      }
      seen.add(id)
      result.push(id)
    }
    return result
  }

  /** Normalize and de-duplicate task write scopes. */
  private writeScopes(values: readonly string[]): string[] {
    return [...new Set(values.map(writeScope))]
  }

  /** Map shared task-graph validation onto stable command error codes. */
  private assertTaskGraph(state: TeamState, candidate: TeamTaskSnapshot): void {
    try {
      assertTaskGraphCandidate(state.tasks, candidate)
    } catch (error: unknown) {
      /* v8 ignore next -- the shared validator is the only statement in the try and throws this exact error. */
      if (!(error instanceof TeamTaskGraphError)) throw error
      throw new TeamError(error.message, TASK_GRAPH_ERROR_CODES[error.violation], { cause: error })
    }
  }

  /** Remove an optional owner field under exactOptionalPropertyTypes. */
  private withoutOwner(task: TeamTaskSnapshot): TeamTaskSnapshot {
    const { ownerId: _ownerId, ...without } = task
    return without
  }
}
