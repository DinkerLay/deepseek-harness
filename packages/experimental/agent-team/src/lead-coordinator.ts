/** Registered Host coordination over native admission, maintenance and atomic seat commits. */

import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { TeamExtensionRecord, TeamExtensionNotice, TeamLeadOperationId,
  TeamTaskTransactionSnapshot, TeamTaskTransactionUpdate } from './types.ts'
import { TeamId } from './types.ts'
import type { TeamLeadBinding, TeamLeadSeat } from './lead-seat.ts'
import { TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import { applyLeadTransition } from './lead-coordination.ts'
import type { TeamLeadTransition } from './lead-coordination.ts'
import { cancellable } from './lead-runtime.ts'
import type { TeamLeadExecutions } from './lead-runtime.ts'
import { teamProjectionDefinition } from './projection.ts'
import type { TeamState } from './projection.ts'
import type { TeamTaskBoard } from './task-board.ts'
import { teamMessageDeliveryBytes } from './mailbox.ts'
import { requiredText } from './validation.ts'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left < right ? -1 : 1)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

interface LeadOccupation { readonly abort: AbortController; readonly execution: Agent }

/** Registered Host owner; it is never a model Lead identity. */
export interface TeamLeadCoordinator { readonly id: string }

/** Opaque product record and non-authorizing logical Lead material. */
export interface TeamLeadCoordinatorMaterial extends TeamExtensionRecord {
  /** Non-authorizing logical Lead notices committed with this opaque record. */
  readonly notices?: readonly TeamExtensionNotice[]
}

/** Opaque material scoped to one coordinator operation and optional native transition. */
export interface TeamLeadCoordinatorRecord extends TeamLeadCoordinatorMaterial {
  readonly operationId: TeamLeadOperationId
  readonly previousTerm: number
  readonly phase?: TeamLeadTransition['phase']
}

/** Native operation identity selecting one synchronous record-planning cut. */
export type TeamLeadCoordinatorOperation = Pick<TeamLeadCoordinatorRecord, 'operationId' | 'previousTerm' | 'phase'>

/** Detached read state offered only to the installed coordinator while the Team lock is held. */
export interface TeamLeadCoordinatorSnapshot extends TeamTaskTransactionSnapshot {
  readonly seat: TeamLeadSeat
  readonly records: readonly TeamExtensionRecord[]
}

/** Bounded synchronous product planner; it must not enter another Team transaction. */
export type TeamLeadCoordinatorRecordBuilder = (snapshot: TeamLeadCoordinatorSnapshot) => TeamLeadCoordinatorMaterial

/** Generic safety observation supplied by the owning product, before waiting for idle. */
export interface TeamLeadBlocker { readonly id: string; readonly description: string }

/** Exact prepared atomic effects; Task audit is produced by the bound Task writer. */
export interface TeamLeadCoordinatorCommit {
  readonly binding: TeamLeadBinding
  readonly releases: readonly TeamTaskTransactionUpdate[]
  readonly record: TeamExtensionRecord
  /** Coordinator-created material only; captured source input uses the native custody queue. */
  readonly notices?: readonly TeamExtensionNotice[]
}

/** Capability valid only inside the maintenance callback that acquired the old execution. */
export interface TeamLeadSafePointHandle {
  readonly execution: Agent
  readonly signal: AbortSignal
  /** Persist product preparation while retaining the occupied old execution.
   * @param record - independent product audit material.
   * @param prepared - whether this record fixes the prepared native phase.
   * @returns completion after the source checkpoint succeeds.
   */
  record(record: TeamExtensionRecord, prepared?: boolean): Promise<void>
  /** Commit the seat, every prepared Lead Task release, independent audit and material atomically.
   * @param plan - exact immutable candidate and prepared effects.
   * @returns the durably confirmed current native seat.
   */
  commitLeadTransaction(plan: TeamLeadCoordinatorCommit): Promise<TeamLeadSeat>
}

