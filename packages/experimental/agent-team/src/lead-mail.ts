/** Reliable native Lead-seat mail and source-held input custody over the existing mailbox. */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentInput, InputControllerHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TeamJournal } from './journal.ts'
import type { TeamRuntimeLifecycle } from './lifecycle.ts'
import type { TeamLeadSeat } from './lead-seat.ts'
import type { TeamState } from './projection.ts'
import { readPersistedSession } from './persisted.ts'
import { TeamError } from './error.ts'
import { cancellable } from './lead-runtime.ts'
import { TeamId, TeamMessageId } from './types.ts'
import type { TeamLeadContext, TeamLeadDeliveryReceipt, TeamMessageSnapshot, TeamMessageSource } from './types.ts'

/** Operations shared with the mailbox's existing target-local serialization. */
export interface LeadMailOperations {
  context(agent: Agent): TeamLeadContext
  canDeliver(anchor: Agent): boolean
  resolve(anchor: Agent, signal: AbortSignal): Promise<TeamLeadContext>
  resolveSource(anchor: Agent, id: SessionId, signal: AbortSignal): Promise<Agent>
  serial<T>(targetId: SessionId, operation: () => Promise<T>): Promise<T>
  dispatch(root: Agent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean>
  frame(message: TeamMessageSnapshot, state: TeamState): { content: TeamMessageSnapshot['content']; source: TeamMessageSource }
}

/** Native Lead receiver and transfer owner; all persisted items remain in TeamState.messages. */
export class TeamLeadMail {
  constructor(private readonly ctx: Context, private readonly journal: TeamJournal,
    private readonly lifecycle: TeamRuntimeLifecycle, private readonly operations: LeadMailOperations,
    private readonly maxPending: number, private readonly maxBytes: number) {}

  private async flush(session: Session, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!await this.ctx.sessions.flush(session)) throw new TeamError('Lead mail durability was not confirmed', 'TEAM_INPUT_DURABILITY')
    signal.throwIfAborted()
  }

  private assertAnchor(anchor: Agent, signal: AbortSignal): void {
    signal.throwIfAborted()
    this.lifecycle.signal.throwIfAborted()
    if (this.ctx.agents.get(anchor.id) !== anchor || this.journal.state(anchor).mode === undefined) {
      throw new TeamError('Lead mail requires its exact live controlled anchor', 'TEAM_NOT_MEMBER')
    }
  }

  /** Queue source-held input once per persisted capture fact, preserving the original identified input.
   * @param source - exact controlled source execution.
   * @param input - registered native input owner.
   * @param incoming - owning registration cancellation, combined with Team runtime lifetime.
   * @returns internal queue ids after source and anchor durability are confirmed.
   */
  async queueHeld(source: Agent, input: InputControllerHandle, incoming = this.lifecycle.signal): Promise<readonly TeamMessageId[]> {
    const signal = AbortSignal.any([this.lifecycle.signal, incoming])
    const anchor = this.operations.context(source).anchor
    this.assertAnchor(anchor, signal)
    const captured = (await input.holdPending(source)).filter((value) => {
      const kind: string = value.message.source.kind
      if (kind !== 'user-question-reply') return true
      this.ctx.logger.warn('operation-bound question reply remains with its original execution')
      return false
    })
    if (captured.length === 0) return []
    const stored = await cancellable(readPersistedSession(this.ctx.sessionPersistence, source.id, signal), signal)
    const messages = captured.map((value): TeamMessageSnapshot & { transfer: NonNullable<TeamMessageSnapshot['transfer']> } => {
      const fact = stored.events.slice(stored.inheritedEventCount).findLast(event => event.type === 'agent/input/held'
        && event.data.controllerId === input.id && event.data.input.message.id === value.message.id)
      if (fact?.type !== 'agent/input/held' || !isDeepStrictEqual(fact.data.input, value)) {
        throw new TeamError('held input has no matching persisted custody fact', 'TEAM_INPUT_DURABILITY')
      }
      const digest = createHash('sha256').update(JSON.stringify([source.id, value.message.id, fact.seq])).digest('hex')
      return { id: TeamMessageId(`lead-transfer-${digest}`), senderId: source.id, senderName: 'lead',
        targetId: anchor.id, content: [], transfer: { sourceExecutionId: source.id, heldSeq: fact.seq, input: structuredClone(value) } }
    })
    await cancellable(this.operations.serial(anchor.id, async () => { await this.journal.transact(anchor.id, async () => {
      this.assertAnchor(anchor, signal)
      input.bind(source.session)
      for (const message of messages) {
        const state = this.journal.state(anchor)
        const prior = state.messages.find(item => item.id === message.id)
        if (prior !== undefined) {
          if (!isDeepStrictEqual(prior, message)) throw new TeamError('Lead transfer identity conflicts with its recorded input', 'TEAM_INVALID_ARGUMENT')
          continue
        }
        const pending = state.messages.filter(item => item.targetId === anchor.id && !state.delivered.includes(item.id)
          && !state.cancelled.some(cancelled => cancelled.messageId === item.id)).length
        if (pending >= this.maxPending) throw new TeamError('Lead mailbox is full; source custody is retained', 'TEAM_MAILBOX_FULL')
        if (Buffer.byteLength(JSON.stringify(message), 'utf8') > this.maxBytes) {
          throw new TeamError('Lead transfer exceeds the mailbox byte limit; source custody is retained', 'TEAM_MESSAGE_TOO_LARGE')
        }
        anchor.session.append('team/message/input-queued', { version: 1, teamId: TeamId(anchor.id), message })
      }
      await this.flush(anchor.session, signal)
    }) }), signal)
    for (const message of messages) {
      signal.throwIfAborted()
      if (this.receipt(this.journal.state(anchor), message.id) !== undefined) await this.deliver(anchor, message, input, undefined, signal)
      else await this.operations.dispatch(anchor, message, signal)
    }
    return messages.map(message => message.id)
  }

