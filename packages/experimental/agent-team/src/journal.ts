/** Serialized Team transactions over the exact live Lead Session log. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import { TeamError } from './error.ts'
import type { TeamEventType, TeamState } from './projection.ts'
import type { TeamMessageId } from './types.ts'
import { leadCoordinationFrozen } from './lead-coordination.ts'
import { currentMemberExecution } from './member-execution.ts'

type AppendTeamEvent = <T extends TeamEventType>(type: T, data: SessionEventMap[T]) => void
type MutableTeamEventType = TeamEventType

/** Owns per-Lead transaction order and committed Team event publication. */
export class TeamJournal {
  private readonly tails = new Map<SessionId, Promise<void>>()
  private readonly unconfirmed = new Map<SessionId, { blockAdmission: boolean; mailIds: Set<TeamMessageId> }>()

  /**
   * @param ctx - Team service context with the injected Session service.
   * @param onCommit - synchronous notification after the Team event flush succeeds.
   */
  constructor(
    private readonly ctx: Context,
    private readonly onCommit: (root: Agent) => void,
    private readonly productModeRequired = false,
    private readonly memberAdmitted: (root: Agent, memberId: SessionId) => boolean = () => true,
  ) {}

  /**
   * Read authoritative Team state for one exact live Lead.
   * @param root - exact live Team Lead.
   * @returns current projected state selected by the Lead Team id.
   */
  state(root: Agent): TeamState {
    const projection = this.ctx.sessionProjections.stateOf(root.session, 'agentTeam')
    if (projection === undefined) throw new Error('Agent Teams projection is not registered')
    if (projection.failure !== undefined) throw new TeamError(`Team state cannot be read: ${projection.failure}`, 'TEAM_STATE_FAILED')
    return projection
  }

  /**
   * Keep unmarked historical Teams read-only in a controlled product composition.
   * @param root - exact live Lead whose Team state is inspected.
   * @returns committed Team state admitted for a write.
   */
  assertWriteAdmission(root: Agent): TeamState {
    const state = this.state(root)
    if (this.productModeRequired && state.mode === undefined) {
      throw new TeamError('unmarked Team is read-only in the controlled product', 'TEAM_MODE_REQUIRED')
    }
    return state
  }

  /** Recheck a model mutation's exact author after entering the native transaction lock.
   * @param root - stable journal owner selected before queuing.
   * @param caller - exact live author, never a coordinator credential.
   * @returns authoritative state admitted for this author's mutation.
   */
  assertCallerWrite(root: Agent, caller: Agent): TeamState {
    if (this.ctx.agents.get(root.id) !== root || this.ctx.agents.get(caller.id) !== caller) {
      throw new TeamError('Team mutation author is no longer live', 'TEAM_NOT_MEMBER')
    }
    const state = this.assertWriteAdmission(root)
    const executionId = state.lead?.executionId ?? root.id
    if (caller.id === executionId) {
      if (leadCoordinationFrozen(state.leadCoordination)) {
        throw new TeamError('Lead Team writes are frozen during coordination', 'TEAM_LEAD_FROZEN')
      }
    } else {
      const member = state.members.find(item => currentMemberExecution(state, item).executionId === caller.id)
      if (caller.session.header.parentSession !== root.id
        || member === undefined || member.phase !== 'active' && member.phase !== 'provisioning') {
        throw new TeamError('Team mutation author no longer holds this seat', 'TEAM_NOT_MEMBER')
      }
      if (!this.memberAdmitted(root, member.id)) {
        throw new TeamError('member execution is being changed; wait for its owner', 'TEAM_MEMBER_HELD')
      }
    }
    return state
  }

  /** Confirm an existing coordinator fact before acknowledging a recovered operation.
   * @param root - exact live journal owner.
   * @param wake - whether Team waiters observe the confirmed write; an audit-only record leaves them waiting.
   */
  async confirm(root: Agent, wake = true): Promise<void> {
    if (!await this.ctx.sessions.flush(root.session)) {
      throw new TeamError('Lead coordination durability was not confirmed', 'TEAM_INPUT_DURABILITY')
    }
    const coordinated = this.unconfirmed.delete(root.id)
    if (wake) this.onCommit(root)
    if (coordinated) void this.ctx.parallel('agent-team/confirmed', root).catch((error: unknown) => {
      this.ctx.logger.warn(`Team confirmation observer failed: ${String(error)}`)
    })
  }

