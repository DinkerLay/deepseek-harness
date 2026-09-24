/** Shared Team Task commands, review state, and prerequisite DAG. */

import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamMembership } from './roster.ts'
import { TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamState } from './projection.ts'
import { assertActiveTeamMember, resolveActiveMember } from './roster.ts'
import { assertTaskGraphCandidate, TeamTaskGraphError } from './task-graph.ts'
import type { TeamTaskGraphViolation } from './task-graph.ts'
import { TeamId, TeamTaskAttemptId, TeamTaskId } from './types.ts'
import type {
  AcceptTeamTaskResultRequest,
  CreateTeamTaskRequest,
  ReworkTeamTaskRequest,
  SubmitTeamTaskResultRequest,
  TeamManagedTaskState,
  TeamManagedTaskUpdate,
  TeamTaskAttemptSnapshot,
  TeamTaskReviewView,
  TeamTaskSnapshot,
  TeamTaskView,
  UpdateTeamTaskRequest,
} from './types.ts'
import { requiredText, writeScope } from './validation.ts'

/** Whether two normalized file or directory prefixes overlap on path components. */
function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

const TASK_GRAPH_ERROR_CODES: Record<TeamTaskGraphViolation, string> = {
  missing: 'TEAM_TASK_NOT_FOUND',
  duplicate: 'TEAM_INVALID_ARGUMENT',
  cycle: 'TEAM_TASK_DEPENDENCY_CYCLE',
}