/** Owned coordination capability, absent from model tools and ordinary Lead authority. */
export interface TeamLeadCoordinatorHandle {
  /** Persist an independent record or transition after locked owner and term checks.
   * @param anchor - exact live stable Team journal owner.
   * @param record - operation-scoped material and optional native phase.
   * @returns completion after the source checkpoint succeeds.
   */
  record(anchor: Agent, record: TeamLeadCoordinatorRecord): Promise<void>
  /** Capture product facts immediately before this record is appended under the native lock.
   * @param anchor - exact live stable Team journal owner.
   * @param operation - immutable operation identity and optional native phase.
   * @param build - bounded synchronous observer and material builder.
   * @returns completion after the source checkpoint succeeds.
   */
  record(anchor: Agent, operation: TeamLeadCoordinatorOperation, build: TeamLeadCoordinatorRecordBuilder): Promise<void>
  /**
   * Observe blockers before idle, recheck them after idle and occupation, then record the safe point.
   * @param anchor - exact live stable Team journal owner.
   * @param request - operation identity, safe audit, bounded observer and optional caller cancellation.
   * @param task - product preparation under the old execution's maintenance lifetime.
   * @returns the callback result; blocked or busy execution never records a safe point.
   */
  runAtSafePoint<T>(anchor: Agent, request: {
    readonly operationId: TeamLeadOperationId
    readonly previousTerm: number
    readonly record: TeamExtensionRecord
    readonly readBlockers: (execution: Agent) => readonly TeamLeadBlocker[] | Promise<readonly TeamLeadBlocker[]>
    readonly signal?: AbortSignal
  }, task: (handle: TeamLeadSafePointHandle) => Promise<T>): Promise<T>
  /** Close admission, abort waits and drain this registration's maintenance work.
   * @returns completion after owned waits and maintenance callbacks are settled.
   */
  dispose(): Promise<void>
}

/** Owns the single optional Host registrar without exposing the native journal. */
export class TeamLeadCoordinators {
  private registration: TeamLeadCoordinatorHandle | undefined

  /** @param ctx - owning native service context.
   * @param journal - serialized authoritative Team journal.
   * @param executions - existing ordinary execution and input owner.
   * @param tasks - current native Task writer owner.
   * @param limits - existing deployment limits for complete retained records and material.
   */
  constructor(private readonly ctx: Context, private readonly journal: TeamJournal,
    private readonly executions: TeamLeadExecutions, private readonly tasks: TeamTaskBoard,
    private readonly limits: {
      readonly maxTaskExtensionBytes: number
      readonly maxMessageBytes: number
      readonly maxPendingMessagesPerMember: number }) {}

