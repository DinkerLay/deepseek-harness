/** Durable Team mailbox admission, target-local dispatch, acknowledgement, and recovery. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, InputControllerHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { errorMessage, TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamRuntimeLifecycle } from './lifecycle.ts'
import { readPersistedSession } from './persisted.ts'
import type { TeamRoster } from './roster.ts'
import type { TeamState } from './projection.ts'
import { resolveActiveMember } from './roster.ts'
import { messageAccepted } from './session-message.ts'
import { TeamId, TeamMessageId } from './types.ts'
import { requiredText } from './validation.ts'
import { TeamLeadMail } from './lead-mail.ts'
import type { TeamLeadSeat } from './lead-seat.ts'
import type {
  SendTeamMessageRequest,
  SendTeamMessageResult,
  TeamMessageSnapshot,
  TeamMessageSource,
  TeamLeadContext,
  TeamLeadDeliveryReceipt,
} from './types.ts'

/** Complete content delivered to a Team target, including stable sender attribution.
 * @param message - durable Team notice.
 * @param state - optional Team projection used to include controlled startup framing.
 * @returns the sender-framed content blocks admitted to the target inbox.
 */
export function teamMessageDeliveryContent(message: TeamMessageSnapshot, state?: TeamState): ContentBlock[] {
  const member = state?.mode === undefined ? undefined : state.members.find(candidate => candidate.id === message.targetId)
  const unstarted = member !== undefined && !state?.messages.some(candidate =>
    candidate.targetId === member.id && state.delivered.includes(candidate.id))
  return [
    ...unstarted ? [{ type: 'text' as const, text: `<system-reminder>
You are teammate "${member.name}" in group "${member.group ?? 'unassigned'}". Your Team Lead is "lead".
Work only on an assigned running Task. Without one, coordinate but do not research, run commands, or edit files. A Lead message or broadcast does not assign work. Apply to claim broadcasts and wait for Lead approval and assignment.
Read accepted DAG upstream results through the Task Board. Submit results for Lead acceptance; ordinary messages, broadcasts and comments never replace results. Send blockers and questions only to lead. Follow the Task requirements for scope, user conditions and acceptance criteria.
</system-reminder>` }] : [],
    { type: 'text', text: `Team message ${message.id} from ${message.senderName}:` },
    ...structuredClone(message.content),
  ]
}

/** UTF-8 bytes of the exact Team content admitted to the target inbox.
 * @param message - durable Team notice.
 * @param state - optional Team projection used to include controlled startup framing.
 * @returns complete sender-framed delivery size.
 */
export function teamMessageDeliveryBytes(message: TeamMessageSnapshot, state?: TeamState): number {
  return Buffer.byteLength(JSON.stringify(teamMessageDeliveryContent(message, state)), 'utf8')
}

/** Preserve controlled-member author attribution while adding system-owned delivery framing. */
function teamMessageSource(teamId: TeamId, message: TeamMessageSnapshot, state: TeamState): TeamMessageSource {
  const framing = teamMessageDeliveryContent(message, state).length - message.content.length
  const parts = message.contentParts?.length === message.content.length
    ? [...message.contentParts] : message.content.map(() => 'fact' as const)
  return { kind: 'team-message', teamId, messageId: message.id, senderId: message.senderId,
    senderName: message.senderName,
    contentParts: [...Array.from({ length: framing }, () => 'fact' as const), ...parts],
    ...message.senderTerm === undefined ? {} : { senderTerm: message.senderTerm },
    ...message.contentAuthors === undefined ? {} : {
      contentAuthors: [...Array.from({ length: framing }, () => null), ...message.contentAuthors],
    } }
}

/** Owns every process-local state transition for the durable Team mailbox. */
export class TeamMailbox {
  private readonly leadMail: TeamLeadMail
  private readonly dispatchTails = new Map<SessionId, Promise<void>>()
  private readonly inFlightMessages = new Set<TeamMessageId>()
  private readonly inFlightDispatches = new Set<Promise<unknown>>()
  private readonly retries = new Map<TeamMessageId, { attempts: number; timer?: ReturnType<typeof setTimeout> }>()