/** Owns Team task limits, authorization, transitions, and derived views. */
export class TeamTaskBoard {
  /**
   * @param journal - authoritative Lead-log transaction owner.
   * @param maxTasks - maximum non-deleted tasks retained by one Team.
   */
  constructor(
    private readonly journal: TeamJournal,
    private readonly maxTasks: number,
  ) {}

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param membership - exact caller membership resolved by the Team roster.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async create(membership: TeamMembership, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    const { root } = membership
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      assertActiveTeamMember(membership, state)
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
      const review: TeamManagedTaskState = { attempts: [], validity: 'none' }
      await this.appendManaged(root, [{ task, review }])
      return this.taskView(root, this.journal.state(root), task)
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
    return this.taskView(root, state, task)
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
      .map(task => this.taskView(root, state, task))
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
    const root = membership.root
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      assertActiveTeamMember(membership, state)
      const current = state.tasks.find(task => task.id === request.taskId)
      if (current === undefined) throw new TeamError(`team task "${request.taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
      if (current.revision !== request.expectedRevision) {
        throw new TeamError(
          `stale team task "${current.id}" revision ${request.expectedRevision}; current revision is ${current.revision}`,
          'TEAM_TASK_STALE_REVISION',
        )
      }
      if (current.status === 'deleted') throw new TeamError(`team task "${current.id}" is deleted`, 'TEAM_TASK_DELETED')
      const managed = state.managed[current.id]
      if (managed !== undefined) return await this.updateManaged(caller, membership, request, state, current, managed)
      if (request.action === 'edit' || request.action === 'reopen'
        || request.action === 'set_dependencies' || request.action === 'delete') {
        this.assertNoManagedDependents(state, current.id)
      }
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
          if (current.status !== 'pending' || !this.taskReady(state, current)) {
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
          if (!this.taskReady(state, current)) throw new TeamError(`team task "${current.id}" is blocked`, 'TEAM_TASK_BLOCKED')
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
      return this.taskView(root, state, task)
    })
  }

  /** Apply one managed Task transition without admitting legacy completion as result acceptance. */
  private async updateManaged(
    caller: Agent,
    membership: TeamMembership,
    request: UpdateTeamTaskRequest,
    state: TeamState,
    current: TeamTaskSnapshot,
    review: TeamManagedTaskState,
  ): Promise<TeamTaskView> {
    if (review.replacedByTaskId !== undefined) {
      throw new TeamError(`Task "${current.id}" is superseded by "${review.replacedByTaskId}"`, 'TEAM_TASK_ALREADY_REWORKED')
    }
    const lead = membership.role === 'lead'
    const owner = current.ownerId === caller.id
    const authorizeOwner = (): void => {
      if (!lead && !owner) throw new TeamError('task mutation requires its owner or Team Lead', 'TEAM_TASK_UNAUTHORIZED')
    }
    const latest = review.attempts.at(-1)
    let next: TeamTaskSnapshot = current
    let nextReview: TeamManagedTaskState = review
    switch (request.action) {
      case 'claim': {
        if (current.ownerId !== undefined && current.ownerId !== caller.id) {
          throw new TeamError(`team task "${current.id}" is owned by another member`, 'TEAM_TASK_ALREADY_CLAIMED')
        }
        if (current.status !== 'pending' || !this.taskReady(state, current)) {
          throw new TeamError(`team task "${current.id}" is not ready to claim`, 'TEAM_TASK_BLOCKED')
        }
        next = { ...current, status: 'in_progress', ownerId: caller.id }
        nextReview = { ...review, validity: 'none', attempts: [
          ...review.attempts, this.startAttempt(caller.id, current, state),
        ] }
        break
      }
      case 'release':
        authorizeOwner()
        if (current.status !== 'in_progress' || latest?.status !== 'running') {
          throw new TeamError('only a running attempt can be released', 'TEAM_TASK_INVALID_TRANSITION')
        }
        next = this.withoutOwner({ ...current, status: 'pending' })
        nextReview = { ...review, attempts: [...review.attempts.slice(0, -1), {
          ...latest, status: 'cancelled', reason: 'released before result submission',
        }] }
        break
      case 'edit':
        authorizeOwner()
        if (current.status === 'completed' || latest?.status === 'submitted') {
          throw new TeamError('submitted or accepted work requires a new Task for quality rework', 'TEAM_TASK_REWORK_REQUIRED')
        }
        if (request.subject === undefined && request.description === undefined && request.writeScopes === undefined) {
          throw new TeamError('task edit requires subject, description, or write_scopes', 'TEAM_INVALID_ARGUMENT')
        }
        next = {
          ...current,
          ...request.subject === undefined ? {} : { subject: requiredText(request.subject, 'subject', 200) },
          ...request.description === undefined ? {} : { description: requiredText(request.description, 'description', 16_384) },
          ...request.writeScopes === undefined ? {} : { writeScopes: this.writeScopes(request.writeScopes) },
        }
        break
      case 'set_dependencies':
        authorizeOwner()
        if (current.status !== 'pending') {
          throw new TeamError('stop an active Task before changing its prerequisites', 'TEAM_TASK_STOP_REQUIRED')
        }
        if (request.blockedBy === undefined) throw new TeamError('set_dependencies requires blocked_by', 'TEAM_INVALID_ARGUMENT')
        next = { ...current, blockedBy: this.dependencies(request.blockedBy, state, current.id) }
        break
      case 'complete':
        throw new TeamError('managed Tasks require result submission and Lead acceptance', 'TEAM_TASK_RESULT_REQUIRED')
      case 'reopen':
        throw new TeamError('quality rework requires a new Task', 'TEAM_TASK_REWORK_REQUIRED')
      case 'reassign': {
        if (!lead) throw new TeamError('only the Team Lead can reassign tasks', 'TEAM_LEAD_REQUIRED')
        if (current.status !== 'pending') throw new TeamError('stop the current attempt before reassignment', 'TEAM_TASK_STOP_REQUIRED')
        if (request.owner === undefined || request.owner.trim() === '') {
          next = this.withoutOwner(current)
          break
        }
        if (!this.taskReady(state, current)) throw new TeamError(`team task "${current.id}" is blocked`, 'TEAM_TASK_BLOCKED')
        const assignee = resolveActiveMember(membership.root, state, request.owner)
        next = { ...current, status: 'in_progress', ownerId: assignee.id }
        nextReview = { ...review, validity: 'none', attempts: [
          ...review.attempts, this.startAttempt(assignee.id, current, state),
        ] }
        break
      }
      case 'delete': {
        authorizeOwner()
        if (current.status === 'in_progress') throw new TeamError('stop the current attempt before deletion', 'TEAM_TASK_STOP_REQUIRED')
        const dependent = state.tasks.find(task =>
          task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id))
        if (dependent !== undefined) {
          throw new TeamError(`team task "${current.id}" still blocks "${dependent.id}"`, 'TEAM_TASK_HAS_DEPENDENTS')
        }
        next = { ...current, status: 'deleted' }
        nextReview = { ...review, validity: review.validity === 'valid' ? 'stale' : review.validity }
        break
      }
      /* v8 ignore next 2 -- TeamTaskAction is closed and every member is handled above. */
      default:
        throw new TeamError(`unsupported task action ${String(request.action)}`, 'TEAM_INVALID_ARGUMENT')
    }
    const task: TeamTaskSnapshot = { ...next, revision: current.revision + 1 }
    this.assertTaskGraph(state, task)
    await this.appendManaged(membership.root, [{ task, review: nextReview }])
    return this.taskView(membership.root, this.journal.state(membership.root), task)
  }

  /** Reserve one technical Attempt with exact accepted prerequisite revisions. */
  private startAttempt(ownerId: TeamTaskAttemptSnapshot['ownerId'], task: TeamTaskSnapshot, state: TeamState): TeamTaskAttemptSnapshot {
    return {
      id: TeamTaskAttemptId(randomUUID()), ownerId, status: 'running',
      inputs: task.blockedBy.map((id) => {
        const blocker = state.tasks.find(candidate => candidate.id === id)
        if (blocker === undefined || blocker.status !== 'completed') {
          throw new TeamError(`blocker task "${id}" is not complete`, 'TEAM_TASK_BLOCKED')
        }
        return { taskId: id, revision: blocker.revision }
      }),
    }
  }

  /** Append one atomic managed transition after command-level validation. */
  private async appendManaged(root: Agent, updates: TeamManagedTaskUpdate[]): Promise<void> {
    await this.journal.appendAndFlush(root, 'team/task/managed', {
      version: 1, teamId: TeamId(root.id), updates,
    })
  }

  /**
   * Submit the exact owner's current Attempt without completing or accepting its Task.
   * @param caller - exact live Task owner.
   * @param membership - caller's current Team authority.
   * @param request - Task and Attempt CAS identities plus detached result content.
   * @returns Task view showing the submitted result for Lead review.
   */
  async submitResult(
    caller: Agent, membership: TeamMembership, request: SubmitTeamTaskResultRequest,
  ): Promise<TeamTaskView> {
    const root = membership.root
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      assertActiveTeamMember(membership, state)
      const task = this.currentTask(state, request.taskId, request.expectedRevision)
      const review = this.requireManaged(state, task.id)
      const latest = review.attempts.at(-1)
      if (task.status !== 'in_progress' || task.ownerId !== caller.id
        || latest?.id !== request.attemptId || latest.status !== 'running') {
        throw new TeamError('result does not belong to the current running Attempt', 'TEAM_TASK_STALE_ATTEMPT')
      }
      this.assertInputs(state, task, latest)
      if (request.result.artifacts.length > 32) throw new TeamError('result has too many artifacts', 'TEAM_INVALID_ARGUMENT')
      const result = {
        summary: requiredText(request.result.summary, 'summary', 16_384),
        artifacts: [...new Set(request.result.artifacts.map(value => requiredText(value, 'artifact', 512)))],
      }
      const next: TeamTaskSnapshot = { ...task, revision: task.revision + 1 }
      const nextReview: TeamManagedTaskState = { ...review, attempts: [
        ...review.attempts.slice(0, -1), { ...latest, status: 'submitted', result },
      ] }
      await this.appendManaged(root, [{ task: next, review: nextReview }])
      return this.taskView(root, this.journal.state(root), next)
    })
  }

  /**
   * Accept one submitted Attempt only while every captured prerequisite result remains current.
   * @param caller - exact live Team Lead.
   * @param membership - Lead authority resolved by the roster.
   * @param request - Task revision and submitted Attempt identity.
   * @returns completed Task view with a valid accepted result.
   */
  async acceptResult(
    caller: Agent, membership: TeamMembership, request: AcceptTeamTaskResultRequest,
  ): Promise<TeamTaskView> {
    if (membership.role !== 'lead' || membership.root !== caller) {
      throw new TeamError('only the Team Lead can accept Task results', 'TEAM_LEAD_REQUIRED')
    }
    const root = membership.root
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const task = this.currentTask(state, request.taskId, request.expectedRevision)
      const review = this.requireManaged(state, task.id)
      const latest = review.attempts.at(-1)
      if (task.status !== 'in_progress' || latest?.id !== request.attemptId
        || latest.status !== 'submitted' || latest.result === undefined) {
        throw new TeamError('Attempt has no submitted result to accept', 'TEAM_TASK_INVALID_TRANSITION')
      }
      this.assertInputs(state, task, latest)
      const next: TeamTaskSnapshot = { ...task, revision: task.revision + 1, status: 'completed' }
      const nextReview: TeamManagedTaskState = {
        ...review, validity: 'valid', attempts: [
          ...review.attempts.slice(0, -1), { ...latest, status: 'accepted' },
        ],
      }
      await this.appendManaged(root, [{ task: next, review: nextReview }])
      return this.taskView(root, this.journal.state(root), next)
    })
  }

  /**
   * Reject completed or submitted work as a new Task, keeping the original and marking downstream results stale.
   * Active downstream work must settle first; no dependency edges are inferred or redirected.
   * @param caller - exact live Team Lead.
   * @param membership - Lead authority resolved by the roster.
   * @param request - rejected Task CAS revision, reason, and explicit new prerequisites.
   * @returns the new pending replacement Task.
   */
  async rework(
    caller: Agent, membership: TeamMembership, request: ReworkTeamTaskRequest,
  ): Promise<TeamTaskView> {
    if (membership.role !== 'lead' || membership.root !== caller) {
      throw new TeamError('only the Team Lead can request quality rework', 'TEAM_LEAD_REQUIRED')
    }
    const root = membership.root
    return this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const task = this.currentTask(state, request.taskId, request.expectedRevision)
      const review = this.requireManaged(state, task.id)
      if (review.replacedByTaskId !== undefined) {
        throw new TeamError(`Task "${task.id}" already has a replacement`, 'TEAM_TASK_ALREADY_REWORKED')
      }
      const latest = review.attempts.at(-1)
      if (latest?.status !== 'submitted' && latest?.status !== 'accepted') {
        throw new TeamError('stop active work or submit a result before quality rework', 'TEAM_TASK_STOP_REQUIRED')
      }
      const reason = requiredText(request.reason, 'reason', 2_000)
      const activeCount = state.tasks.filter(candidate => candidate.status !== 'deleted').length
      if (activeCount >= this.maxTasks) throw new TeamError(`Team task limit ${this.maxTasks} reached`, 'TEAM_TASK_LIMIT')
      const id = TeamTaskId(`task-${state.nextTaskNumber}`)
      if (state.tasks.some(candidate => candidate.id === id)) throw new TeamError('Team task id space exhausted', 'TEAM_TASK_LIMIT')
      const blockedBy = this.dependencies(request.blockedBy, state, id)
      const replacement: TeamTaskSnapshot = {
        id, revision: 1, subject: task.subject, description: task.description,
        status: 'pending', blockedBy, writeScopes: [...task.writeScopes],
      }
      this.assertTaskGraph(state, replacement)
      const affected = this.dependents(state, task.id)
      const downstream: TeamManagedTaskUpdate[] = affected.map((candidate) => {
        const descendant = this.requireManaged(state, candidate.id)
        if (candidate.status === 'in_progress') {
          throw new TeamError(`stop dependent Task "${candidate.id}" before rework`, 'TEAM_TASK_DEPENDENT_ACTIVE')
        }
        return {
          task: { ...candidate, revision: candidate.revision + 1 },
          review: { ...descendant, validity: descendant.attempts.length > 0 ? 'stale' : descendant.validity },
        }
      })
      const oldTask: TeamTaskSnapshot = latest.status === 'submitted'
        ? this.withoutOwner({ ...task, revision: task.revision + 1, status: 'pending' })
        : { ...task, revision: task.revision + 1 }
      const oldReview: TeamManagedTaskState = {
        ...review, validity: 'stale', replacedByTaskId: id,
        attempts: latest.status === 'submitted'
          ? [...review.attempts.slice(0, -1), { ...latest, status: 'rejected', reason }]
          : review.attempts,
      }
      const newReview: TeamManagedTaskState = {
        attempts: [], validity: 'none', origin: { kind: 'rework', taskId: task.id, reason },
      }
      await this.appendManaged(root, [
        { task: oldTask, review: oldReview },
        { task: replacement, review: newReview },
        ...downstream,
      ])
      return this.taskView(root, this.journal.state(root), replacement)
    })
  }

  /** Resolve one exact Task revision before a result or rework transition. */
  private currentTask(state: TeamState, id: TeamTaskSnapshot['id'], revision: number): TeamTaskSnapshot {
    const task = state.tasks.find(candidate => candidate.id === id)
    if (task === undefined) throw new TeamError(`team task "${id}" not found`, 'TEAM_TASK_NOT_FOUND')
    if (task.status === 'deleted') throw new TeamError(`team task "${id}" is deleted`, 'TEAM_TASK_DELETED')
    if (task.revision !== revision) throw new TeamError(`stale team task "${id}" revision`, 'TEAM_TASK_STALE_REVISION')
    return task
  }

  /** Reject result operations on released, description-only Tasks. */
  private requireManaged(state: TeamState, id: TeamTaskSnapshot['id']): TeamManagedTaskState {
    const review = state.managed[id]
    if (review === undefined) throw new TeamError(`Task "${id}" has no managed result state`, 'TEAM_TASK_RESULT_UNAVAILABLE')
    return review
  }

  /** Recheck the exact prerequisite result revisions captured by the Attempt. */
  private assertInputs(state: TeamState, task: TeamTaskSnapshot, attempt: TeamTaskAttemptSnapshot): void {
    if (attempt.inputs.length !== task.blockedBy.length
      || attempt.inputs.some((input, index) => input.taskId !== task.blockedBy[index])) {
      throw new TeamError('Task prerequisites changed after the Attempt began', 'TEAM_TASK_STALE_INPUTS')
    }
    for (const input of attempt.inputs) {
      const blocker = state.tasks.find(candidate => candidate.id === input.taskId)
      if (blocker?.status !== 'completed' || blocker.revision !== input.revision
        || (state.managed[input.taskId] !== undefined && state.managed[input.taskId]?.validity !== 'valid')) {
        throw new TeamError(`prerequisite result "${input.taskId}" changed`, 'TEAM_TASK_STALE_INPUTS')
      }
    }
  }

  /** Traverse current explicit blockers without changing edges or inventing a final node. */
  private dependents(state: TeamState, id: TeamTaskSnapshot['id']): TeamTaskSnapshot[] {
    const visited = new Set<TeamTaskId>()
    const queue = [id]
    const result: TeamTaskSnapshot[] = []
    for (const blockerId of queue) {
      for (const candidate of state.tasks) {
        if (candidate.status === 'deleted' || visited.has(candidate.id) || !candidate.blockedBy.includes(blockerId)) continue
        if (state.managed[candidate.id] === undefined) {
          throw new TeamError(`legacy dependent Task "${candidate.id}" cannot be invalidated automatically`, 'TEAM_TASK_LEGACY_DEPENDENT')
        }
        visited.add(candidate.id)
        queue.push(candidate.id)
        result.push(candidate)
      }
    }
    return result
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

  /** Whether all current blockers completed. */
  private taskReady(state: TeamState, task: TeamTaskSnapshot): boolean {
    return state.managed[task.id]?.replacedByTaskId === undefined
      && task.blockedBy.every(id => state.tasks.find(candidate => candidate.id === id)?.status === 'completed'
      && (state.managed[id] === undefined || state.managed[id].validity === 'valid'))
  }

  /** Refuse legacy edits that cannot atomically invalidate managed descendants. */
  private assertNoManagedDependents(state: TeamState, id: TeamTaskId): void {
    const visited = new Set<TeamTaskId>()
    const queue = [id]
    for (const blockerId of queue) {
      for (const task of state.tasks) {
        if (task.status === 'deleted' || visited.has(task.id) || !task.blockedBy.includes(blockerId)) continue
        if (state.managed[task.id] !== undefined) {
          throw new TeamError(`legacy Task "${id}" has managed dependent "${task.id}"`, 'TEAM_TASK_MANAGED_DEPENDENTS')
        }
        visited.add(task.id)
        queue.push(task.id)
      }
    }
  }

  /** Remove an optional owner field under exactOptionalPropertyTypes. */
  private withoutOwner(task: TeamTaskSnapshot): TeamTaskSnapshot {
    const { ownerId: _ownerId, ...without } = task
    return without
  }

  /**
   * Build one task view with owner name, readiness, and advisory write overlaps.
   * A committing caller may pass its pre-append state because `task` supplies the
   * new value explicitly; owner names, blocker readiness, and other task scopes
   * do not change when that snapshot is appended.
   */
  private taskView(root: Agent, state: TeamState, task: TeamTaskSnapshot): TeamTaskView {
    const ownerName = task.ownerId === undefined
      ? undefined
      : task.ownerId === root.id
        ? 'lead'
        : state.members.find(member => member.id === task.ownerId)?.name
    const warnings = new Set<string>()
    const managed = state.managed[task.id]
    const review: TeamTaskReviewView | undefined = managed === undefined ? undefined : {
      validity: managed.validity,
      attempts: managed.attempts.map((attempt) => {
        const attemptOwner = attempt.ownerId === root.id ? 'lead'
          : state.members.find(member => member.id === attempt.ownerId)?.name
        return {
          id: attempt.id,
          status: attempt.status,
          inputs: structuredClone(attempt.inputs),
          ...attemptOwner === undefined ? {} : { ownerName: attemptOwner },
          ...attempt.result === undefined ? {} : { result: structuredClone(attempt.result) },
          ...attempt.reason === undefined ? {} : { reason: attempt.reason },
        }
      }),
      ...managed.origin === undefined ? {} : { origin: structuredClone(managed.origin) },
      ...managed.replacedByTaskId === undefined ? {} : { replacedByTaskId: managed.replacedByTaskId },
    }
    for (const other of state.tasks) {
      if (other.id === task.id || other.status !== 'in_progress') continue
      if (task.writeScopes.some(left => other.writeScopes.some(right => scopesOverlap(left, right)))) {
        warnings.add(`write scopes overlap with ${other.id}`)
      }
    }
    return {
      id: task.id,
      revision: task.revision,
      subject: task.subject,
      description: task.description,
      status: task.status,
      blockedBy: structuredClone(task.blockedBy),
      writeScopes: structuredClone(task.writeScopes),
      ...ownerName === undefined ? {} : { ownerName },
      ready: task.status === 'pending' && this.taskReady(state, task),
      writeScopeWarnings: [...warnings],
      ...review === undefined ? {} : { review },
    }
  }
}
