/** Host-owned member-local admission and confirmed execution replacement. */

import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentInput, StoredInputCustodySnapshot } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { foldContinuablePreset, foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { TeamJournal } from './journal.ts'
import { TeamError } from './error.ts'
import { applyMemberControl, applyMemberExecution, currentMemberExecution, memberExecutionControl,
  memberExecutionOwner } from './member-execution.ts'
import type { TeamMemberExecution, TeamMemberExecutionControl } from './member-execution.ts'
import { readPersistedSession } from './persisted.ts'
import { TeamId } from './types.ts'
import type { TeamCompositionSnapshot, TeamExtensionRecord, TeamMemberSnapshot } from './types.ts'
import type { TeamMembership } from './roster.ts'
import { requiredText } from './validation.ts'
import { applyMemberSlotTransfer } from './member-slots.ts'
import type { TeamMemberSlotTransfer } from './member-slots.ts'
import { teamProjectionDefinition } from './projection.ts'
import { cancellable } from './lead-runtime.ts'
import { leadCoordinationActive } from './lead-coordination.ts'

/** Reference material supplied by a registered owner from its durable operation record. */
export interface TeamMemberMaterial {
  readonly recordId: string
  readonly content: readonly ContentBlock[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Reference metadata is preserved without the producer; it grants no authority and needs no replay interpreter.
     * @persistenceAttribution
     */
    'team-member-material': {
      readonly kind: 'team-member-material'
      readonly form: 'recall'
      readonly teamId: TeamId
      readonly memberId: SessionId
      readonly generation: number
      readonly ownerId: string
      readonly recordId: string
    }
  }
}

/** Detached native facts supplied to the registered product owner. */
export interface TeamMemberExecutionSnapshot extends TeamCompositionSnapshot {
  readonly member: TeamMemberSnapshot
  readonly execution: TeamMemberExecution
  readonly control?: TeamMemberExecutionControl
  readonly records: readonly TeamExtensionRecord[]
  readonly confirmed: boolean
}

/** Member-local operation identity; candidate creation remains a continuation operation. */
export interface HoldTeamMemberExecution {
  readonly memberId: SessionId
  readonly operationId: string
  readonly expectedGeneration: number
  readonly nextExecutionId?: SessionId
}

/** Read actual blockers while native runtime holds the live execution or its exclusive original writer.
 * A stored snapshot is supplied only without an Agent; undefined with no live Agent means verified absence.
 * The reader must not recursively acquire either resource or mutate input custody.
 */
export type TeamMemberBlockerReader = (executionId: SessionId,
  stored?: StoredInputCustodySnapshot) => readonly string[] | Promise<readonly string[]>

/** Registered owner of controlled member execution changes, never a model identity. */
export interface TeamMemberExecutionProvider {
  readonly id: string
  /** Restore only the stable Team host before a bound child's composition mounts.
   * @param id - durable direct parent identity.
   * @param signal - registration lifetime.
   * @returns exact live stable anchor without running its model.
   */
  resolveAnchor?(id: SessionId, signal: AbortSignal): Promise<Agent>
  /** Return persisted reference material before the member's first waking input.
   * Native delivery supplies a non-authorizing source and stable id without waking.
   * @param anchor - stable Team journal owner.
   * @param execution - exact current member binding, including an initial generation.
   * @param signal - owner lifetime; no callback may outlive its registration.
   * @returns bounded references owned by the caller's durable records.
   */
  initialMaterial?(anchor: Agent, execution: TeamMemberExecution, signal: AbortSignal): Promise<readonly TeamMemberMaterial[]>
}

/** An owner-scoped capability; Team tools do not receive it. */
export interface TeamMemberExecutionHandle {
  /** Read current native identities and this owner's audit without waking any execution. */
  read(caller: Agent, memberId: SessionId): TeamMemberExecutionSnapshot
  /** Inspect pending journal confirmation without publishing a successful result or causing IO. */
  recordsConfirmed(caller: Agent): boolean
  /** Confirm opaque progress for this member operation without changing its admission. */
  record(caller: Agent, memberId: SessionId, operationId: string,
    record: TeamExtensionRecord | ((snapshot: TeamMemberExecutionSnapshot) => TeamExtensionRecord)): Promise<void>
  /** Confirm owner-scoped roster intent before creation; the callback only inspects the serialized native cut. */
  recordRoster(caller: Agent,
    record: TeamExtensionRecord | ((snapshot: TeamCompositionSnapshot) => TeamExtensionRecord)): Promise<void>
  /** Store factual material in an already loaded matching execution without waking it.
   * Cold executions receive the same records through initialMaterial before their next working input.
   */
  preloadMaterial(caller: Agent, expected: TeamMemberExecution,
    material: readonly TeamMemberMaterial[]): Promise<'stored' | 'deferred'>
  /** Persist member-local admission and caller-owned progress in one native event.
   * @param caller - actual current Lead, checked again under the Team lock.
   * @param request - expected member generation and optional reserved replacement Session.
   * @param build - synchronous preview/CAS validation and record producer under the same lock.
   * @returns the confirmed native member control.
   */
  hold(caller: Agent, request: HoldTeamMemberExecution,
    build: (snapshot: TeamMemberExecutionSnapshot) => TeamExtensionRecord): Promise<TeamMemberExecutionControl>
  /** Replace an unused failed preparation without releasing the original member's admission. */
  retarget(caller: Agent, memberId: SessionId, operationId: string, expectedNextId: SessionId, nextId: SessionId,
    record: TeamExtensionRecord, readBlockers: (executionId: SessionId) => readonly string[] | Promise<readonly string[]>): Promise<void>
  /** Preserve a live held execution's pending inputs without consuming them. */
  capture(execution: Agent): Promise<readonly AgentInput[]>
  /** Capture the held source through the continuation owner, including a quiet cold source. */
  captureCurrent(caller: Agent, memberId: SessionId, operationId: string, signal?: AbortSignal,
    readBlockers?: TeamMemberBlockerReader): Promise<readonly AgentInput[]>
  /** Settle selected held source identities after the owner has recorded their explicit disposition. */
  releaseCaptured(caller: Agent, memberId: SessionId, operationId: string,
    messageIds: readonly import('@deepseek-ai/dsh-llm').MessageId[], record: TeamExtensionRecord,
    signal?: AbortSignal): Promise<void>
  /** Commit a previously prepared child after all affected Task executions and inputs are settled.
   * @param caller - actual current Lead of the original operation term.
   * @param memberId - immutable roster address.
   * @param operationId - held operation identity.
   * @param record - product audit committed with the execution binding.
   * @param readBlockers - current background-job and external-effect observations, not model assertions.
   * @returns durably confirmed current binding; admission remains held until explicit release.
   */
  commit(caller: Agent, memberId: SessionId, operationId: string, record: TeamExtensionRecord,
    readBlockers: TeamMemberBlockerReader): Promise<TeamMemberExecution>
  /** End this hold only after caller-observed safety conditions have been confirmed; never wakes old work. */
  release(caller: Agent, memberId: SessionId, operationId: string, record: TeamExtensionRecord,
    readBlockers: TeamMemberBlockerReader,
    slotTransfer?: TeamMemberSlotTransfer): Promise<void>
  /** Remove admission ownership and await admitted operations; bound Sessions remain closed. */
  dispose(): Promise<void>
}

/** One optional native owner of member-local admission; ordinary compositions do not install it. */
export class TeamMemberExecutions {
  private registration: TeamMemberExecutionHandle | undefined
  private readonly unconfirmed = new Set<SessionId>()
  private readonly occupations = new Map<SessionId, { count: number }>()

  /** @param ctx - runtime services owned by native Team.
   * @param journal - sole Team journal and transaction order.
   * @param membership - exact live Team authority resolver.
   * @param maxRecordBytes - existing extension-record deployment limit.
   */
  constructor(private readonly ctx: Context, private readonly journal: TeamJournal,
    private readonly membership: (caller: Agent) => TeamMembership, private readonly maxRecordBytes: number,
    private readonly readAnchor: (reader: Agent) => Agent,
    private readonly compositionSnapshot: (anchor: Agent) => TeamCompositionSnapshot) {
    ctx.on('agent-team/confirmed', (anchor) => {
      for (const member of journal.state(anchor).members) this.unconfirmed.delete(member.id)
    })
  }

  /** Read whether this logical member can receive new work.
   * @param anchor - stable native journal owner.
   * @param memberId - immutable teammate address.
   * @returns false while held or awaiting a durable confirmation.
   */
  admitted(anchor: Agent, memberId: SessionId): boolean {
    return !this.unconfirmed.has(memberId) && !this.occupations.has(memberId)
      && memberExecutionControl(this.journal.state(anchor), memberId) === undefined
  }

  /** Register the sole product consumer and its durable child-input policy.
   * @param provider - owner namespace and non-waking anchor restoration.
   * @returns owned control operations; disposal does not undo durable effects.
   */
  install(provider: TeamMemberExecutionProvider): TeamMemberExecutionHandle {
    if (this.registration !== undefined) throw new TeamError('member execution owner is already installed', 'TEAM_MEMBER_OWNER_CONFLICT')
    const ownerId = requiredText(provider.id, 'member execution owner', 200)
    const lifetime = new AbortController()
    const jobs = new Set<Promise<unknown>>()
    const owned = <T>(action: () => Promise<T>): Promise<T> => {
      const run = Promise.resolve().then(() => { lifetime.signal.throwIfAborted(); return action() })
      jobs.add(run)
      void run.then(() => jobs.delete(run), () => jobs.delete(run))
      return run
    }
    const anchorOf = (session: Session): Agent | undefined => session.header.parentSession === undefined
      ? undefined : this.ctx.agents.get(session.header.parentSession)
    const sessionOwner = (session: Session) => {
      const anchor = anchorOf(session)
      if (anchor === undefined) return undefined
      const state = this.journal.state(anchor)
      if (state.mode === undefined) return undefined
      const known = memberExecutionOwner(state, session.id)
      const candidate = state.memberCandidates?.find(item => item.executionId === session.id)
      const member = known?.member ?? state.members.find(item => item.id === candidate?.memberId)
      return member === undefined ? undefined : { anchor, state, member, memberId: member.id }
    }
    const canRun = (agent: Agent): boolean => {
      if (lifetime.signal.aborted) return false
      const owner = sessionOwner(agent.session)
      if (owner === undefined || !this.admitted(owner.anchor, owner.memberId)) return false
      const member = owner.member
      return member.phase === 'active' && currentMemberExecution(owner.state, member).executionId === agent.id
    }
    const input = this.ctx.agents.registerInputController(InputControllerId(`${ownerId}/input`), {
      initialize: (session) => { if (sessionOwner(session) !== undefined) input.bind(session) },
      prepare: async (session) => {
        if (anchorOf(session) === undefined && session.header.parentSession !== undefined && provider.resolveAnchor !== undefined) {
          const anchor = await cancellable(provider.resolveAnchor(session.header.parentSession, lifetime.signal), lifetime.signal)
          lifetime.signal.throwIfAborted()
          if (anchor.id !== session.header.parentSession || this.ctx.agents.get(anchor.id) !== anchor) {
            throw new TeamError('member anchor resolver returned another execution', 'TEAM_NOT_MEMBER')
          }
        }
        if (sessionOwner(session) === undefined) throw new TeamError('member execution has no recorded Team owner', 'TEAM_NOT_MEMBER')
      },
      admit: (agent, material) => {
        const kind: string = material.message.source.kind
        if (canRun(agent)) return { kind: 'accept' }
        const owner = sessionOwner(agent.session)
        const current = owner !== undefined && currentMemberExecution(owner.state, owner.member).executionId === agent.id
        if (kind === 'user-question-reply' || !current && (material.wakeup || kind === 'user'
          || kind === 'team-message' || kind === 'agent-message')) {
          return { kind: 'reject', reason: 'working input requires the current member execution' }
        }
        return { kind: 'hold' }
      },
      canStart: canRun,
      canClaim: canRun,
    })
    const lead = (caller: Agent): Agent => {
      lifetime.signal.throwIfAborted()
      const member = this.membership(caller)
      if (member.role !== 'lead') throw new TeamError('member execution changes require the current Lead', 'TEAM_LEAD_REQUIRED')
      const state = this.journal.assertCallerWrite(member.root, caller)
      if (state.mode === undefined) throw new TeamError('member execution changes require controlled mode', 'TEAM_MODE_REQUIRED')
      if (leadCoordinationActive(state.leadCoordination)) throw new TeamError('Lead coordination owns Team changes', 'TEAM_LEAD_NOT_READY')
      return member.root
    }
    const snapshot = (anchor: Agent, memberId: SessionId): TeamMemberExecutionSnapshot => {
      const state = this.journal.state(anchor)
      const member = state.members.find(item => item.id === memberId)
      if (member === undefined) throw new TeamError('member not found', 'TEAM_MEMBER_NOT_FOUND')
      const control = state.memberControls?.find(item => item.memberId === memberId)
      return structuredClone({ ...this.compositionSnapshot(anchor), member, execution: currentMemberExecution(state, member),
        ...control === undefined ? {} : { control },
        records: state.extensionRecords.filter(item => item.writerId === ownerId),
        confirmed: !this.unconfirmed.has(memberId) && this.journal.recordsConfirmed(anchor) })
    }
    const validateRecord = (record: TeamExtensionRecord) => {
      requiredText(record.recordId, 'member operation record id', 200)
      if (Buffer.byteLength(record.dataJson, 'utf8') > this.maxRecordBytes) {
        throw new TeamError('member operation record exceeds the extension byte limit', 'TEAM_TASK_EXTENSION_TOO_LARGE')
      }
      try { JSON.parse(record.dataJson) } catch { throw new TeamError('member operation record must be JSON', 'TEAM_INVALID_ARGUMENT') }
    }
    const confirm = async (anchor: Agent, memberId: SessionId) => {
      await this.journal.confirm(anchor)
      this.unconfirmed.delete(memberId)
    }
    const held = (anchor: Agent, memberId: SessionId, operationId: string) => {
      const control = memberExecutionControl(this.journal.state(anchor), memberId)
      if (control === undefined || control.ownerId !== ownerId || control.operationId !== operationId) {
        throw new TeamError('member operation no longer owns admission', 'TEAM_MEMBER_OPERATION_STALE')
      }
      return control
    }
    const checkQuiet = async (control: TeamMemberExecutionControl,
      readBlockers: TeamMemberBlockerReader, stored?: StoredInputCustodySnapshot, signal = lifetime.signal) => {
      const blockers = await cancellable(Promise.resolve(readBlockers(control.executionId, stored)), signal)
      signal.throwIfAborted()
      if (blockers.length > 0) throw new TeamError(`member is blocked: ${blockers.join('; ')}`, 'TEAM_MEMBER_BLOCKED')
    }
    const atQuietExecution = async <T>(anchor: Agent, control: TeamMemberExecutionControl,
      readBlockers: TeamMemberBlockerReader, action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      if (this.ctx.agents.get(control.executionId)?.status === 'running') {
        throw new TeamError('member execution has not stopped', 'TEAM_MEMBER_RUNNING')
      }
      const occupation = this.occupations.get(control.memberId) ?? { count: 0 }
      this.occupations.set(control.memberId, occupation)
      occupation.count += 1
      try {
        if (this.ctx.agents.get(control.executionId) === undefined) {
          return await this.ctx.subagents.withDormantContinuable(anchor, control.executionId, input, lifetime.signal,
            async (source, signal) => {
              await checkQuiet(control, readBlockers, source?.read(), signal)
              await assertSourceAvailable(control, source !== undefined, signal)
              return action(signal)
            })
        }
        return await this.ctx.subagents.withContinuableExecution(anchor, control.executionId, lifetime.signal,
          async (_execution, signal) => {
            await checkQuiet(control, readBlockers, undefined, signal)
            await assertSourceAvailable(control, true, signal)
            return action(signal)
          })
      } finally {
        occupation.count -= 1
        if (occupation.count === 0) this.occupations.delete(control.memberId)
      }
    }
    const assertSourceAvailable = async (control: TeamMemberExecutionControl, sourcePresent: boolean, signal: AbortSignal) => {
      if (sourcePresent && await this.ctx.sessionPersistence.stat(control.executionId, { signal }) === undefined) {
        throw new TeamError('member execution source is unavailable', 'TEAM_MEMBER_OPERATION_STALE')
      }
      signal.throwIfAborted()
    }
    const preloadMaterial = async (anchor: Agent, agent: Agent, expected: TeamMemberExecution,
      material: readonly TeamMemberMaterial[]) => {
      lifetime.signal.throwIfAborted()
      if (!canRun(agent) || currentMemberExecution(this.journal.state(anchor), snapshot(anchor, expected.memberId).member)
        .executionId !== expected.executionId) throw new TeamError('continuation target changed', 'TEAM_MEMBER_OPERATION_STALE')
      const messages: AgentInput[] = material.map((value) => {
        requiredText(value.recordId, 'continuation record id', 200)
        if (!this.journal.state(anchor).extensionRecords.some(record =>
          record.writerId === ownerId && record.recordId === value.recordId)) {
          throw new TeamError('continuation material has no owning record', 'TEAM_MEMBER_OPERATION_STALE')
        }
        const message = createUserMessage({ content: [...value.content], source: { kind: 'team-member-material', form: 'recall',
          teamId: TeamId(anchor.id), memberId: expected.memberId, generation: expected.generation,
          ownerId, recordId: value.recordId } })
        const id = MessageId(`member-material:${createHash('sha256')
          .update(JSON.stringify([expected.executionId, ownerId, value.recordId])).digest('hex')}`)
        return { message: Object.freeze({ ...message, id }), target: 'next-step', wakeup: false }
      })
      if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > this.maxRecordBytes) {
        throw new TeamError('continuation material exceeds the extension byte limit', 'TEAM_TASK_EXTENSION_TOO_LARGE')
      }
      for (const value of messages) {
        lifetime.signal.throwIfAborted()
        if (!canRun(agent)) throw new TeamError('member changed before continuation material was stored', 'TEAM_MEMBER_OPERATION_STALE')
        await input.preload(agent, value)
      }
    }
    const handle: TeamMemberExecutionHandle = {
      read: (caller, memberId) => {
        lifetime.signal.throwIfAborted()
        return snapshot(this.readAnchor(caller), memberId)
      },
      recordsConfirmed: (caller) => {
        lifetime.signal.throwIfAborted()
        return this.journal.recordsConfirmed(this.readAnchor(caller))
      },
      recordRoster: (caller, value) => owned(async () => {
        const anchor = lead(caller)
        await this.journal.transact(anchor.id, async () => {
          lead(caller)
          const record = typeof value === 'function' ? value(this.compositionSnapshot(anchor)) : value
          validateRecord(record)
          const prior = this.journal.state(anchor).extensionRecords.find(item => item.writerId === ownerId
            && item.recordId === record.recordId)
          if (prior !== undefined) {
            if (prior.dataJson !== record.dataJson) throw new TeamError('roster intent retry conflicts', 'TEAM_MEMBER_OPERATION_STALE')
            await this.journal.confirm(anchor)
            return
          }
          await this.journal.appendAndFlush(anchor, 'team/extension', { version: 1, teamId: TeamId(anchor.id),
            extension: { id: ownerId, ...record } }, true)
        })
      }),
      preloadMaterial: (caller, expected, material) => owned(async () => {
        const anchor = lead(caller)
        const cut = snapshot(anchor, expected.memberId)
        if (!isDeepStrictEqual(cut.execution, expected) || !this.admitted(anchor, expected.memberId)) {
          throw new TeamError('continuation target changed after preview', 'TEAM_MEMBER_OPERATION_STALE')
        }
        const agent = this.ctx.agents.get(expected.executionId)
        if (agent === undefined) return 'deferred'
        input.bind(agent.session)
        await preloadMaterial(anchor, agent, expected, material)
        return 'stored'
      }),
      record: (caller, memberId, operationId, value) => owned(async () => {
        const anchor = lead(caller)
        await this.journal.transact(anchor.id, async () => {
          lead(caller)
          const cut = snapshot(anchor, memberId)
          const record = typeof value === 'function' ? value(cut) : value
          validateRecord(record)
          const previous = cut.records.find(item => item.recordId === record.recordId)
          if (previous !== undefined) {
            if (previous.dataJson !== record.dataJson) throw new TeamError('member progress retry conflicts', 'TEAM_MEMBER_OPERATION_STALE')
            await this.journal.confirm(anchor)
            return
          }
          if (cut.control?.held && (cut.control.operationId !== operationId || cut.control.ownerId !== ownerId)) {
            throw new TeamError('member progress no longer belongs to this operation', 'TEAM_MEMBER_OPERATION_STALE')
          }
          await this.journal.appendAndFlush(anchor, 'team/extension', { version: 1, teamId: TeamId(anchor.id),
            extension: { id: ownerId, ...record } }, true)
        })
      }),
      hold: (caller, request, build) => owned(async () => {
        const anchor = lead(caller)
        return this.journal.transact(anchor.id, async () => {
          lead(caller)
          const state = this.journal.state(anchor)
          const cut = snapshot(anchor, request.memberId)
          const record = build(cut)
          validateRecord(record)
          const previous = cut.records.find(item => item.recordId === record.recordId)
          if (previous !== undefined) {
            const control = cut.control
            if (previous.dataJson !== record.dataJson || control?.operationId !== request.operationId
              || control.generation !== request.expectedGeneration || control.nextExecutionId !== request.nextExecutionId) {
              throw new TeamError('member operation request conflicts with its recorded effects', 'TEAM_MEMBER_OPERATION_STALE')
            }
            await confirm(anchor, request.memberId)
            return control
          }
          const ongoing = cut.control?.held && cut.control.ownerId === ownerId
            && cut.control.operationId === request.operationId && cut.control.generation === request.expectedGeneration
            && cut.control.nextExecutionId === request.nextExecutionId ? cut.control : undefined
          if (ongoing === undefined && request.expectedGeneration !== cut.execution.generation
            || ongoing !== undefined && (ongoing.leadExecutionId !== caller.id || ongoing.leadTerm !== (state.lead?.term ?? 1))) {
            throw new TeamError('member execution changed after preview', 'TEAM_MEMBER_OPERATION_STALE')
          }
          const control: TeamMemberExecutionControl = ongoing ?? { memberId: request.memberId,
            operationId: requiredText(request.operationId, 'member operation id', 200), ownerId,
            executionId: cut.execution.executionId, generation: cut.execution.generation,
            leadExecutionId: caller.id, leadTerm: state.lead?.term ?? 1, held: true,
            ...request.nextExecutionId === undefined ? {} : { nextExecutionId: request.nextExecutionId } }
          applyMemberControl(state, control)
          this.unconfirmed.add(request.memberId)
          await this.journal.appendAndFlush(anchor, 'team/member/control', {
            version: 1, teamId: TeamId(anchor.id), control, record,
          }, true)
          this.unconfirmed.delete(request.memberId)
          return control
        })
      }),
      capture: execution => owned(async () => {
        const owner = sessionOwner(execution.session)
        if (owner === undefined) throw new TeamError('member input has no Team owner', 'TEAM_NOT_MEMBER')
        if (memberExecutionControl(owner.state, owner.memberId)?.ownerId !== ownerId) {
          throw new TeamError('member input capture requires held admission', 'TEAM_MEMBER_OPERATION_STALE')
        }
        input.bind(execution.session)
        return input.holdPending(execution)
      }),
      retarget: (caller, memberId, operationId, expectedNextId, nextId, record, readBlockers) => owned(async () => {
        validateRecord(record)
        const anchor = lead(caller)
        const previous = snapshot(anchor, memberId).records.find(item => item.recordId === record.recordId)
        if (previous !== undefined) {
          const control = held(anchor, memberId, operationId)
          if (previous.dataJson !== record.dataJson || control.nextExecutionId !== nextId) {
            throw new TeamError('candidate retry conflicts with its recorded target', 'TEAM_MEMBER_OPERATION_STALE')
          }
          await confirm(anchor, memberId)
          return
        }
        const control = held(anchor, memberId, operationId)
        if (control.nextExecutionId !== expectedNextId || this.ctx.agents.get(expectedNextId) !== undefined) {
          throw new TeamError('candidate changed or is still loaded', 'TEAM_MEMBER_OPERATION_STALE')
        }
        const blockers = await cancellable(Promise.resolve(readBlockers(expectedNextId)), lifetime.signal)
        lifetime.signal.throwIfAborted()
        if (blockers.length > 0) throw new TeamError(`candidate is blocked: ${blockers.join('; ')}`, 'TEAM_MEMBER_BLOCKED')
        if (await this.ctx.sessionPersistence.stat(expectedNextId, { signal: lifetime.signal }) !== undefined) {
          const stored = await readPersistedSession(this.ctx.sessionPersistence, expectedNextId, lifetime.signal)
          if (stored.events.slice(stored.inheritedEventCount).some(event => event.type === 'user/message'
            || event.type === 'turn/start' || event.type === 'agent/input/held' && event.data.input.wakeup)) {
            throw new TeamError('candidate already received working input', 'TEAM_MEMBER_OPERATION_STALE')
          }
        }
        if (await this.ctx.sessionPersistence.stat(nextId, { signal: lifetime.signal }) !== undefined
          || this.ctx.agents.get(nextId) !== undefined) throw new TeamError('new candidate identity is already used', 'TEAM_MEMBER_OPERATION_STALE')
        await this.journal.transact(anchor.id, async () => {
          lead(caller)
          if (!isDeepStrictEqual(held(anchor, memberId, operationId), control)
            || this.ctx.agents.get(expectedNextId) !== undefined) throw new TeamError('candidate changed during safety checks', 'TEAM_MEMBER_OPERATION_STALE')
          const data = { version: 1 as const, teamId: TeamId(anchor.id), previousExecutionId: expectedNextId,
            control: { ...control, nextExecutionId: nextId }, record }
          const projected = teamProjectionDefinition.apply(this.journal.state(anchor), { type: 'team/member/candidate',
            seq: SessionSeq(anchor.session.seq), time: Date.now(), data })
          if (projected.failure !== undefined) throw new TeamError(projected.failure, 'TEAM_MEMBER_OPERATION_STALE')
          this.unconfirmed.add(memberId)
          await this.journal.appendAndFlush(anchor, 'team/member/candidate', data, true)
          this.unconfirmed.delete(memberId)
        })
      }),
      captureCurrent: (caller, memberId, operationId, incoming, readBlockers) => owned(async () => {
        const signal = incoming === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, incoming])
        const anchor = lead(caller)
        const control = held(anchor, memberId, operationId)
        if (this.ctx.agents.get(control.executionId) === undefined) {
          return this.ctx.subagents.withDormantContinuable(anchor, control.executionId, input, signal, async (source, ownedSignal) => {
            lead(caller)
            if (!isDeepStrictEqual(held(anchor, memberId, operationId), control)) {
              throw new TeamError('member input source changed during capture', 'TEAM_MEMBER_OPERATION_STALE')
            }
            if (readBlockers !== undefined) await checkQuiet(control, readBlockers, source?.read(), ownedSignal)
            ownedSignal.throwIfAborted()
            lead(caller)
            if (!isDeepStrictEqual(held(anchor, memberId, operationId), control)) {
              throw new TeamError('member input source changed during capture', 'TEAM_MEMBER_OPERATION_STALE')
            }
            return source === undefined ? [] : source.holdPending()
          })
        }
        return this.ctx.subagents.withContinuableExecution(anchor, control.executionId, signal, async (execution, ownedSignal) => {
          lead(caller)
          if (!isDeepStrictEqual(held(anchor, memberId, operationId), control)) {
            throw new TeamError('member input source changed during capture', 'TEAM_MEMBER_OPERATION_STALE')
          }
          input.bind(execution.session)
          if (readBlockers !== undefined) await checkQuiet(control, readBlockers, undefined, ownedSignal)
          await assertSourceAvailable(control, true, ownedSignal)
          ownedSignal.throwIfAborted()
          lead(caller)
          if (!isDeepStrictEqual(held(anchor, memberId, operationId), control)) {
            throw new TeamError('member input source changed during capture', 'TEAM_MEMBER_OPERATION_STALE')
          }
          return input.holdPending(execution)
        })
      }),
      releaseCaptured: (caller, memberId, operationId, messageIds, record, incoming) => owned(async () => {
        const signal = incoming === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, incoming])
        const anchor = lead(caller)
        const control = snapshot(anchor, memberId).control
        if (control?.operationId !== operationId || control.ownerId !== ownerId) {
          throw new TeamError('input disposition no longer belongs to this operation', 'TEAM_MEMBER_OPERATION_STALE')
        }
        await handle.record(caller, memberId, operationId, record)
        if (messageIds.length === 0) return
        const assertDisposition = (signal: AbortSignal) => {
          signal.throwIfAborted()
          lead(caller)
          if (!isDeepStrictEqual(snapshot(anchor, memberId).control, control)) {
            throw new TeamError('member input disposition was superseded', 'TEAM_MEMBER_OPERATION_STALE')
          }
        }
        if (this.ctx.agents.get(control.executionId) === undefined) {
          await this.ctx.subagents.withDormantContinuable(anchor, control.executionId, input, signal, async (source, ownedSignal) => {
            assertDisposition(ownedSignal)
            if (source === undefined) throw new TeamError('recorded source input is unavailable', 'TEAM_MEMBER_OPERATION_STALE')
            for (const id of messageIds) {
              assertDisposition(ownedSignal)
              await source.releaseHeld(id)
            }
          })
          return
        }
        await this.ctx.subagents.withContinuableExecution(anchor, control.executionId, signal, async (execution, ownedSignal) => {
          for (const id of messageIds) {
            assertDisposition(ownedSignal)
            await input.release(execution, id)
          }
        })
      }),
      commit: (caller, memberId, operationId, record, readBlockers) => owned(async () => {
        validateRecord(record)
        const anchor = lead(caller)
        const committed = await this.journal.transact(anchor.id, async () => {
          lead(caller)
          const state = this.journal.state(anchor)
          const prior = state.memberExecutions?.find(item => item.operationId === operationId && item.memberId === memberId)
          if (prior === undefined) return undefined
          const audit = state.extensionRecords.find(item => item.writerId === ownerId && item.recordId === record.recordId)
          if (audit?.dataJson !== record.dataJson) throw new TeamError('member commit retry conflicts', 'TEAM_MEMBER_OPERATION_STALE')
          await confirm(anchor, memberId)
          return { memberId: prior.memberId, executionId: prior.executionId, generation: prior.generation }
        })
        if (committed !== undefined) return committed
        const control = held(anchor, memberId, operationId)
        const candidateId = control.nextExecutionId
        if (candidateId === undefined) throw new TeamError('member operation has no prepared execution', 'TEAM_MEMBER_OPERATION_STALE')
        const candidate = await readPersistedSession(this.ctx.sessionPersistence, candidateId, lifetime.signal)
        const suffix = candidate.events.slice(candidate.inheritedEventCount)
        const descriptor = foldSubagentDescriptor(suffix)
        const preset = foldContinuablePreset(suffix)
        return atQuietExecution(anchor, control, readBlockers, signal => this.journal.transact(anchor.id, async () => {
          signal.throwIfAborted()
          lead(caller)
          const state = this.journal.state(anchor)
          const active = held(anchor, memberId, operationId)
          const cut = snapshot(anchor, memberId)
          const previous = cut.records.find(item => item.recordId === record.recordId)
          if (previous !== undefined) {
            if (previous.dataJson !== record.dataJson || cut.execution.executionId !== candidateId
              || cut.execution.generation !== control.generation + 1) throw new TeamError('member commit retry conflicts', 'TEAM_MEMBER_OPERATION_STALE')
            await confirm(anchor, memberId)
            return cut.execution
          }
          if (!isDeepStrictEqual(active, control) || caller.id !== control.leadExecutionId
            || (state.lead?.term ?? 1) !== control.leadTerm
            || cut.tasks.some(task => task.ownerId === memberId && task.status === 'in_progress')) {
            throw new TeamError('member execution or work changed before binding', 'TEAM_MEMBER_OPERATION_STALE')
          }
          if (candidate.header.parentSession !== anchor.id || descriptor?.mode !== 'continuable'
            || descriptor.provider !== cut.member.provider || preset?.id !== cut.member.preset?.id
            || preset?.revision !== cut.member.preset?.revision
            || suffix.some(event => event.type === 'turn/start' || event.type === 'user/message')) {
            throw new TeamError('candidate is not an unused matching continuation', 'TEAM_PRESET_UNAVAILABLE')
          }
          const execution = { memberId, executionId: candidateId, generation: control.generation + 1 }
          applyMemberExecution(state, { version: 1, teamId: TeamId(anchor.id), operationId,
            previousGeneration: control.generation, binding: execution })
          this.unconfirmed.add(memberId)
          await this.journal.appendAndFlush(anchor, 'team/member/execution', { version: 1,
            teamId: TeamId(anchor.id), operationId, previousGeneration: control.generation, binding: execution,
            record: { ...record, ownerId } }, true)
          this.unconfirmed.delete(memberId)
          return execution
        }))
      }),
      release: (caller, memberId, operationId, record, readBlockers, slotTransfer) => owned(async () => {
        validateRecord(record)
        const anchor = lead(caller)
        const alreadyReleased = await this.journal.transact(anchor.id, async () => {
          lead(caller)
          const previous = this.journal.state(anchor).extensionRecords.find(item =>
            item.writerId === ownerId && item.recordId === record.recordId)
          if (previous === undefined) return false
          if (previous.dataJson !== record.dataJson || previous.memberControl?.held !== false
            || previous.memberControl.memberId !== memberId || previous.memberControl.operationId !== operationId
            || !isDeepStrictEqual(previous.memberSlotTransfer, slotTransfer)) {
            throw new TeamError('member release retry conflicts', 'TEAM_MEMBER_OPERATION_STALE')
          }
          await confirm(anchor, memberId)
          return true
        })
        if (alreadyReleased) return
        const current = snapshot(anchor, memberId).control
        if (current?.operationId !== operationId || current.ownerId !== ownerId) {
          throw new TeamError('member release does not own admission', 'TEAM_MEMBER_OPERATION_STALE')
        }
        await atQuietExecution(anchor, current, readBlockers, signal => this.journal.transact(anchor.id, async () => {
          signal.throwIfAborted()
          lead(caller)
          const cut = snapshot(anchor, memberId)
          const previous = cut.records.find(item => item.recordId === record.recordId)
          if (previous !== undefined) {
            if (previous.dataJson !== record.dataJson || cut.control?.operationId !== operationId || cut.control.held) {
              throw new TeamError('member release retry conflicts', 'TEAM_MEMBER_OPERATION_STALE')
            }
            const effect = this.journal.state(anchor).extensionRecords.find(item =>
              item.writerId === ownerId && item.recordId === record.recordId)
            if (!isDeepStrictEqual(effect?.memberSlotTransfer, slotTransfer)) {
              throw new TeamError('member release retry has different slot effects', 'TEAM_MEMBER_OPERATION_STALE')
            }
            await confirm(anchor, memberId)
            return
          }
          const control = held(anchor, memberId, operationId)
          if (!isDeepStrictEqual(control, current)) {
            throw new TeamError('member state changed before release', 'TEAM_MEMBER_OPERATION_STALE')
          }
          if (slotTransfer !== undefined) {
            if (slotTransfer.fromMemberId !== memberId) throw new TeamError('slot transfer has another source member', 'TEAM_MEMBER_OPERATION_STALE')
            const state = this.journal.state(anchor)
            applyMemberSlotTransfer(state.composition, state.members, slotTransfer)
          }
          this.unconfirmed.add(memberId)
          await this.journal.appendAndFlush(anchor, 'team/member/control', { version: 1,
            teamId: TeamId(anchor.id), control: { ...control, held: false }, record,
            ...slotTransfer === undefined ? {} : { slotTransfer } }, true)
          this.unconfirmed.delete(memberId)
        }))
      }),
      dispose: async () => {
        lifetime.abort(new TeamError('member execution owner closed', 'TEAM_MEMBER_OWNER_CLOSED'))
        stopInitialization()
        await Promise.allSettled([...jobs])
        await input.dispose()
        if (this.registration === handle) this.registration = undefined
      },
    }
    const stopInitialization = this.ctx.on('agent/created', ({ agent }) => owned(async (): Promise<undefined> => {
      if (provider.initialMaterial === undefined) return
      const owner = sessionOwner(agent.session)
      if (owner === undefined) return
      const binding = currentMemberExecution(owner.state, owner.member)
      if (binding.executionId !== agent.id || !canRun(agent)) return
      const material = await cancellable(provider.initialMaterial(owner.anchor, binding, lifetime.signal), lifetime.signal)
      lifetime.signal.throwIfAborted()
      await preloadMaterial(owner.anchor, agent, binding, material)
      return undefined
    }))
    this.registration = handle
    this.ctx.effect(() => () => handle.dispose(), 'agentTeams.memberExecutions()')
    return handle
  }
}