  /**
   * @param ctx - Team service context with Agent, Session, persistence, and subagent services.
   * @param journal - authoritative Lead-log transaction owner.
   * @param roster - Team membership and member-name resolver.
   * @param lifecycle - shared Team runtime admission cutoff.
   * @param maxPendingMessagesPerMember - per-target queued-minus-delivered limit.
   * @param maxMessageBytes - maximum complete sender-framed delivery size.
   */
  constructor(
    private readonly ctx: Context,
    private readonly journal: TeamJournal,
    private readonly roster: TeamRoster,
    private readonly lifecycle: TeamRuntimeLifecycle,
    private readonly maxPendingMessagesPerMember: number,
    private readonly maxMessageBytes: number,
    private readonly retryDelayMs: number,
    private readonly maxRetries: number,
    leadContext: (agent: Agent) => TeamLeadContext,
    resolveLead: (anchor: Agent, signal: AbortSignal) => Promise<TeamLeadContext>,
    resolveSource: (anchor: Agent, id: SessionId, signal: AbortSignal) => Promise<Agent>,
    canDeliverLead: (anchor: Agent) => boolean,
    private readonly ownsLeadInput: (anchor: Agent) => boolean,
  ) {
    this.leadMail = new TeamLeadMail(ctx, journal, lifecycle, {
      context: leadContext,
      canDeliver: canDeliverLead,
      resolve: resolveLead,
      resolveSource,
      serial: (targetId, operation) => this.serializeTarget(targetId, operation),
      dispatch: (root, message, signal) => this.tryDispatch(root, message, signal),
      frame: (message, state) => ({ content: teamMessageDeliveryContent(message, state),
        source: teamMessageSource(TeamId(state.id), message, state) }),
    }, maxPendingMessagesPerMember, maxMessageBytes)
    lifecycle.signal.addEventListener('abort', () => {
      for (const retry of this.retries.values()) clearTimeout(retry.timer)
      this.retries.clear()
    }, { once: true })
  }

  /** Bind or remove the registered native input owner's preload capability.
   * @param input - owner capability, or undefined after provider removal.
   */
  bindLeadInput(input: InputControllerHandle | undefined): void { this.leadMail.bind(input) }

  /** Persist captured source input in the existing native mailbox.
   * @param source - exact controlled source execution.
   * @param input - native input owner.
   * @param signal - owning registration cancellation; a late continuation cannot queue after closing.
   * @returns durable internal transfer ids.
   */
  queueHeld(source: Agent, input: InputControllerHandle, signal: AbortSignal): Promise<readonly TeamMessageId[]> {
    return this.trackDispatch(this.leadMail.queueHeld(source, input, signal))
  }

  /** Preload the committed Lead without waking through the shared target sequence.
   * @param anchor - exact stable controlled host.
   * @param seat - expected committed recipient.
   * @param input - native input owner.
   * @param signal - owning registration cancellation; preloading never wakes its recipient.
   * @returns sole native receipts after target and anchor confirmation.
   */
  preloadLeadMail(anchor: Agent, seat: Pick<TeamLeadSeat, 'executionId' | 'term'>,
    input: InputControllerHandle, signal: AbortSignal): Promise<readonly TeamLeadDeliveryReceipt[]> {
    return this.trackDispatch(this.leadMail.preloadLeadMail(anchor, seat, input, signal))
  }

  /**
   * Queue one durable peer message, then attempt immediate delivery.
   * @param caller - exact live sending Team member.
   * @param request - target name, content, and pre-queue cancellation.
   * @returns durable message identity and immediate-delivery observation.
   */
  async send(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    const operation = this.sendAdmitted(caller, {
      ...request,
      signal: AbortSignal.any([request.signal, this.lifecycle.signal]),
    })
    return await this.trackDispatch(operation)
  }