  private receipt(state: TeamState, messageId: TeamMessageId): TeamLeadDeliveryReceipt | undefined {
    return state.leadDeliveries?.find(receipt => receipt.messageId === messageId)
  }

  private material(message: TeamMessageSnapshot, state: TeamState): AgentInput {
    if (message.transfer !== undefined) return structuredClone(message.transfer.input)
    const frame = this.operations.frame(message, state)
    return { message: Object.freeze({ ...createUserMessage(frame), id: MessageId(message.id) }),
      target: 'next-step', wakeup: true }
  }

  /** Deliver or preload one logical Lead item under the native Team transaction lock.
   * @param anchor - exact stable controlled Team host.
   * @param message - queued native item.
   * @param input - native preload owner; absence uses ordinary controlled admission.
   * @param expectedSeat - preload-only expected committed recipient.
   * @param incoming - dispatch or registered-owner cancellation.
   * @returns true only after target custody and the sole root receipt are confirmed.
   */
  async deliver(anchor: Agent, message: TeamMessageSnapshot, input?: InputControllerHandle,
    expectedSeat?: Pick<TeamLeadSeat, 'executionId' | 'term'>, incoming = this.lifecycle.signal): Promise<boolean> {
    return await this.deliverReceipt(anchor, message, input, expectedSeat, AbortSignal.any([this.lifecycle.signal, incoming])) !== undefined
  }

  /** Return the actual confirmed receipt rather than re-reading it after successful delivery. */
  private async deliverReceipt(anchor: Agent, message: TeamMessageSnapshot, input?: InputControllerHandle,
    expectedSeat?: Pick<TeamLeadSeat, 'executionId' | 'term'>, signal = this.lifecycle.signal): Promise<TeamLeadDeliveryReceipt | undefined> {
    let wake: Agent | undefined
    signal.throwIfAborted()
    if (input === undefined && !this.operations.canDeliver(anchor)) return
    const resolved = this.receipt(this.journal.state(anchor), message.id) === undefined
      ? await this.operations.resolve(anchor, signal) : undefined
    const accepted = await cancellable(this.journal.transact(anchor.id, async () => {
      this.assertAnchor(anchor, signal)
      const state = this.journal.state(anchor)
      if (state.cancelled.some(item => item.messageId === message.id)) return
      // An in-memory queue or receipt is not durable evidence on a retry.
      await this.flush(anchor.session, signal)
      const previous = this.receipt(state, message.id)
      if (previous !== undefined) {
        await this.releaseSource(anchor, message, previous, signal, input)
        return { ...previous }
      }
      const context = this.operations.context(anchor)
      if (resolved !== undefined && (resolved.seat.executionId !== context.seat.executionId || resolved.seat.term !== context.seat.term)) {
        throw new TeamError('Lead seat changed during recipient preparation', 'TEAM_LEAD_STALE_TERM')
      }
      if (expectedSeat !== undefined
        && (context.seat.executionId !== expectedSeat.executionId || context.seat.term !== expectedSeat.term)) {
        throw new TeamError('Lead preload recipient is no longer current', 'TEAM_LEAD_STALE_TERM')
      }
      const target = context.execution
      if (target === undefined || input === undefined && !context.ready) return
      const material = this.material(message, state)
      if (input !== undefined) {
        input.bind(target.session)
        await input.preload(target, material)
      } else {
        const nativeInput = this.inputOwner
        if (nativeInput !== undefined) await nativeInput.preload(target, material)
        else {
          const receipt = this.ctx.agents.sendInput(target, material)
          if (receipt !== undefined && (await receipt).location === 'held') return
        }
      }
      await this.flush(target.session, signal)
      const receipt: TeamLeadDeliveryReceipt = { messageId: message.id, targetId: anchor.id,
        executionId: context.seat.executionId, term: context.seat.term }
      anchor.session.append('team/message/lead-delivered', { version: 1, teamId: TeamId(anchor.id), ...receipt })
      await this.flush(anchor.session, signal)
      await this.releaseSource(anchor, message, receipt, signal, input)
      if (input === undefined && this.inputOwner !== undefined && material.wakeup && this.operations.context(anchor).ready) wake = target
      return receipt
    }), signal)
    signal.throwIfAborted()
    wake?.wakePending?.()
    return accepted
  }

