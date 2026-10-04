/** Shared Team task DAG commands and runtime-enriched views. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentSettlementNoticeFacts } from '@deepseek-ai/dsh-subagent'
import type { TeamMembership } from './roster.ts'
import { TeamError } from './error.ts'
import { teamMessageDeliveryBytes } from './mailbox.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamState } from './projection.ts'
import { resolveActiveMember } from './roster.ts'
import { assertTaskGraphCandidate, TeamTaskGraphError } from './task-graph.ts'
import type { TeamTaskGraphViolation } from './task-graph.ts'
import { applyTaskTransaction, TeamTaskTransactionError } from './task-transaction.ts'
import type {
  TeamExtensionRecordBuilder, TeamTaskExtension, TeamTaskExtensionHandle, TeamTaskTransactionBuilder,
} from './task-extension.ts'
import { TeamId, TeamTaskId } from './types.ts'
import type {
  CreateTeamTaskRequest,
  TeamExtensionNotice,
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
    private readonly anchorForRead: (agent: Agent) => Agent,
  ) {}

  /** Check the currently installed writer after an asynchronous checkpoint. */
  private isCurrentWriter(writer: TeamTaskExtension): boolean {
    return this.extension?.writer === writer
  }

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
      read: async (anchor, read) => await this.journal.transact(anchor.id, async () => {
        if (this.isDisposed() || this.extension?.writer !== writer || this.anchorForRead(anchor) !== anchor) {
          throw new TeamError('Task reader no longer owns the live Team anchor', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
        }
        const state = this.journal.state(anchor)
        if (state.mode !== undefined && state.mode.requiredTaskExtensionId !== id) {
          throw new TeamError('Task reader does not match the bound writer', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
        }
        if (writer.requireDurableAcknowledgement) {
          await this.journal.confirmPending(anchor)
          if (this.isDisposed() || !this.isCurrentWriter(writer) || this.anchorForRead(anchor) !== anchor) {
            throw new TeamError('Task reader changed during checkpoint confirmation', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
          }
        }
        return Promise.resolve(read(this.snapshot(state)))
      }),
      commit: async (caller, build) => await this.commitExtension(writer, id, caller, build),
      commitRecord: async (caller, build) => await this.commitExtensionRecord(writer, id, caller, build),
      dispose: () => { if (this.extension?.handle === handle) this.extension = undefined },
    }
    this.extension = { writer, handle }
    return handle
  }

  /** Ask only the currently registered Task writer for Lead-release audit material.
   * @param anchor - exact live Team journal owner.
   * @param state - locked authoritative native state.
   * @param releases - validated prepared native releases.
   * @returns registered writer identity, bounded audit JSON and its final live-owner check.
   */
  planLeadRelease(anchor: Agent, state: TeamState, releases: readonly TeamTaskTransactionUpdate[]): {
    id: string
    dataJson: string
    assertCurrent: () => void
  } {
    const owner = this.leadReleaseOwner(state)
    const dataJson = owner.plan(anchor, this.snapshot(state), structuredClone(releases))
    if (Buffer.byteLength(dataJson, 'utf8') > this.maxTaskExtensionBytes) {
      throw new TeamError('Lead release audit exceeds the Task extension byte limit', 'TEAM_TASK_EXTENSION_TOO_LARGE')
    }
    try { JSON.parse(dataJson) } catch {
      throw new TeamError('Lead release audit must be valid JSON', 'TEAM_TASK_EXTENSION_INVALID')
    }
    return { id: owner.id, dataJson, assertCurrent: owner.assertCurrent }
  }

  /** Retain the current writer generation for a fresh commit or durable retry.
   * @param state - locked authoritative native state selecting the required writer.
   * @returns the registered planner and live-owner check, granting no Task or journal write access.
   */
  leadReleaseOwner(state: TeamState): {
    id: string
    plan: NonNullable<TeamTaskExtension['planLeadRelease']>
    assertCurrent: () => void
  } {
    const extension = this.extension
    if (this.isDisposed() || extension === undefined || extension.writer.id !== state.mode?.requiredTaskExtensionId
      || extension.writer.planLeadRelease === undefined) {
      throw new TeamError('Lead releases require the registered Task writer', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
    }
    return { id: extension.writer.id, plan: extension.writer.planLeadRelease.bind(extension.writer), assertCurrent: () => {
      if (this.isDisposed() || this.extension !== extension) {
        throw new TeamError('Lead release writer changed before acknowledgement', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
      }
    } }
  }

  private snapshot(state: TeamState): import('./types.ts').TeamTaskTransactionSnapshot {
    return { tasks: structuredClone(state.tasks), members: structuredClone(state.members),
      ...state.composition === undefined ? {} : { composition: structuredClone(state.composition) },
      nextTaskNumber: state.nextTaskNumber }
  }

  /**
   * Let only the bound product writer account for a controlled member's completed run.
   * @param root - exact live Lead whose pinned mode selects the Task writer.
   * @param facts - flushed child-log interval for this one Activation.
   * @returns an explicit notice decision, or undefined when the native notice must remain.
   */
  async assessSettlementNotice(
    root: Agent, facts: SubagentSettlementNoticeFacts,
  ): Promise<'send' | 'suppress' | undefined> {
    const mode = this.journal.state(root).mode
    const extension = this.extension
    if (mode === undefined || extension?.writer.id !== mode.requiredTaskExtensionId) return undefined
    return await extension.writer.assessSettlementNotice?.(facts)
  }

  /**
   * Read optional product Task ids for one member's native settlement wording.
   * @param root - exact live Lead with the pinned Task extension.
   * @param facts - one member Activation's durable identity and log interval.
   * @returns started but unsubmitted Task ids, or undefined without an answering product writer.
   */
  async unsubmittedTaskIds(root: Agent, facts: SubagentSettlementNoticeFacts): Promise<readonly TeamTaskId[] | undefined> {
    const mode = this.journal.state(root).mode
    const extension = this.extension
    if (mode === undefined || extension?.writer.id !== mode.requiredTaskExtensionId) return undefined
    return await extension.writer.unsubmittedTaskIds?.(facts)
  }

  /**
   * Apply the configured Task extension's member-group admission under the roster lock.
   * @param caller - exact live Lead creating a member.
   * @param group - proposed optional member group.
   */
  validateMemberGroup(caller: Agent, group: string | undefined): void {
    const membership = this.membershipOf(caller)
    const mode = this.journal.state(membership.root).mode
    if (mode === undefined) return
    const extension = this.extension
    if (extension === undefined || extension.writer.id !== mode.requiredTaskExtensionId
      || extension.writer.validateMemberGroup === undefined) {
      throw new TeamError('controlled member creation requires its Task policy; no member was created',
        'TEAM_TASK_EXTENSION_UNAVAILABLE')
    }
    extension.writer.validateMemberGroup(caller, group)
  }

  /**
   * Product-owned next-action hints after a controlled member releases work.
   * @param caller - exact live member.
   * @returns extension-supplied text without native Team interpretation.
   */
  extensionReleaseHints(caller: Agent): readonly string[] {
    return this.extension?.writer.releaseHints?.(caller) ?? []
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
      const state = this.journal.assertCallerWrite(root, caller)
      if (state.mode !== undefined) {
        throw new TeamError('controlled Task writer is unavailable', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
      }
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
      const state = this.journal.assertCallerWrite(root, caller)
      if (state.mode !== undefined) {
        throw new TeamError('controlled Task writer is unavailable', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
      }
      const current = state.tasks.find(task => task.id === request.taskId)
      if (current === undefined) throw new TeamError(`team task "${request.taskId}" not found`, 'TEAM_TASK_NOT_FOUND')
      if (state.taskWriters.some(writer => writer.taskId === current.id)) {
        throw new TeamError(`team task "${current.id}" requires its extension writer`, 'TEAM_TASK_EXTENSION_UNAVAILABLE')
      }
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
      const state = this.journal.assertCallerWrite(root, caller)
      if (state.mode !== undefined && state.mode.requiredTaskExtensionId !== extensionId) {
        throw new TeamError('controlled Task writer does not match the persisted mode', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
      }
      if (writer.requireDurableAcknowledgement) {
        await this.journal.confirmPending(root)
        if (this.isDisposed() || !this.isCurrentWriter(writer)) {
          throw new TeamError('Task writer changed during checkpoint confirmation', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
        }
      }
      const plan = build({
        tasks: structuredClone(state.tasks),
        members: structuredClone(state.members),
        ...state.composition === undefined ? {} : { composition: structuredClone(state.composition) },
        nextTaskNumber: state.nextTaskNumber,
      })
      if ('existingTaskIds' in plan) {
        if (plan.existingTaskIds.length === 0 || new Set(plan.existingTaskIds).size !== plan.existingTaskIds.length) {
          throw new TeamError('existing Task result needs distinct Task ids', 'TEAM_INVALID_ARGUMENT')
        }
        const views = plan.existingTaskIds.map((id) => {
          const task = state.tasks.find(candidate => candidate.id === id)
          if (task === undefined || !state.taskWriters.some(owner => owner.taskId === id && owner.writerId === extensionId)) {
            throw new TeamError(`existing Task "${id}" does not belong to this writer`, 'TEAM_TASK_EXTENSION_UNAVAILABLE')
          }
          return projectTaskView(state, task)
        })
        return { views, hasNotices: false }
      }
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
        const owner = state.taskWriters.find(writer => writer.taskId === update.task.id)?.writerId
        if (owner !== undefined && owner !== extensionId) {
          throw new TeamError(`Task "${update.task.id}" belongs to another extension writer`, 'TEAM_TASK_EXTENSION_UNAVAILABLE')
        }
        const ownerId = update.task.ownerId
        if (update.task.status === 'in_progress' && ownerId === undefined) {
          throw new TeamError(`in-progress Task "${update.task.id}" needs an owner`, 'TEAM_INVALID_ARGUMENT')
        }
        if (ownerId !== undefined && ownerId !== prior?.ownerId && ownerId !== root.id
          && !state.members.some(member => member.id === ownerId && member.phase === 'active')) {
          throw new TeamError(`Task "${update.task.id}" owner is not active`, 'TEAM_MEMBER_NOT_FOUND')
        }
      }
      if (plan.allowLeadSelfNotices && (plan.notices ?? []).some(notice => notice.targetId === root.id
        && (notice.contentParts?.length !== notice.content.length || notice.contentParts.some(part => part !== 'fact')
          || notice.contentAuthors?.some(author => author !== null)))) {
        throw new TeamError('Lead self notices must contain only attributed facts', 'TEAM_INVALID_ARGUMENT')
      }
      const notices = this.validateExtensionNotices(state, caller, root, plan.notices ?? [], plan.allowLeadSelfNotices)
      await this.journal.appendAndFlush(root, 'team/task/transaction', {
        version: 1, teamId: TeamId(root.id), updates,
        extension: { id: extensionId, dataJson: plan.dataJson },
        ...notices.length === 0 ? {} : { notices },
      }, writer.requireDurableAcknowledgement)
      const committed = this.journal.state(root)
      return { views: updates.map(update => projectTaskView(committed, update.task)), hasNotices: notices.length > 0 }
    })
    if (result.hasNotices) this.dispatchNotices(root)
    return result.views
  }

  /** Write an extension-owned record without inventing a Task mutation. */
  private async commitExtensionRecord(
    writer: TeamTaskExtension,
    extensionId: string,
    caller: Agent,
    build: TeamExtensionRecordBuilder,
  ): Promise<{ recordId: string; committed: boolean }> {
    if (this.isDisposed() || this.extension?.writer !== writer) {
      throw new TeamError('Team Task extension is unavailable', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
    }
    const root = this.membershipOf(caller).root
    const result = await this.journal.transact(root.id, async () => {
      if (this.isDisposed() || this.extension?.writer !== writer || this.membershipOf(caller).root !== root) {
        throw new TeamError('Team Task extension changed during record transaction', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
      }
      const state = this.journal.assertCallerWrite(root, caller)
      if (state.mode !== undefined && state.mode.requiredTaskExtensionId !== extensionId) {
        throw new TeamError('controlled Task writer does not match the persisted mode', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
      }
      if (writer.requireDurableAcknowledgement) {
        await this.journal.confirmPending(root)
        if (this.isDisposed() || !this.isCurrentWriter(writer)) {
          throw new TeamError('Task writer changed during checkpoint confirmation', 'TEAM_TASK_EXTENSION_UNAVAILABLE')
        }
      }
      const records = state.extensionRecords.filter(record => record.writerId === extensionId)
        .map(({ recordId, dataJson }) => ({ recordId, dataJson }))
      const plan = build({
        tasks: structuredClone(state.tasks), members: structuredClone(state.members),
        ...state.composition === undefined ? {} : { composition: structuredClone(state.composition) },
        nextTaskNumber: state.nextTaskNumber, records: structuredClone(records),
      })
      if ('skip' in plan) return { recordId: '', committed: false, hasNotices: false }
      if ('existingRecordId' in plan) {
        if (!records.some(record => record.recordId === plan.existingRecordId)) {
          throw new TeamError(`extension record "${plan.existingRecordId}" does not exist`, 'TEAM_INVALID_ARGUMENT')
        }
        return { recordId: plan.existingRecordId, committed: false, hasNotices: false }
      }
      const recordId = requiredText(plan.recordId, 'extension record id', 200)
      if (records.some(record => record.recordId === recordId)) {
        throw new TeamError(`extension record "${recordId}" already exists`, 'TEAM_INVALID_ARGUMENT')
      }
      if (Buffer.byteLength(plan.dataJson, 'utf8') > this.maxTaskExtensionBytes) {
        throw new TeamError(`Team extension data exceeds ${this.maxTaskExtensionBytes} bytes`, 'TEAM_TASK_EXTENSION_TOO_LARGE')
      }
      try { JSON.parse(plan.dataJson) } catch {
        throw new TeamError('Team extension data must be valid JSON', 'TEAM_TASK_EXTENSION_INVALID')
      }
      const notices = this.validateExtensionNotices(state, caller, root, plan.notices ?? [], caller.id === root.id)
      await this.journal.appendAndFlush(root, 'team/extension', {
        version: 1, teamId: TeamId(root.id), extension: { id: extensionId, recordId, dataJson: plan.dataJson },
        ...notices.length === 0 ? {} : { notices },
        ...plan.affectsComposition === true ? { affectsComposition: true as const } : {},
      }, writer.requireDurableAcknowledgement)
      return { recordId, committed: true, hasNotices: notices.length > 0 }
    })
    if (result.hasNotices) this.dispatchNotices(root)
    return { recordId: result.recordId, committed: result.committed }
  }

  private validateExtensionNotices(
    state: TeamState,
    caller: Agent,
    root: Agent,
    proposed: readonly TeamExtensionNotice[],
    allowLeadSelf = false,
  ): TeamMessageSnapshot[] {
    const notices: TeamMessageSnapshot[] = proposed.map(({ ordinaryMessageLimit: _limit, ...notice }) =>
      structuredClone(notice))
    const seen = new Set<string>()
    const sender = this.membershipOf(caller)
    for (const [index, notice] of notices.entries()) {
      if ('transfer' in notice) throw new TeamError('Task notices cannot create source input custody', 'TEAM_INVALID_ARGUMENT')
      if (notice.senderId !== caller.id || notice.senderName !== sender.name
        || notice.targetId === caller.id && !(allowLeadSelf && caller.id === root.id)) {
        throw new TeamError(`Task notice "${notice.id}" has an invalid sender or target`, 'TEAM_INVALID_ARGUMENT')
      }
      const term = sender.role === 'lead' ? sender.term ?? 1 : undefined
      if (notice.senderTerm !== undefined && notice.senderTerm !== term) {
        throw new TeamError('Task notice cannot choose its sender term', 'TEAM_INVALID_ARGUMENT')
      }
      const authors = notice.contentAuthors ?? notice.content.map((block, offset) =>
        term !== undefined && block.type === 'text' && notice.contentParts?.[offset] === 'sender'
          ? { executionId: caller.id, term } : null)
      if (authors.length !== notice.content.length || authors.some((author, offset) => author !== null
        && (notice.content[offset]?.type !== 'text'
          || !(author.executionId === root.id && author.term === 1)
            && !state.leadHistory?.some(binding => binding.executionId === author.executionId && binding.term === author.term)))) {
        throw new TeamError('Task notice content author does not match a legitimate Lead term', 'TEAM_INVALID_ARGUMENT')
      }
      if (state.mode !== undefined) notices[index] = { ...notice,
        ...term === undefined ? {} : { senderTerm: term }, contentAuthors: authors }
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
        + notices.filter((candidate, candidateIndex) => candidate.targetId === notice.targetId && candidateIndex !== index).length
      if (pending >= this.maxPendingMessagesPerMember) {
        throw new TeamError('Task notice target has too many pending messages', 'TEAM_MAILBOX_FULL')
      }
      const bytes = teamMessageDeliveryBytes(notice)
      const ordinaryLimit = proposed[index]?.ordinaryMessageLimit === true
        ? state.mode?.maxOrdinaryMessageBytes : undefined
      if (ordinaryLimit !== undefined && bytes > ordinaryLimit) {
        throw new TeamError(`ordinary Team message exceeds ${ordinaryLimit} bytes; submit Task results for Lead acceptance and pass accepted results through Task prerequisites`, 'TEAM_MESSAGE_TOO_LARGE')
      }
      if (teamMessageDeliveryBytes(notice, state) > this.maxMessageBytes) {
        throw new TeamError(`Task notice "${notice.id}" exceeds ${this.maxMessageBytes} bytes`, 'TEAM_MESSAGE_TOO_LARGE')
      }
    }
    return notices
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