  /**
   * Observe target-side durable receipts and checkpoint their Lead-log acknowledgement.
   * @param session - exact target Session receiving the event.
   * @param event - newly appended Session event.
   */
  observeSessionEvent(session: Session, event: SessionEvent): void {
    if (this.lifecycle.disposed || event.type !== 'user/message' || event.data.source.kind !== 'team-message') return
    const source = event.data.source
    const acknowledgement = Promise.resolve().then(async () => {
      const root = this.ctx.agents.get(brandString<SessionId>(source.teamId))
      if (root !== undefined) await this.checkpointDelivered(root, session, source.messageId)
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`Team message "${source.messageId}" acknowledgement failed: ${errorMessage(error)}`)
    })
    void this.trackDispatch(acknowledgement)
  }

  /**
   * Retry durable pending messages relevant to one started Team member.
   * @param agent - newly started exact live Agent.
   * @param signal - shared runtime cancellation.
   */
  async recoverFor(agent: Agent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const membership = this.roster.tryMembership(agent)
    if (membership === undefined) return
    const state = this.journal.state(membership.root)
    if (state.mode !== undefined && (state.lead !== undefined || this.ownsLeadInput(membership.root))) {
      await this.trackDispatch(this.leadMail.cleanupConfirmed(membership.root))
    }
    const messages = state.messages.filter(message =>
      !state.delivered.includes(message.id)
      && !state.cancelled.some(item => item.messageId === message.id)
      && (membership.role === 'lead' || membership.role === 'host' || message.targetId === agent.id))
    for (const message of messages) {
      signal.throwIfAborted()
      await this.tryDispatch(membership.root, message, signal)
    }
  }

  /**
   * Return admitted dispatch and acknowledgement operations captured for disposal.
   * @returns detached snapshot ordered only by Set insertion.
   */
  pendingDispatches(): readonly Promise<unknown>[] {
    return [...this.inFlightDispatches]
  }

  /**
   * Cancel pending messages after earlier target-local dispatches settle.
   * @param caller - exact live Lead Agent.
   * @param targetName - immutable teammate name.
   * @param reason - durable explanation for cancellation.
   * @returns ids of messages cancelled by this call.
   */
  async cancelPending(caller: Agent, targetName: string, reason: string): Promise<readonly TeamMessageId[]> {
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    const membership = this.roster.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead can cancel Team mail', 'TEAM_LEAD_REQUIRED')
    const root = membership.root
    this.journal.assertWriteAdmission(root)
    const name = targetName.trim()
    if (name === 'lead' && this.journal.state(root).messages.some(message => message.transfer !== undefined
      && !this.journal.state(root).delivered.includes(message.id))) {
      throw new TeamError('source input custody cannot be cancelled as Team mail', 'TEAM_MESSAGE_TARGET_DENIED')
    }
    const target = this.journal.state(root).members.find(member => member.name === name)
    if (target === undefined || target.phase === 'retired') {
      throw new TeamError(`teammate "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND')
    }
    const explanation = requiredText(reason, 'reason', 200)
    return await this.trackDispatch(this.serializeTarget(target.id, async () => await this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      const pending = state.messages.filter(message => message.targetId === target.id
        && !state.delivered.includes(message.id)
        && !state.cancelled.some(item => item.messageId === message.id))
      if (pending.length === 0) return []
      const messageIds = pending.map(message => message.id)
      await this.journal.appendAndFlush(root, 'team/message/cancelled', {
        version: 3, teamId: TeamId(root.id), targetId: target.id, messageIds, reason: explanation,
      })
      return messageIds
    })))
  }

  /** Queue and dispatch one mailbox item admitted before the disposal cutoff. */
  private async sendAdmitted(
    caller: Agent,
    request: SendTeamMessageRequest,
  ): Promise<SendTeamMessageResult> {
    const membership = this.roster.membership(caller)
    request.signal.throwIfAborted()
    const root = membership.root
    const content = structuredClone(request.content)
    const queued = await this.journal.transact(root.id, async () => {
      request.signal.throwIfAborted()
      const state = this.journal.assertWriteAdmission(root)
      const target = resolveActiveMember(root, state, request.target)
      if (state.mode?.kind === 'controlled' && membership.role === 'teammate' && target.id !== root.id) {
        throw new TeamError('controlled teammates may message only the Lead', 'TEAM_MESSAGE_TARGET_DENIED')
      }
      if (target.id === caller.id || membership.role === 'lead' && target.id === root.id) {
        throw new TeamError('a Team member cannot message itself', 'TEAM_SELF_MESSAGE')
      }
      const pendingForTarget = state.messages.filter(candidate =>
        candidate.targetId === target.id && !state.delivered.includes(candidate.id)
        && !state.cancelled.some(item => item.messageId === candidate.id)).length
      if (pendingForTarget >= this.maxPendingMessagesPerMember) {
        throw new TeamError(
          `teammate "${target.name}" has ${pendingForTarget} pending messages`,
          'TEAM_MAILBOX_FULL',
        )
      }
      const queued: TeamMessageSnapshot = {
        id: TeamMessageId(`team-message-${randomUUID()}`),
        senderId: caller.id,
        senderName: membership.name,
        targetId: target.id,
        content,
        ...state.mode === undefined ? {} : { contentParts: content.map(block =>
          block.type === 'text' ? 'sender' as const : 'fact' as const),
        ...membership.role !== 'lead' ? {} : { senderTerm: membership.term ?? 1,
          contentAuthors: content.map(block => block.type === 'text'
            ? { executionId: caller.id, term: membership.term ?? 1 } : null) } },
      }
      const ordinaryLimit = state.mode?.maxOrdinaryMessageBytes
      const deliveryBytes = teamMessageDeliveryBytes(queued)
      if (ordinaryLimit !== undefined && deliveryBytes > ordinaryLimit) {
        throw new TeamError(
          `ordinary Team message exceeds ${ordinaryLimit} bytes; submit Task results for Lead acceptance and pass accepted results through Task prerequisites`,
          'TEAM_MESSAGE_TOO_LARGE',
        )
      }
      if (teamMessageDeliveryBytes(queued, state) > this.maxMessageBytes) {
        throw new TeamError(`team message exceeds ${this.maxMessageBytes} bytes`, 'TEAM_MESSAGE_TOO_LARGE')
      }
      await this.journal.appendAndFlush(root, 'team/message/queued', {
        version: 2,
        teamId: TeamId(root.id),
        message: queued,
      })
      if (queued.targetId === root.id && state.mode !== undefined
        && (state.lead !== undefined || this.ownsLeadInput(root))
        && !await this.ctx.sessions.flush(root.session)) {
        throw new TeamError('Lead queue durability was not confirmed', 'TEAM_INPUT_DURABILITY')
      }
      // Register dispatch before releasing the root transaction so concurrent
      // senders enter the target-local queue in durable mailbox order.
      return { message: queued, dispatch: this.tryDispatch(root, queued, request.signal) }
    })
    const accepted = await queued.dispatch
    return { messageId: queued.message.id, status: accepted ? 'accepted' : 'queued' }
  }

  /** Attempt one queued message exactly once in this process at a time. */
  private tryDispatch(root: Agent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean> {
    if (this.lifecycle.disposed) return Promise.resolve(false)
    if (this.inFlightMessages.has(message.id)) return Promise.resolve(false)
    this.inFlightMessages.add(message.id)
    const operation = this.trackDispatch(
      this.tryDispatchAdmitted(
        root,
        message,
        AbortSignal.any([signal, this.lifecycle.signal]),
      ),
    )
    const forget = (): void => {
      this.inFlightMessages.delete(message.id)
    }
    void operation.then(forget, forget)
    return operation
  }

  /** Track one dispatch transaction through delivery admission or contained failure. */
  private trackDispatch<T>(operation: Promise<T>): Promise<T> {
    this.inFlightDispatches.add(operation)
    void operation.then(() => {
      this.inFlightDispatches.delete(operation)
    }, () => {
      this.inFlightDispatches.delete(operation)
    })
    return operation
  }

  /** Attempt one queued message admitted before the service lifecycle cutoff. */
  private async tryDispatchAdmitted(
    root: Agent,
    message: TeamMessageSnapshot,
    signal: AbortSignal,
  ): Promise<boolean> {
    return await this.serializeTarget(message.targetId, () => this.dispatchThrough(root, message, signal))
  }

  /** Serialize delivery admission for one durable target in queued order. */
  private async serializeTarget<T>(targetId: SessionId, operation: () => Promise<T>): Promise<T> {
    const prior = this.dispatchTails.get(targetId) ?? Promise.resolve()
    /* v8 ignore next -- dispatch tails absorb rejection, so the recovery callback is a fail-safe backstop. */
    const run = prior.then(operation, operation)
    /* v8 ignore next -- dispatchOnce contains delivery failures and serializeDispatch itself does not throw. */
    const tail = run.then(() => undefined, () => undefined)
    this.dispatchTails.set(targetId, tail)
    try {
      return await run
    } finally {
      if (this.dispatchTails.get(targetId) === tail) this.dispatchTails.delete(targetId)
    }
  }

  /** Deliver every pending target message through `message` in durable queue order. */
  private async dispatchThrough(
    root: Agent,
    message: TeamMessageSnapshot,
    signal: AbortSignal,
  ): Promise<boolean> {
    const state = this.journal.state(root)
    const pending = state.messages.filter(candidate =>
      candidate.targetId === message.targetId && !state.delivered.includes(candidate.id)
      && !state.cancelled.some(item => item.messageId === candidate.id))
    const requested = pending.findIndex(candidate => candidate.id === message.id)
    if (requested < 0) return state.delivered.includes(message.id)
    for (const candidate of pending.slice(0, requested + 1)) {
      const ownsInFlight = !this.inFlightMessages.has(candidate.id)
      if (ownsInFlight) this.inFlightMessages.add(candidate.id)
      try {
        if (!await this.dispatchOnce(root, candidate, signal)) return false
      } finally {
        if (ownsInFlight) this.inFlightMessages.delete(candidate.id)
      }
    }
    return true
  }

  /** Attempt one queued delivery after target-local ordering admits it. */
  private async dispatchOnce(root: Agent, message: TeamMessageSnapshot, signal: AbortSignal): Promise<boolean> {
    try {
      const state = this.journal.state(root)
      if (message.targetId === root.id && state.mode !== undefined
        && (state.lead !== undefined || this.ownsLeadInput(root))) {
        return await this.leadMail.deliver(root, message, undefined, undefined, signal)
      }
      const member = state.mode === undefined ? undefined : state.members.find(candidate => candidate.id === message.targetId)
      if (member !== undefined) {
        if (member.phase !== 'active') return false
        try {
          const registry = this.ctx.get('agentPresets')
          if (registry === undefined || member.preset === undefined) throw new TeamError('registered member Preset is unavailable', 'TEAM_PRESET_UNAVAILABLE')
          await using lease = await registry.acquireComposition(member.preset.id)
          if (lease.revision !== member.preset.revision) throw new TeamError('registered member Preset revision changed; rebuild the member', 'TEAM_PRESET_UNAVAILABLE')
        } catch (error: unknown) {
          const entered = this.ctx.sessions.get(member.id)
          if (state.messages.some(candidate => candidate.targetId === member.id && state.delivered.includes(candidate.id))
            || entered !== undefined && (this.ctx.get('sessionProjections')
              ?.stateOf(entered, 'subagentInputReceipts')?.length ?? 0) > 0) throw error
          await this.roster.failRegisteredMember(root, member.id, errorMessage(error))
          const notification = this.journal.state(root).messages.find(candidate => candidate.id === TeamMessageId(`team-start-failed-${member.id}`))
          if (notification !== undefined) await this.tryDispatch(root, notification, signal)
          return false
        }
        const input = createUserMessage({ content: teamMessageDeliveryContent(message, state),
          source: teamMessageSource(TeamId(root.id), message, state) })
        await this.ctx.subagents.deliverContinuableInput({ childId: member.id, provider: member.provider,
          label: member.description, preset: member.preset,
          request: { parent: root, prompt: [...input.content] }, signal,
        }, Object.freeze({ ...input, id: brandString<MessageId>(message.id) }))
        await this.markDelivered(root, message.id, message.targetId)
        return true
      }
      const target = message.targetId === root.id ? root : this.ctx.agents.get(message.targetId)
      if (target !== undefined && this.targetRecorded(target.session, message.id)) {
        return await this.checkpointDelivered(root, target.session, message.id)
      }
      const source = {
        kind: 'team-message' as const,
        teamId: TeamId(root.id),
        messageId: message.id,
        senderId: message.senderId,
        senderName: message.senderName,
      }
      const content = teamMessageDeliveryContent(message)
      if (message.targetId === root.id) {
        const previous = this.ctx.agents.isInputControlled(root.session)
          ? this.ctx.agents.inputControlState(root.session).records.find(record =>
            record.input.message.source.kind === 'team-message'
            && record.input.message.source.messageId === message.id)
          : undefined
        const input = previous?.input.message ?? createUserMessage({ content, source })
        const receipt = this.ctx.agents.sendInput(root, previous?.input ?? { message: input, target: 'next-step', wakeup: true })
        if (receipt !== undefined && (await receipt).location === 'held') return false
        return await this.checkpointDelivered(root, root.session, message.id)
      }
      if (target === undefined) {
        const recorded = await this.persistedTargetRecorded(message.targetId, message.id, signal)
        if (recorded === undefined) return false
        if (recorded) {
          await this.markDelivered(root, message.id, message.targetId)
          return true
        }
      }
      await steerHostSubagentPrompt(this.ctx.subagents, root, message.targetId, content, source, signal)
      return target === undefined
        ? true
        : await this.checkpointDelivered(root, target.session, message.id)
    } catch (error: unknown) {
      this.ctx.logger.warn(`team message "${message.id}" remains queued: ${errorMessage(error)}`)
      if (!signal.aborted && this.journal.state(root).mode !== undefined) this.scheduleRetry(root, message)
      return false
    }
  }

  /** Retry unresolved controlled deliveries while their owning root remains live. */
  private scheduleRetry(root: Agent, message: TeamMessageSnapshot): void {
    if (this.lifecycle.disposed) return
    const retry = this.retries.get(message.id) ?? { attempts: 0 }
    if (retry.timer !== undefined) return
    if (retry.attempts >= this.maxRetries) {
      void this.trackDispatch(this.journal.transact(root.id, async () => {
        const id = TeamMessageId(`team-start-incomplete-${message.id}`)
        const existing = this.journal.state(root).messages.find(candidate => candidate.id === id)
        if (existing !== undefined) return existing
        const notice: TeamMessageSnapshot = { id, senderId: root.id, senderName: 'lead', targetId: root.id,
          content: [{ type: 'text', text: `Delivery of Team message ${message.id} remains unconfirmed after retries. Inspect its member and Tasks; cancel pending mail explicitly if needed.` }] }
        await this.journal.appendAndFlush(root, 'team/message/queued', { version: 2, teamId: TeamId(root.id),
          message: notice })
        return notice
      }).then(async (notice) => {
        await this.tryDispatch(root, notice, this.lifecycle.signal)
      }).catch((error: unknown) => { this.ctx.logger.warn(`Team delivery retry notification failed: ${errorMessage(error)}`) }))
      return
    }
    retry.attempts += 1
    retry.timer = setTimeout(() => {
      delete retry.timer
      if (this.ctx.agents.get(root.id) !== root || this.lifecycle.disposed) return
      void this.tryDispatch(root, message, this.lifecycle.signal)
    }, this.retryDelayMs * retry.attempts)
    retry.timer.unref()
    this.retries.set(message.id, retry)
  }

  /** Flush one live target receipt before the Lead records its delivered edge. */
  private async checkpointDelivered(
    root: Agent,
    target: Session,
    messageId: TeamMessageId,
  ): Promise<boolean> {
    await this.ctx.sessions.flush(target)
    if (!this.targetRecorded(target, messageId)) return false
    await this.markDelivered(root, messageId, target.id)
    return true
  }

  /** Record delivery unless the acknowledgement already exists. */
  private async markDelivered(root: Agent, messageId: TeamMessageId, targetId: SessionId): Promise<void> {
    await this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      if (state.delivered.includes(messageId)) return
      const queued = state.messages.find(message => message.id === messageId)
      if (queued === undefined || queued.targetId !== targetId) return
      if (state.cancelled.some(item => item.messageId === messageId)) return
      await this.journal.appendAndFlush(root, 'team/message/delivered', {
        version: 2,
        teamId: TeamId(root.id),
        messageId,
        targetId,
      })
      const retry = this.retries.get(messageId)
      if (retry !== undefined) clearTimeout(retry.timer)
      this.retries.delete(messageId)
    })
  }

  /** Whether a target Session already contains the durable message identity. */
  private targetRecorded(session: Session, messageId: TeamMessageId): boolean {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const suffix = session.snapshotEvents(session.inheritedEventCount)
    return messageAccepted(suffix, message => message.source.kind === 'team-message'
      && message.source.messageId === messageId)
  }

  /** Read an inactive target's durable log before cold resume; uncertainty keeps the mailbox queued. */
  private async persistedTargetRecorded(
    targetId: SessionId,
    messageId: TeamMessageId,
    signal: AbortSignal,
  ): Promise<boolean | undefined> {
    try {
      const stored = await readPersistedSession(this.ctx.sessionPersistence, targetId, signal)
      const suffix = stored.events.slice(stored.inheritedEventCount)
      return messageAccepted(suffix, message => message.source.kind === 'team-message'
        && message.source.messageId === messageId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`cannot read Team message target "${targetId}": ${errorMessage(error)}`)
      return undefined
    }
  }
}