  private inputOwner: InputControllerHandle | undefined

  /** Bind the owning native preload capability for ordinary restoration and source release.
   * @param input - registered native input owner, or undefined after removal.
   */
  bind(input: InputControllerHandle | undefined): void { this.inputOwner = input }

  private async releaseSource(anchor: Agent, message: TeamMessageSnapshot, receipt: TeamLeadDeliveryReceipt,
    signal: AbortSignal, explicit?: InputControllerHandle): Promise<void> {
    signal.throwIfAborted()
    const transfer = message.transfer
    if (transfer === undefined || transfer.sourceExecutionId === receipt.executionId) return
    const source = transfer.sourceExecutionId === anchor.id ? anchor
      : await this.operations.resolveSource(anchor, transfer.sourceExecutionId, signal)
    const input = explicit ?? this.inputOwner
    if (input === undefined) throw new TeamError('Lead transfer owner is unavailable', 'TEAM_LEAD_PROVIDER_CLOSED')
    const state = this.ctx.agents.inputControlState(source.session)
    const record = state.records.find(item => item.input.message.id === transfer.input.message.id)
    if (record?.location === 'held') {
      const stored = await cancellable(readPersistedSession(this.ctx.sessionPersistence, source.id, signal), signal)
      const current = stored.events.slice(stored.inheritedEventCount).findLast(event => event.type === 'agent/input/held'
        && event.data.input.message.id === transfer.input.message.id)
      if (current?.seq !== transfer.heldSeq) return
    }
    signal.throwIfAborted()
    await input.release(source, transfer.input.message.id)
  }

  /** Resume receipt-confirmed source cleanup across every historical recipient term.
   * @param anchor - exact stable controlled host.
   * @param input - explicit native owner, or the installed ordinary owner.
   * @param incoming - owning registration cancellation when called from preload.
   * @returns completion after every matching source release has durably settled.
   */
  async cleanupConfirmed(anchor: Agent, input?: InputControllerHandle, incoming = this.lifecycle.signal): Promise<void> {
    const signal = AbortSignal.any([this.lifecycle.signal, incoming])
    this.assertAnchor(anchor, signal)
    const state = this.journal.state(anchor)
    const messages = state.messages.flatMap((message) => {
      const receipt = this.receipt(state, message.id)
      return message.transfer !== undefined && receipt !== undefined ? [{ message, receipt }] : []
    })
    if (messages.length === 0) return
    await this.flush(anchor.session, signal)
    for (const { message, receipt } of messages) await this.releaseSource(anchor, message, receipt, signal, input)
  }

  /** Preload pending Lead mail in the same sequence used by ordinary delivery.
   * @param anchor - exact stable controlled host.
   * @param expectedSeat - current committed recipient.
   * @param input - registered native input owner.
   * @param incoming - owning registration cancellation.
   * @returns sole native receipts; preloading never calls wakePending.
   */
  async preloadLeadMail(anchor: Agent, expectedSeat: Pick<TeamLeadSeat, 'executionId' | 'term'>,
    input: InputControllerHandle, incoming = this.lifecycle.signal): Promise<readonly TeamLeadDeliveryReceipt[]> {
    const signal = AbortSignal.any([this.lifecycle.signal, incoming])
    return await cancellable(this.operations.serial(anchor.id, async () => {
      this.assertAnchor(anchor, signal)
      const context = this.operations.context(anchor)
      if (context.seat.executionId !== expectedSeat.executionId || context.seat.term !== expectedSeat.term) {
        throw new TeamError('Lead preload recipient is no longer current', 'TEAM_LEAD_STALE_TERM')
      }
      await this.cleanupConfirmed(anchor, input, signal)
      const state = this.journal.state(anchor)
      const messages = state.messages.filter((message) => {
        const receipt = this.receipt(state, message.id)
        return message.targetId === anchor.id && !state.cancelled.some(item => item.messageId === message.id)
          && (!state.delivered.includes(message.id)
            || receipt?.executionId === expectedSeat.executionId && receipt.term === expectedSeat.term)
      })
      const receipts: TeamLeadDeliveryReceipt[] = []
      for (const message of messages) {
        const receipt = await this.deliverReceipt(anchor, message, input, expectedSeat, signal)
        if (receipt === undefined) throw new TeamError('Lead preload recipient is unavailable', 'TEAM_LEAD_ANCHOR_INVALID')
        receipts.push({ ...receipt })
      }
      return receipts
    }), signal)
  }
}