  /** Confirm a previously unacknowledged event without emitting activity for an unchanged journal.
   * @param root - exact stable journal owner, already admitted by the calling capability.
   */
  async confirmPending(root: Agent): Promise<void> {
    if (this.unconfirmed.has(root.id)) await this.confirm(root)
  }

  /** Read the same-process durability barrier without treating a raw append as acknowledgement.
   * @param root - stable Team journal owner.
   * @returns whether coordinated events have a confirmed checkpoint or came from durable recovery.
   */
  coordinationConfirmed(root: Agent): boolean {
    return this.unconfirmed.get(root.id)?.blockAdmission !== true
  }

  /** Read whether every owned journal effect has a confirmed checkpoint, without performing IO.
   * @param root - exact stable Team journal owner.
   * @returns false while any owned write still needs confirmation, including progress-only records.
   */
  recordsConfirmed(root: Agent): boolean {
    return !this.unconfirmed.has(root.id)
  }

  /** Check a coordinated queue item's source checkpoint without gating unrelated execution.
   * @param root - stable Team journal owner.
   * @param messageId - native queued notice identity.
   * @returns whether ordinary delivery may inspect this item.
   */
  messageConfirmed(root: Agent, messageId: TeamMessageId): boolean {
    return this.unconfirmed.get(root.id)?.mailIds.has(messageId) !== true
  }

  /**
   * Serialize one Lead's asynchronous mutation operation.
   * @param rootId - Lead Session identity selecting the transaction queue.
   * @param operation - complete read-check-append operation.
   * @returns the operation result.
   */
  async transact<T>(rootId: SessionId, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(rootId) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(rootId, tail)
    try {
      return await run
    } finally {
      if (this.tails.get(rootId) === tail) this.tails.delete(rootId)
    }
  }

  /**
   * Serialize an operation that reads Team admission facts after every earlier write has been confirmed.
   * A write still being confirmed is waited for; a failed checkpoint rejects before the operation runs.
   * @param root - exact live journal owner.
   * @param operation - read-check-append operation under the Team lock.
   * @returns the operation result.
   */
  async transactConfirmed<T>(root: Agent, operation: () => Promise<T>): Promise<T> {
    return await this.transact(root.id, async () => { await this.confirmPending(root); return await operation() })
  }

  /**
   * Decide an admission on a confirmed cut: wait under the Team lock until writes still being confirmed are confirmed,
   * then run the check there, so a write queued behind the wait cannot change the answer before it is read.
   * @param root - exact live journal owner.
   * @param check - synchronous admission check.
   * @returns the check's answer, or false when the earlier writes fail to confirm.
   */
  async settle(root: Agent, check: () => boolean): Promise<boolean> {
    try { return await this.transactConfirmed(root, () => Promise.resolve(check())) } catch { return false /* a write failed to confirm */ }
  }

  /**
   * Append and checkpoint one root-owned Team event before publication.
   * @param root - exact live Lead whose Session owns the event.
   * @param type - Team event discriminant.
   * @param data - payload correlated with the event type.
   * @param requireDurability - whether a false checkpoint must reject the owned acknowledgement.
   * @param blockAdmission - whether this coordinated event opens execution and must retain its barrier until confirmation.
   * @param wake - whether Team waiters observe this write. An earlier write still awaiting confirmation wakes them anyway,
   * because its own commit never did.
   */
  async appendAndFlush<T extends MutableTeamEventType>(
    root: Agent,
    type: T,
    data: SessionEventMap[T],
    requireDurability = false,
    blockAdmission = false,
    wake = true,
  ): Promise<void> {
    // Team events never enter the conversation surface. This narrower local
    // capability removes Session.append's conditional surface argument while
    // preserving the event-key/payload correlation.
    const append = root.session.append.bind(root.session) as unknown as AppendTeamEvent
    const previous = this.unconfirmed.get(root.id)
    if (requireDurability) {
      const pending = { blockAdmission: previous?.blockAdmission ?? false,
        mailIds: new Set<TeamMessageId>(previous?.mailIds) }
      pending.blockAdmission ||= blockAdmission
      if ('notices' in data) for (const notice of data.notices) pending.mailIds.add(notice.id)
      this.unconfirmed.set(root.id, pending)
    }
    try { append(type, data) } catch (error: unknown) {
      if (previous === undefined) this.unconfirmed.delete(root.id)
      else this.unconfirmed.set(root.id, previous)
      throw error
    }
    if (requireDurability) await this.confirm(root, wake || previous !== undefined)
    else {
      await this.ctx.sessions.flush(root.session)
      if (wake || previous !== undefined) this.onCommit(root)
    }
  }
}