  /** Register one independent Host coordinator.
   * @param coordinator - stable opaque record namespace, distinct from the Task writer.
   * @returns owned operations and asynchronous quiescent disposal.
   */
  install(coordinator: TeamLeadCoordinator): TeamLeadCoordinatorHandle {
    if (this.registration !== undefined) throw new TeamError('Lead coordinator is already installed', 'TEAM_LEAD_COORDINATOR_CONFLICT')
    const id = requiredText(coordinator.id, 'coordinator id', 200)
    const lifetime = new AbortController()
    const jobs = new Set<Promise<unknown>>()
    const scopes = new Map<Agent, LeadOccupation>()
    const assertOwner = (anchor: Agent, signal = lifetime.signal): TeamState => {
      signal.throwIfAborted()
      if (this.ctx.agents.get(anchor.id) !== anchor
        || this.executions.anchorForRead(anchor) !== anchor) throw new TeamError('Lead coordinator has no live anchor', 'TEAM_NOT_MEMBER')
      const state = this.journal.assertWriteAdmission(anchor)
      if (state.mode?.requiredTaskExtensionId === id) {
        throw new TeamError('Lead coordination needs an independent controlled record owner', 'TEAM_LEAD_COORDINATOR_INVALID')
      }
      return state
    }
    const own = <T>(operation: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> => {
      const signal = caller === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, caller])
      const result = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal) })
      jobs.add(result)
      void result.then(() => jobs.delete(result), () => jobs.delete(result))
      return result
    }
    const operationState = (anchor: Agent, operationId: TeamLeadOperationId, previousTerm: number, signal: AbortSignal) => {
      const state = assertOwner(anchor, signal)
      const current = state.leadCoordination
      if (current?.coordinatorId !== id || current.operationId !== operationId || current.previousTerm !== previousTerm) {
        throw new TeamError('Lead coordinator does not own this operation', 'TEAM_LEAD_STALE_TERM')
      }
      return { state, current }
    }
    const record = (anchor: Agent, operation: TeamLeadCoordinatorOperation, signal: AbortSignal,
      build: TeamLeadCoordinatorRecordBuilder, scope?: LeadOccupation): Promise<void> => this.journal.transact(anchor.id, async () => {
      const state = assertOwner(anchor, signal)
      const material = build({ seat: { ...this.executions.seat(anchor) },
        tasks: structuredClone(state.tasks), members: structuredClone(state.members), nextTaskNumber: state.nextTaskNumber,
        ...state.composition === undefined ? {} : { composition: structuredClone(state.composition) },
        records: state.extensionRecords.filter(item => item.writerId === id).map(({ recordId, dataJson }) => ({ recordId, dataJson })) })
      const plan: TeamLeadCoordinatorRecord = { ...operation, recordId: material.recordId, dataJson: material.dataJson }
      this.validateRecord(plan)
      const notices = this.materialNotices(anchor, state, material.notices ?? [])
      if ((plan.phase === 'safe' || plan.phase === 'prepared') && (scope === undefined || scopes.get(anchor) !== scope
        || this.ctx.agents.get(scope.execution.id) !== scope.execution)) {
        throw new TeamError('Safe records require the occupied old execution', 'TEAM_LEAD_SAFE_POINT_REQUIRED')
      }
      const existing = state.extensionRecords.find(item => item.writerId === id && item.recordId === plan.recordId)
      if (existing !== undefined) {
        if (existing.dataJson !== plan.dataJson || existing.coordinatorOperation?.operationId !== plan.operationId
          || existing.coordinatorOperation.previousTerm !== plan.previousTerm || existing.leadTransition?.phase !== plan.phase) {
          throw new TeamError('Coordinator record identity has different material or operation', 'TEAM_INVALID_ARGUMENT')
        }
        const previousNotices = state.messages.filter(message => existing.noticeIds?.includes(message.id))
        if (!isDeepStrictEqual(previousNotices, notices)) {
          throw new TeamError('Coordinator record identity has different notices', 'TEAM_INVALID_ARGUMENT')
        }
        await this.journal.confirm(anchor)
        assertOwner(anchor, signal)
        return
      }
      const current = state.leadCoordination
      requiredText(plan.operationId, 'coordinator operation id', 200)
      if (!Number.isSafeInteger(plan.previousTerm) || plan.previousTerm < 1) {
        throw new TeamError('Coordinator term must be a positive safe integer', 'TEAM_INVALID_ARGUMENT')
      }
      const transition: TeamLeadTransition | undefined = plan.phase === undefined ? undefined : {
        operationId: plan.operationId, previousTerm: plan.previousTerm,
        previousExecutionId: plan.phase === 'requested'
          ? this.executions.seat(anchor).executionId
          : operationState(anchor, plan.operationId, plan.previousTerm, signal).current.previousExecutionId,
        phase: plan.phase,
      }
      if (transition === undefined) operationState(anchor, plan.operationId, plan.previousTerm, signal)
      else applyLeadTransition(state, id, transition)
      this.assertMaterialCapacity(anchor, state, notices.length)
      const data = { version: 1 as const, teamId: TeamId(anchor.id),
        extension: { id, recordId: plan.recordId, dataJson: plan.dataJson },
        coordinatorOperation: { operationId: plan.operationId, previousTerm: plan.previousTerm },
        ...transition === undefined ? {} : { leadTransition: transition },
        ...notices.length === 0 ? {} : { notices } }
      const next = teamProjectionDefinition.apply(state, { type: 'team/extension', data,
        seq: SessionSeq(anchor.session.seq), time: Date.now() })
      if (next.failure !== undefined) throw new TeamError(next.failure, 'TEAM_LEAD_COORDINATOR_INVALID')
      await this.journal.appendAndFlush(anchor, 'team/extension', data, true,
        plan.phase === 'ready' || plan.phase === 'cancelled' || plan.phase === 'failed')
      assertOwner(anchor, signal)
      if (current !== undefined && (plan.phase === 'cancelled' || plan.phase === 'failed')) {
        scopes.get(anchor)?.abort.abort(new TeamError('Lead coordination ended before commit', 'TEAM_LEAD_CANCELLED'))
      }
    })
    const commit = async (anchor: Agent, operationId: TeamLeadOperationId, previousTerm: number, scope: LeadOccupation,
      signal: AbortSignal, plan: TeamLeadCoordinatorCommit): Promise<TeamLeadSeat> => await this.journal.transact(anchor.id, async () => {
      if (scopes.get(anchor) !== scope || this.ctx.agents.get(scope.execution.id) !== scope.execution) {
        throw new TeamError('Lead maintenance capability has expired', 'TEAM_LEAD_SAFE_POINT_REQUIRED')
      }
      const { state, current } = operationState(anchor, operationId, previousTerm, signal)
      this.validateRecord(plan.record)
      const notices = this.materialNotices(anchor, state, plan.notices ?? [])
      const effectsHash = createHash('sha256').update(canonical({ binding: plan.binding, releases: plan.releases,
        record: { recordId: plan.record.recordId, dataJson: plan.record.dataJson }, notices, preloadNoticesFirst: true })).digest('hex')
      const existing = state.extensionRecords.find(item => item.writerId === id && item.recordId === plan.record.recordId)
      if (existing !== undefined) {
        if (existing.dataJson !== plan.record.dataJson || !isDeepStrictEqual(state.lead, plan.binding)
          || current.phase !== 'committed' || existing.leadEffectsHash !== effectsHash) {
          throw new TeamError('Lead commit identity conflicts with the current operation', 'TEAM_INVALID_ARGUMENT')
        }
        const taskOwner = this.tasks.leadReleaseOwner(state)
        await this.journal.confirm(anchor)
        assertOwner(anchor, signal)
        taskOwner.assertCurrent()
        return { ...plan.binding }
      }
      if (current.phase !== 'prepared' || this.executions.seat(anchor).term !== previousTerm) {
        throw new TeamError('Lead commit requires the current prepared safe point', 'TEAM_LEAD_SAFE_POINT_REQUIRED')
      }
      const release = this.tasks.planLeadRelease(anchor, state, plan.releases)
      const extension = { id: release.id, dataJson: release.dataJson }
      this.assertMaterialCapacity(anchor, state, notices.length)
      const data = { version: 1 as const, teamId: TeamId(anchor.id), previousTerm, binding: structuredClone(plan.binding),
        extension, releases: structuredClone([...plan.releases]), notices,
        preloadNoticesFirst: true as const,
        handoffRecord: { id, recordId: plan.record.recordId, dataJson: plan.record.dataJson, effectsHash } }
      const next = teamProjectionDefinition.apply(state, { type: 'team/lead/transaction', data,
        seq: SessionSeq(anchor.session.seq), time: Date.now() })
      if (next.failure !== undefined) throw new TeamError(next.failure, 'TEAM_LEAD_TRANSACTION_INVALID')
      const candidate = this.ctx.agents.get(plan.binding.executionId)
      if (candidate === undefined || !this.executions.matchesBinding(candidate, anchor, plan.binding)) {
        throw new TeamError('Lead candidate does not match its durable identity', 'TEAM_LEAD_IDENTITY_INVALID')
      }
      release.assertCurrent()
      await this.journal.appendAndFlush(anchor, 'team/lead/transaction', data, true)
      assertOwner(anchor, signal)
      release.assertCurrent()
      return { ...plan.binding }
    })
    const handle: TeamLeadCoordinatorHandle = {
      record: (anchor, ...args: [TeamLeadCoordinatorRecord] | [TeamLeadCoordinatorOperation, TeamLeadCoordinatorRecordBuilder]) => {
        if (args.length === 1) {
          const plan = args[0]
          return own(signal => record(anchor, plan, signal, () => plan))
        }
        const [operation, build] = args
        return own(signal => record(anchor, operation, signal, build))
      },
      runAtSafePoint: (anchor, request, task) => own(async (signal) => {
        const { current } = await this.journal.transact(anchor.id,
          () => Promise.resolve(operationState(anchor, request.operationId, request.previousTerm, signal)))
        if (current.phase !== 'frozen' && current.phase !== 'safe' && current.phase !== 'prepared') {
          throw new TeamError('Safe-point occupation requires a frozen incumbent', 'TEAM_LEAD_SAFE_POINT_REQUIRED')
        }
        const context = await cancellable(this.executions.resolveCurrent(anchor, signal), signal)
        const old = context.execution
        if (old === undefined || context.seat.executionId !== current.previousExecutionId || context.seat.term !== request.previousTerm) {
          throw new TeamError('Old Lead execution or term changed during activation', 'TEAM_NOT_MEMBER')
        }
        const checkBlockers = async (checkSignal: AbortSignal) => {
          const blockers = await cancellable(Promise.resolve(request.readBlockers(old)), checkSignal)
          if (blockers.length > 0) throw new TeamError(`Lead is blocked: ${blockers.map(item => item.description).join('; ')}`, 'TEAM_LEAD_BLOCKED')
        }
        await checkBlockers(signal)
        await cancellable(old.whenIdle(), signal)
        await checkBlockers(signal)
        let running: ReturnType<typeof task>
        try {
          running = old.runMaintenance(async (maintenanceSignal) => {
            const scope: LeadOccupation = { abort: new AbortController(), execution: old }
            const occupiedSignal = AbortSignal.any([signal, maintenanceSignal, scope.abort.signal])
            scopes.set(anchor, scope)
            try {
              await checkBlockers(occupiedSignal)
              await record(anchor, { operationId: request.operationId,
                previousTerm: request.previousTerm, phase: 'safe' }, occupiedSignal, () => request.record, scope)
              const safe: TeamLeadSafePointHandle = { execution: old, signal: occupiedSignal,
                record: (material, prepared) => record(anchor, { operationId: request.operationId,
                  previousTerm: request.previousTerm, ...prepared === true ? { phase: 'prepared' as const } : {} }, occupiedSignal, () => material, scope),
                commitLeadTransaction: plan => commit(anchor, request.operationId, request.previousTerm, scope, occupiedSignal, plan) }
              return await cancellable(task(safe), occupiedSignal)
            } finally {
              scopes.delete(anchor)
              scope.abort.abort(new TeamError('Lead maintenance capability has expired', 'TEAM_LEAD_SAFE_POINT_REQUIRED'))
            }
          })
        } catch (cause: unknown) {
          throw new TeamError('Old Lead could not be occupied; retry the safety check', 'TEAM_LEAD_SAFE_POINT_BUSY', { cause })
        }
        return await running
      }, request.signal),
      dispose: async () => {
        lifetime.abort(new TeamError('Lead coordinator registration closed', 'TEAM_LEAD_COORDINATOR_CLOSED'))
        await Promise.allSettled([...jobs])
        if (this.registration === handle) this.registration = undefined
      },
    }
    this.registration = handle
    this.ctx.effect(() => () => handle.dispose(), 'agentTeams.leadCoordinator()')
    return handle
  }

  private validateRecord(record: TeamExtensionRecord): void {
    requiredText(record.recordId, 'coordinator record id', 200)
    if (Buffer.byteLength(record.dataJson, 'utf8') > this.limits.maxTaskExtensionBytes) {
      throw new TeamError('Coordinator record exceeds the extension byte limit', 'TEAM_TASK_EXTENSION_TOO_LARGE')
    }
    try { JSON.parse(record.dataJson) } catch { throw new TeamError('Coordinator record must be JSON', 'TEAM_TASK_EXTENSION_INVALID') }
  }

  private materialNotices(anchor: Agent, state: TeamState, proposed: readonly TeamExtensionNotice[]) {
    return proposed.map(({ ordinaryMessageLimit: _limit, ...notice }) => {
      if (notice.senderId !== anchor.id || notice.senderName !== 'lead' || notice.targetId !== anchor.id
        || notice.senderTerm !== undefined || notice.contentAuthors?.some(author => author !== null)) {
        throw new TeamError('Coordinator material cannot claim model authorship or another target', 'TEAM_INVALID_ARGUMENT')
      }
      const framed = { ...structuredClone(notice), contentParts: notice.content.map(() => 'fact' as const),
        contentAuthors: notice.content.map(() => null) }
      if (teamMessageDeliveryBytes(framed, state) > this.limits.maxMessageBytes) {
        throw new TeamError('Coordinator material exceeds the Team message byte limit', 'TEAM_MESSAGE_TOO_LARGE')
      }
      return framed
    })
  }

  private assertMaterialCapacity(anchor: Agent, state: TeamState, additions: number): void {
    const pending = state.messages.filter(message => message.targetId === anchor.id && !state.delivered.includes(message.id)
      && !state.cancelled.some(item => item.messageId === message.id)).length
    if (pending + additions > this.limits.maxPendingMessagesPerMember) throw new TeamError('Lead mailbox is full', 'TEAM_MAILBOX_FULL')
  }
}
