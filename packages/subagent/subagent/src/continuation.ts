/**
 * Continuable-subagent orchestration behind `ctx.subagents`: stable child ids,
 * descriptor persistence, provider preparation, cold resume, authorization,
 * and message routing. {@link ContinuableActivationRegistry} owns the mutable
 * process-local Activation graph and its settlement and disposal lifecycle.
 *
 * A continuable child has one durable Session and at most one process-local
 * Activation. The Agent inbox is the only turn queue, so this manager owns
 * durable orchestration while the Agent loop owns all turn ordering and
 * execution. No continuable path creates a Task or an intermediate
 * result-bearing wrapper.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, InputControllerHandle, StoredInputCustody, StoredInputCustodySource, StoredInputCustodySnapshot } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ReasoningEffortId, contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, Session, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import {
  childSessionMeta,
  captureDelegatedPolicyOverrides,
  resolveChildAgentOptions,
  resolveChildDepth,
} from './child-agent.ts'
import {
  ContinuableActivationRegistry,
} from './continuation-activation.ts'
import type { Activation, SubmittedInput } from './continuation-activation.ts'
import {
  createAgentMessage,
  withContinuableReturnGuidance,
} from './continuation-messages.ts'
import { assertSubagentMaxDepth } from './depth.ts'
import { foldSubagentDescriptor, snapshotSubagentDescriptor } from './descriptor.ts'
import { foldContinuablePreset } from './continuable-preset.ts'
import { establishCatalogChild } from './catalog.ts'
import { SubagentError } from './error.ts'
import { isAdjacentAgentSendMessageTool } from './internal.ts'
import type { ActivationObserver } from './lifecycle.ts'
import type { SubagentCatalogEntry } from './projection-types.ts'
import type { SubagentSettlementNoticeFacts, SubagentSettlementNoticeWording } from './types.ts'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  ContinuableInputCustodyScope,
  ContinuablePrepared,
  ContinuablePrepareSpec,
  ContinuableStart,
  ContinuableStartSpec,
  DormantContinuableScope,
  SubagentInterruptAuthority,
  SubagentSendMessageOptions,
} from './types.ts'

/** Inputs shared by model steering and human prompt delivery. */
type ChildDeliveryOptions = (
  | {
    readonly delivery: 'steer'
    /**
     * A provided host source is preserved on the user message; omission attributes
     * an adjacent-Agent message to the parent.
     */
    readonly source?: MessageSource
    readonly signal: AbortSignal
  }
  | { readonly delivery: 'queue'; readonly source: MessageSource; readonly signal: AbortSignal }
  ) & { readonly messageId?: MessageId }

/** Package-private hooks supplied by the owning service. */
interface ContinuationHost {
  /** Resolve one provider's detached continuable-creation contribution. */
  prepareContinuable(name: string, request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
  /** Build the lifecycle observer for one Activation residency epoch. */
  observeActivation(provider: string, childId: SessionId, parent: Agent): ActivationObserver
  /** Admit one parent-visible settlement notice after the child has flushed its final state. */
  sendSettlementNotice(facts: SubagentSettlementNoticeFacts):
  Promise<'send' | 'suppress' | SubagentSettlementNoticeWording>
}

/**
 * The continuable-subagent orchestration service behind `ctx.subagents`. Tool
 * schema and host adapters are consumers of this one contract; foreground
 * one-shot delegation keeps calling `ctx.subagents.start()` and never enters
 * this lifecycle.
 */
export class SubagentContinuationManager {
  private readonly activations: ContinuableActivationRegistry
  private readonly childOperations = new Map<SessionId, Promise<void>>()
  private readonly acceptedInputs = new WeakMap<Activation, Set<MessageId>>()

  constructor(
    private readonly ctx: Context,
    private readonly host: ContinuationHost,
    maxActiveSubagents: () => number,
  ) {
    this.activations = new ContinuableActivationRegistry(
      ctx,
      (provider, childId, parent) => host.observeActivation(provider, childId, parent),
      maxActiveSubagents,
      facts => host.sendSettlementNotice(facts),
    )
  }

  /** Snapshot the composition shared by immediate starts and input-free preparation. */
  private snapshotCreation(spec: ContinuableStartSpec | ContinuablePrepareSpec) {
    const { request } = spec
    assertSubagentMaxDepth(request.maxDepth)
    const childDepth = resolveChildDepth(request.parent, request.maxDepth)
    const agentOptions = resolveChildAgentOptions(request.parent, request.agentOptions, childDepth)
    const descriptor = snapshotSubagentDescriptor({
      mode: 'continuable', provider: spec.provider, label: spec.label,
      ...agentOptions.provider === undefined ? {} : { agentProvider: agentOptions.provider },
      ...agentOptions.model === undefined ? {} : { agentModel: agentOptions.model },
      ...agentOptions.reasoningEffort === undefined ? {} : { agentReasoningEffort: agentOptions.reasoningEffort },
      ...request.persona === undefined ? {} : { persona: request.persona },
      ...request.toolFilter === undefined ? {} : { toolFilter: request.toolFilter },
    })
    return { childDepth, agentOptions, descriptor,
      delegatedPolicies: captureDelegatedPolicyOverrides(request.parent) }
  }

  /** Resolve only an explicitly supplied Host directory, never creating or adopting a missing path. */
  private async resolveCwd(cwd: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (!isAbsolute(cwd)) throw new SubagentError('continuable cwd must be an absolute directory', 'INVALID_CWD')
    const canonical = await realpath(cwd)
    signal.throwIfAborted()
    if (!(await stat(canonical)).isDirectory()) throw new SubagentError('continuable cwd is not a directory', 'INVALID_CWD')
    signal.throwIfAborted()
    return canonical
  }

  /** Check the immutable target directory before an idempotent receipt or new input can be accepted. */
  private assertCwd(header: SessionHeader, cwd: string | undefined): void {
    if (cwd !== undefined && header.cwd !== cwd) {
      throw new SubagentError(`subagent "${header.id}" execution directory changed`, 'PREPARATION_MISMATCH')
    }
  }

  /**
   * Restore or borrow one held execution for a quiescent Host operation.
   * @param parent - exact live direct parent whose durable lineage authorizes access.
   * @param childId - descriptor-backed continuable child to maintain.
   * @param signal - cancellation forwarded to maintenance without abandoning its cleanup.
   * @param callback - operation on the exact execution, retaining native custody policy.
   * @returns the result after handback; pending input prevents temporary disposal.
   */
  async withContinuableExecution<T>(parent: Agent, childId: SessionId, signal: AbortSignal,
    callback: (agent: Agent, signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.withChildOperation(childId, parent, signal, async () => {
      const releaseHold = this.activations.holdOwnership(parent, childId)
      let activation: Activation | undefined
      let operationError: unknown
      try {
        while (true) {
          activation = this.activations.get(childId)
          if (activation?.inbox.closing !== undefined) {
            await this.waitInputProgress(signal, activation.inbox.closing)
            continue
          }
          if (activation === undefined) {
            this.activations.assertChildIdAvailable(childId)
            activation = await this.restoreActivation(parent, childId, signal, true)
          }
          const current = activation
          const agent = current.handle.agent
          const assertHeld = (): void => {
            this.activations.assertAdmitting(parent)
            this.activations.authorizeLineage(parent, childId, agent.session.header.parentSession)
            if (this.activations.get(childId) !== current || current.inbox.closing !== undefined
              || this.ctx.agents.get(childId) !== agent) throw new SubagentError('continuable execution changed', 'ACTIVATION_CLOSING')
            if (!this.ctx.agents.isInputControlled(agent.session)
              || this.ctx.agents.canStartInput(agent) || this.ctx.agents.canClaimInput(agent)) {
              throw new SubagentError('Host maintenance requires held controlled input', 'EXECUTION_NOT_HELD')
            }
          }
          assertHeld()
          await this.waitInputProgress(signal, agent.whenIdle())
          const owned = await this.activations.locks.run(childId, () => {
            signal.throwIfAborted()
            assertHeld()
            return Promise.resolve({ job: agent.runMaintenance(async (maintenanceSignal) => {
              const combined = AbortSignal.any([signal, maintenanceSignal])
              combined.throwIfAborted()
              await this.confirmPreparation(agent.session, combined)
              assertHeld()
              const result = await callback(agent, combined)
              combined.throwIfAborted()
              assertHeld()
              await this.confirmPreparation(agent.session, combined)
              return result
            }) })
          })
          return await owned.job
        }
      } catch (error: unknown) {
        operationError = error
        throw error
      } finally {
        try {
          if (activation?.preparation) {
            if (activation.inbox.hasPending) {
              throw new SubagentError('held execution retains uncaptured pending input; capture custody before release', 'EXECUTION_PENDING_INPUT',
                { cause: operationError })
            }
            await this.activations.releasePrepared(activation)
          }
        } finally { releaseHold() }
      }
    })
  }

  /** Maintain cold input custody without restoring a Preset, Agent or attached Session.
   * @param parent - exact live direct parent authorizing the stored child.
   * @param childId - dormant continuable identity, or an uncreated id absent from its parent catalog.
   * @param input - registered input owner whose Core capability manages all input events.
   * @param signal - caller cancellation during acquisition and callback work.
   * @param callback - stored maintenance; undefined means exclusively observed not-found with no prior catalog record.
   *   Its second signal covers both paths; cancellation still awaits admitted work before releasing custody and reservation.
   * @returns callback result only after revalidation and successful writer disposal.
   */
  async withDormantContinuable<T>(parent: Agent, childId: SessionId, input: InputControllerHandle, signal: AbortSignal,
    callback: (scope: DormantContinuableScope | undefined, signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    this.activations.authorizeLineage(parent, childId, parent.id)
    this.activations.assertDormant(childId)
    return this.withChildOperation(childId, parent, signal, () =>
      this.withDormantSource(parent, childId, input, signal, callback))
  }

  /** Acquire the original writer after the caller has serialized this child's operations. */
  private async withDormantSource<T>(parent: Agent, childId: SessionId, input: InputControllerHandle, signal: AbortSignal,
    callback: (scope: DormantContinuableScope | undefined, signal: AbortSignal) => Promise<T>): Promise<T> {
    const reservation = await this.activations.locks.run(childId, () => {
      signal.throwIfAborted()
      return Promise.resolve(this.activations.reserveDormant(parent, childId))
    })
    const combined = AbortSignal.any([signal, reservation.controller.signal])
    let releaseHold: (() => void) | undefined
    let custody: StoredInputCustody | undefined
    const validate = (source: StoredInputCustodySource): undefined => {
      this.activations.authorizeLineage(parent, childId, source.header.parentSession)
      if (source.header.id !== childId || foldSubagentDescriptor(source.events.slice(source.inheritedEventCount))?.mode !== 'continuable') {
        throw new SubagentError(`subagent "${childId}" has no supported dormant continuation`, 'NOT_RESUMABLE')
      }
      return undefined
    }
    const recheck = async (): Promise<void> => this.activations.locks.run(childId, () => {
      combined.throwIfAborted()
      this.activations.assertAdmitting(parent)
      this.activations.authorizeLineage(parent, childId, parent.id)
      this.activations.assertDormant(childId, reservation)
      if (custody !== undefined) validate(custody.read())
      return Promise.resolve()
    })
    try {
      releaseHold = this.activations.holdOwnership(parent, childId)
      try {
        const read = await this.requirePersistence().open(childId, 'read', { signal: combined })
        try { validate({ header: read.header, events: (await read.read(0, undefined, { signal: combined })).events,
          inheritedEventCount: read.inheritedEventCount }) }
        finally { await read.close() }
      } catch (error: unknown) {
        combined.throwIfAborted()
        if (!(error instanceof SessionPersistenceNotFoundError)) throw error
      }
      try { custody = await input.acquireStoredCustody(childId, combined, validate) }
      catch (error: unknown) {
        combined.throwIfAborted()
        if (!(error instanceof SessionPersistenceNotFoundError)) throw error
        this.assertUncreatedChild(parent, childId, combined)
      }
      await recheck()
      const acquired = custody
      const scope: DormantContinuableScope | undefined = acquired === undefined ? undefined : {
        signal: combined, read: () => acquired.read(), holdPending: ids => acquired.holdPending(ids),
        restoreHeld: ids => acquired.restoreHeld(ids),
        releaseHeld: id => acquired.releaseHeld(id),
      }
      const result = await callback(scope, combined)
      combined.throwIfAborted()
      await recheck()
      if (custody === undefined) {
        this.assertUncreatedChild(parent, childId, combined)
        if (await this.requirePersistence().stat(childId, { signal: combined }) !== undefined) {
          throw new SubagentError(`subagent "${childId}" appeared during dormant maintenance`, 'EXECUTION_NOT_DORMANT')
        }
      }
      return result
    } finally {
      try { if (custody !== undefined) await custody.dispose() }
      finally { releaseHold?.(); reservation.release() }
    }
  }

  /** Keep an input driver or its original stored writer owned across non-waking restoration.
   * @param parent - exact live direct parent.
   * @param childId - descriptor-backed source or an exclusively verified uncreated identity.
   * @param input - registered input owner.
   * @param signal - cancellation while waiting for closing or source writes.
   * @param callback - scoped observation and restoration; no reentrant delivery or lifecycle work.
   * @returns only after the callback and all admitted writes settle.
   */
  async withContinuableInputCustody<T>(parent: Agent, childId: SessionId, input: InputControllerHandle, signal: AbortSignal,
    callback: (scope: ContinuableInputCustodyScope) => Promise<T>): Promise<T> {
    return this.withChildOperation(childId, parent, signal, async () => {
      while (true) {
        signal.throwIfAborted()
        const selected = await this.activations.locks.run<
          { kind: 'stored' } | { kind: 'closing'; done: Promise<void> } | { kind: 'live'; work: Promise<T> }
        >(childId, () => {
          this.activations.assertAdmitting(parent)
          this.activations.authorizeLineage(parent, childId, parent.id)
          const activation = this.activations.get(childId)
          if (activation === undefined) return Promise.resolve({ kind: 'stored' as const })
          if (activation.inbox.closing !== undefined) {
            return Promise.resolve({ kind: 'closing' as const, done: activation.inbox.closing })
          }
          const work = this.activations.withInputCustody(activation, signal, async (ownedSignal) => {
            const agent = activation.handle.agent
            this.activations.authorizeLineage(parent, childId, agent.session.header.parentSession)
            if (this.ctx.agents.inputControlState(agent.session).controllerId !== input.id) {
              throw new SubagentError('continuable input belongs to another controller', 'UNAUTHORIZED')
            }
            await this.confirmPreparation(agent.session, ownedSignal)
            const read = (): StoredInputCustodySnapshot => structuredClone({ header: agent.session.header,
              // oxlint-disable-next-line typescript/no-deprecated -- The retained original driver owns this synchronous observation.
              events: agent.session.snapshotEvents(), inheritedEventCount: agent.session.inheritedEventCount,
              inputControl: this.ctx.agents.inputControlState(agent.session),
              pending: [...agent.inbox.nextStep.map(message => ({ target: 'next-step' as const, message })),
                ...agent.inbox.nextTurn.map(message => ({ target: 'next-turn' as const, message }))] })
            return await this.useInputCustody('live', ownedSignal, read, async (ids) => {
              for (const id of ids) {
                ownedSignal.throwIfAborted()
                const state = read()
                const record = state.inputControl.records.find(record => record.input.message.id === id)
                if (record === undefined || record.location === 'released'
                  || record.location === 'inbox' && !state.pending.some(item => item.message.id === id)) {
                  throw new SubagentError('input restoration requires held custody or its still-pending retry', 'INVALID_ARGUMENT')
                }
                await input.preload(agent, record.input)
              }
            }, callback)
          })
          return Promise.resolve({ kind: 'live' as const, work })
        })
        if (selected.kind === 'closing') { await this.waitInputProgress(signal, selected.done); continue }
        if (selected.kind === 'live') return await selected.work
        return await this.withDormantSource(parent, childId, input, signal, async (stored, ownedSignal) =>
          this.useInputCustody(stored === undefined ? 'absent' : 'stored', ownedSignal,
            () => stored?.read(), async (ids) => {
              if (stored !== undefined) await stored.restoreHeld(ids)
              else if (ids.length > 0) throw new SubagentError('continuable input does not exist', 'NOT_RESUMABLE')
            }, callback))
      }
    })
  }

  /** Expire a borrowed reader on return and drain admitted writes before releasing its owner. */
  private async useInputCustody<T>(source: ContinuableInputCustodyScope['source'], signal: AbortSignal,
    read: () => StoredInputCustodySnapshot | undefined, restore: (ids: readonly MessageId[]) => Promise<void>,
    callback: (scope: ContinuableInputCustodyScope) => Promise<T>): Promise<T> {
    const closed = new AbortController()
    const scopedSignal = AbortSignal.any([signal, closed.signal])
    const jobs: Promise<void>[] = []
    const scope: ContinuableInputCustodyScope = { source, signal: scopedSignal,
      read: () => { scopedSignal.throwIfAborted(); return read() },
      restoreHeld: (ids) => {
        scopedSignal.throwIfAborted()
        const work = Promise.resolve().then(async () => { signal.throwIfAborted(); await restore(ids); signal.throwIfAborted() })
        jobs.push(work)
        void work.catch(() => undefined)
        return work
      } }
    try { return await callback(scope) }
    finally {
      closed.abort(new SubagentError('continuable input custody has expired', 'ACTIVATION_CLOSING'))
      const outcomes = await Promise.allSettled(jobs)
      signal.throwIfAborted()
      const failures = outcomes.flatMap((item) => {
        if (item.status !== 'rejected') return []
        const reason: unknown = item.reason
        return [reason]
      })
      if (failures.length > 0) throw new AggregateError(failures, 'continuable input restoration was not confirmed')
    }
  }

  /** A lost existing child is unavailable; only ids with no durable parent catalog entry are uncreated. */
  private assertUncreatedChild(parent: Agent, childId: SessionId, signal: AbortSignal): void {
    signal.throwIfAborted()
    this.activations.authorizeLineage(parent, childId, parent.id)
    const catalog = this.ctx.get('sessionProjections')?.snapshot(parent.session, ['subagentCatalog'])
      .values.subagentCatalog as readonly SubagentCatalogEntry[] | undefined
    if (catalog === undefined || catalog.some(entry => entry.id === childId)) {
      throw new SubagentError(`subagent "${childId}" has no available stored source`, 'SOURCE_UNAVAILABLE')
    }
  }

  /**
   * Checkpoint a reserved child's creation without delivering an input.
   * @param spec - exact parent and immutable, retry-stable creation specification.
   * @returns the identity after child and parent catalog durability confirmation.
   */
  async prepareContinuable(spec: ContinuablePrepareSpec): Promise<ContinuablePrepared> {
    const creation = this.snapshotCreation(spec)
    const { childId, signal, request: { parent } } = spec
    return this.withChildOperation(childId, parent, signal, async () => {
      const cwd = spec.cwd === undefined ? undefined : await this.resolveCwd(spec.cwd, signal)
      const releaseHold = this.activations.holdOwnership(parent, childId)
      let candidate: Activation | undefined
      try {
        const live = this.requireSessions().get(childId)
        if (live !== undefined) await this.confirmPreparation(live, signal)
        const persisted = await this.requirePersistence().stat(childId, { signal })
        signal.throwIfAborted()
        this.activations.assertAdmitting(parent)
        let header: SessionHeader
        if (persisted === undefined && live === undefined) {
          this.assertUncreatedChild(parent, childId, signal)
          this.activations.assertChildIdAvailable(childId)
          const prepared = await this.host.prepareContinuable(spec.provider, { sessionId: childId, parent, signal })
          signal.throwIfAborted()
          this.activations.assertAdmitting(parent)
          this.activations.assertChildIdAvailable(childId)
          if (cwd !== undefined && await this.resolveCwd(cwd, signal) !== cwd) {
            throw new SubagentError('continuable execution directory changed before creation', 'PREPARATION_MISMATCH')
          }
          candidate = await this.activations.materialize({ childId, provider: spec.provider, parent,
            create: { seed: prepared.seed,
              meta: { ...childSessionMeta(parent, creation.childDepth, prepared.seed !== undefined, cwd),
                ...spec.preset === undefined ? {} : { agentPreset: spec.preset.id } },
              inheritedEventCount: SessionLogOffset(prepared.seed?.length ?? 0),
              delegatedPolicies: creation.delegatedPolicies, descriptor: creation.descriptor },
            agentOptions: creation.agentOptions,
            composition: { persona: spec.request.persona, toolFilter: spec.request.toolFilter },
            ...spec.preset === undefined ? {} : { preset: spec.preset }, preparation: true, signal })
          await this.confirmPreparation(candidate.handle.agent.session, signal)
          header = candidate.handle.agent.session.header
        } else {
          if (spec.preset !== undefined) {
            const registry = this.ctx.get('agentPresets')
            if (registry === undefined) throw new SubagentError('explicit preparation requires the Agent Preset registry', 'NOT_RESUMABLE')
            await using lease = await registry.acquireComposition(spec.preset.id)
            if (lease.revision !== spec.preset.revision) {
              throw new SubagentError(`continuable preset "${spec.preset.id}" declaration changed`, 'PREPARATION_MISMATCH')
            }
          }
          using observed = await this.requireSessionQuery().observeSession(childId, { signal })
          this.activations.authorizeLineage(parent, childId, observed.header.parentSession)
          const own = observed.events.slice(observed.inheritedEventCount)
          const expectedMeta = childSessionMeta(parent, creation.childDepth, observed.header.isSeeded, cwd)
          if (!isDeepStrictEqual(foldSubagentDescriptor(own), creation.descriptor)
            || !isDeepStrictEqual(foldContinuablePreset(own), spec.preset)
            || observed.header.origin !== 'subagent' || observed.header.cwd !== expectedMeta.cwd
            || observed.header.delegationDepth !== creation.childDepth
            || observed.header.agentPreset !== (spec.preset?.id ?? expectedMeta.agentPreset)) {
            throw new SubagentError(`subagent "${childId}" creation specification changed`, 'PREPARATION_MISMATCH')
          }
          header = observed.header
        }
        using parentView = await this.requireSessionQuery().observeSession(parent.id, { signal })
        const catalog = parentView.projections?.values.subagentCatalog
        if (catalog === undefined) throw new SubagentError('preparation requires the child catalog projection', 'NOT_RESUMABLE')
        const entries = catalog.filter(entry => entry.id === childId)
        if (entries.length === 0) establishCatalogChild(parent.session, header, creation.descriptor)
        else if (entries.length !== 1 || entries[0]?.mode !== 'continuable'
          || entries[0].createdAt !== header.createdAt || entries[0].label !== spec.label) {
          throw new SubagentError(`subagent "${childId}" parent catalog changed`, 'PREPARATION_MISMATCH')
        }
        await this.confirmPreparation(parent.session, signal)
        this.activations.assertAdmitting(parent)
        return { childId }
      } finally {
        try { if (candidate !== undefined) await this.activations.releasePrepared(candidate) }
        finally { releaseHold() }
      }
    })
  }

  /** Require an installed durability listener; an in-memory candidate is not prepared. */
  private async confirmPreparation(session: Session, signal: AbortSignal): Promise<void> {
    if (!await this.requireSessions().flush(session)) {
      throw new SubagentError('continuable preparation has no durability acknowledgement', 'PREPARATION_NOT_DURABLE')
    }
    signal.throwIfAborted()
  }

  /** Serialize identified operations while releasing the child lock for all external waits. */
  private async withChildOperation<T>(childId: SessionId, parent: Agent, signal: AbortSignal,
    operation: () => Promise<T>): Promise<T> {
    while (true) {
      signal.throwIfAborted()
      const settled = Promise.withResolvers<void>()
      const reservation = await this.activations.locks.run(childId, () => {
        this.activations.assertAdmitting(parent)
        const previous = this.childOperations.get(childId)
        if (previous === undefined) this.childOperations.set(childId, settled.promise)
        return Promise.resolve({ previous })
      })
      if (reservation.previous !== undefined) {
        await this.waitInputProgress(signal, reservation.previous)
        continue
      }
      try { return await operation() }
      finally { this.childOperations.delete(childId); settled.resolve() }
    }
  }

  /**
   * Start one continuable background child and resolve at initial inbox acceptance.
   * Synchronous admission failures roll back the child. Controlled receipt
   * failures retain uncertain input for retry with the caller-reserved identity.
   * @param spec - provider, delegation request, and caller cancellation.
   * @returns the durable child id and accepted initial prompt message id.
   */
  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    const request = spec.request
    const parent = request.parent
    this.activations.assertAdmitting(parent)
    const cwd = spec.cwd === undefined ? undefined : await this.resolveCwd(spec.cwd, spec.signal)
    const persistence = this.requirePersistence()
    const childId = spec.childId ?? brandString<SessionId>(randomUUID())
    this.activations.assertChildIdAvailable(childId)
    const { childDepth, agentOptions, descriptor, delegatedPolicies } = this.snapshotCreation(spec)

    // An idle continuation-managed parent must not settle while a caller is
    // still creating its child. A turn-scoped delegation does not need this,
    // but the service is also callable outside a turn.
    const releaseHold = this.activations.holdOwnership(parent, childId)
    try {
      const prepared = await this.host.prepareContinuable(spec.provider, {
        sessionId: childId,
        parent,
        signal: spec.signal,
      })
      spec.signal.throwIfAborted()
      this.activations.assertAdmitting(parent)

      const inheritedEventCount = SessionLogOffset(prepared.seed?.length ?? 0)
      const seed = prepared.seed
      const submission = await this.activations.locks.run(childId, async () => {
        spec.signal.throwIfAborted()
        this.activations.assertAdmitting(parent)
        this.activations.assertChildIdAvailable(childId)
        if (spec.childId !== undefined) {
          const persisted = await persistence.stat(childId, { signal: spec.signal })
          spec.signal.throwIfAborted()
          this.activations.assertAdmitting(parent)
          this.activations.assertChildIdAvailable(childId)
          if (persisted !== undefined) {
            throw new SubagentError(`subagent "${childId}" already exists`, 'DUPLICATE_CHILD')
          }
          this.assertUncreatedChild(parent, childId, spec.signal)
        }
        if (cwd !== undefined && await this.resolveCwd(cwd, spec.signal) !== cwd) {
          throw new SubagentError('continuable execution directory changed before creation', 'PREPARATION_MISMATCH')
        }
        const activation = await this.activations.materialize({
          childId,
          provider: spec.provider,
          parent,
          create: {
            seed,
            meta: {
              ...childSessionMeta(parent, childDepth, prepared.seed !== undefined, cwd),
              ...spec.preset === undefined ? {} : { agentPreset: spec.preset.id },
            },
            inheritedEventCount,
            delegatedPolicies,
            descriptor,
          },
          agentOptions,
          composition: { persona: request.persona, toolFilter: request.toolFilter },
          ...spec.preset === undefined ? {} : { preset: spec.preset },
          signal: spec.signal,
        })
        const childHeader = activation.handle.agent.session.header
        return await this.submitMaterialized(
          activation,
          isAdjacentAgentSendMessageTool(this.ctx.get('tools')?.get('send_message', activation.handle.agent))
            ? withContinuableReturnGuidance(parent.id, request.prompt)
            : request.prompt,
          { source: spec.initialSource ?? { kind: 'user' }, signal: spec.signal, delivery: 'queue',
            ...spec.initialMessageId === undefined ? {} : { messageId: spec.initialMessageId } },
          parent,
          () => { establishCatalogChild(parent.session, childHeader, descriptor) },
        )
      })
      return { childId, ...await this.confirmSubmission(submission) }
    } catch (error: unknown) {
      releaseHold()
      throw error
    }
  }

  /**
   * Start or resume a caller-reserved child and checkpoint one identified input.
   * Concurrent callers share a child-local reservation without holding its
   * execution lock while waiting for receipt or teardown.
   * @param spec - creation inputs and reserved child identity.
   * @param input - host-owned message whose id is stable across retries.
   * @returns durable input identities or an explicit held/released custody location.
   */
  async deliverContinuableInput(
    spec: ContinuableStartSpec & { readonly childId: SessionId },
    input: UserMessage,
  ): Promise<ContinuableStart> {
    const { childId, signal } = spec
    return this.withChildOperation(childId, spec.request.parent, signal, async () => {
      const cwd = spec.cwd === undefined ? undefined : await this.resolveCwd(spec.cwd, signal)
      while (true) {
        signal.throwIfAborted()
        const session = this.requireSessions().get(childId)
        if (session !== undefined) {
          this.activations.authorizeLineage(spec.request.parent, childId, session.header.parentSession)
          this.assertCwd(session.header, cwd)
          await this.requireSessions().flush(session)
          if (this.liveInputRecorded(session, input.id)) {
            return { childId, messageId: input.id }
          }
        } else {
          const stored = await this.requirePersistence().stat(childId, { signal })
          if (stored !== undefined) {
            using observed = await this.requireSessionQuery().observeSession(childId, { signal })
            this.activations.authorizeLineage(spec.request.parent, childId, observed.header.parentSession)
            this.assertCwd(observed.header, cwd)
            if (this.inputRecorded(observed.events.slice(observed.inheritedEventCount), input.id)) {
              return { childId, messageId: input.id }
            }
          }
        }
        const running = await this.activations.locks.run(childId, () => {
          const activation = this.activations.get(childId)
          return Promise.resolve(activation === undefined ? undefined : {
            activation,
            closing: activation.inbox.closing,
            accepted: this.acceptedInputs.get(activation)?.has(input.id) === true,
          })
        })
        if (running?.closing !== undefined) {
          await this.waitInputProgress(signal, running.closing)
          continue
        }
        if (running?.accepted && !this.ctx.agents.isInputControlled(running.activation.handle.agent.session)) {
          await this.waitForReceiptProgress(childId, input.id, signal)
          continue
        }
        const stored = await this.requirePersistence().stat(childId, { signal })
        if (stored === undefined && running === undefined) {
          this.assertUncreatedChild(spec.request.parent, childId, signal)
          const accepted = await this.startContinuable({ ...spec, initialSource: input.source,
            initialMessageId: input.id, request: { ...spec.request, prompt: [...input.content] } })
          if (accepted.inputLocation !== undefined) return accepted
        } else {
          const accepted = await this.deliverToChild(spec.request.parent, childId, [...input.content], {
            source: input.source, messageId: input.id, signal, delivery: 'steer',
          })
          if (accepted.inputLocation !== undefined) return { childId, ...accepted }
        }
      }
    })
  }

  /** Test a host-reserved input identity in the child's own persisted history. */
  private requireSessions() {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new SubagentError('identified delivery requires the Session service', 'NOT_RESUMABLE')
    return sessions
  }

  /** Test a host-reserved input identity in the child's own persisted history. */
  private inputRecorded(events: readonly SessionEvent[], id: MessageId): boolean {
    return events.some(event => event.type === 'user/message' && event.data.id === id)
  }

  private liveInputRecorded(session: Session, id: MessageId): boolean {
    return this.ctx.get('sessionProjections')?.stateOf(session, 'subagentInputReceipts')?.includes(id) === true
  }

  /** Wait for a reservation or teardown without retaining the child's lock. */
  private async waitInputProgress(signal: AbortSignal, progress: Promise<unknown>): Promise<void> {
    signal.throwIfAborted()
    const aborted = Promise.withResolvers<never>()
    const onAbort = (): void => { aborted.reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    try { await Promise.race([progress, aborted.promise]) }
    finally { signal.removeEventListener('abort', onAbort) }
  }

  /** Observe log or residency progress; register before the receipt recheck. */
  private async waitForReceiptProgress(childId: SessionId, messageId: MessageId, signal: AbortSignal): Promise<void> {
    const progress = Promise.withResolvers<void>()
    const stopEvent = this.ctx.on('session/event', (session) => {
      if (session.id === childId) progress.resolve()
    })
    const stopDisposed = this.ctx.on('session/disposed', (session) => {
      if (session.id === childId) progress.resolve()
    })
    try {
      const session = this.requireSessions().get(childId)
      if (session === undefined || this.activations.get(childId) === undefined) return
      await this.requireSessions().flush(session)
      if (this.activations.get(childId) === undefined
        || this.liveInputRecorded(session, messageId)) return
      await this.waitInputProgress(signal, progress.promise)
    } finally { stopDisposed(); stopEvent() }
  }

  /**
   * Deliver one model-authored message to a direct continuable child or to the
   * sender's direct parent. A missing direct child cold-resumes through the
   * ordinary continuation lifecycle.
   * @param sender - exact live Agent authorizing and originating the message.
   * @param targetId - durable direct-parent or direct-child session id.
   * @param content - model-authored content to deliver.
   * @param options - caller cancellation before acceptance.
   * @returns the accepted message's inbox id.
   */
  async sendMessage(
    sender: Agent,
    targetId: SessionId,
    content: ContentBlock[],
    options: SubagentSendMessageOptions,
  ): Promise<MessageId> {
    if (this.ctx.agents.get(sender.id) !== sender) {
      throw new SubagentError(
        'message delivery requires the exact live sender agent',
        'UNAUTHORIZED',
      )
    }
    this.activations.assertAdmitting(sender)
    const senderActivation = this.activations.get(sender.id)
    if (senderActivation !== undefined
      && senderActivation.handle.agent === sender
      && senderActivation.parentSession === targetId) {
      options.signal.throwIfAborted()
      return this.sendToParent(senderActivation, sender, content)
    }
    if (sender.session.header.parentSession === targetId) {
      throw new SubagentError(
        `agent "${sender.id}" is not a resident continuable child and cannot send to parent "${targetId}"`,
        'UNAUTHORIZED',
      )
    }
    return (await this.deliverToChild(sender, targetId, content, {
      signal: options.signal,
      delivery: 'steer',
    })).messageId
  }

  /**
   * Queue one human-authored prompt as a distinct direct-child turn.
   * @param parent - exact live direct parent authorizing delivery.
   * @param childId - durable direct-child session id.
   * @param content - model-visible prompt blocks.
   * @param source - durable attribution for the human prompt.
   * @param signal - caller cancellation before inbox acceptance.
   * @returns the accepted durable message id.
   */
  async queuePrompt(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
  ): Promise<MessageId> {
    return (await this.deliverToChild(parent, childId, content, { source, signal, delivery: 'queue' })).messageId
  }

  /**
   * Steer one host-authored prompt to a direct continuable child.
   * @param parent - exact live direct parent authorizing delivery.
   * @param childId - durable direct-child session id.
   * @param content - model-visible prompt blocks.
   * @param source - durable attribution for the host prompt.
   * @param signal - caller cancellation before inbox acceptance.
   * @returns the accepted durable message id.
   */
  async steerPrompt(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    source: MessageSource,
    signal: AbortSignal,
  ): Promise<MessageId> {
    return (await this.deliverToChild(parent, childId, content, { source, signal, delivery: 'steer' })).messageId
  }

  /** Route one parent-originated delivery through residency and cold resume. */
  private async deliverToChild(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<Pick<ContinuableStart, 'messageId' | 'inputLocation'>> {
    this.activations.assertAdmitting(parent)
    const releaseHold = this.activations.holdOwnership(parent, childId)
    try {
      return await this.deliverFollowup(parent, childId, content, options)
    } catch (error: unknown) {
      releaseHold()
      throw error
    }
  }

  /** The delivery loop behind {@link deliverToChild}, run under the parent hold. */
  private async deliverFollowup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<Pick<ContinuableStart, 'messageId' | 'inputLocation'>> {
    while (true) {
      const live = await this.activations.locks.run(childId, async () => {
        const activation = this.activations.get(childId)
        if (activation === undefined) return this.coldResume(parent, childId, content, options)
        const disposal = activation.inbox.closing
        /* v8 ignore next 3 -- the send-versus-dispose cutoff needs a delivery to
         * observe the transaction inside the same critical section that opened it. */
        if (disposal !== undefined) {
          return disposal.then(() => undefined, () => undefined)
        }
        if (contentHasImage(content)) {
          await this.assertImageCapable(activation.handle.agent, options.signal)
          if (activation.inbox.closing !== undefined) {
            await Promise.allSettled([activation.inbox.closing])
            return undefined
          }
        }
        return this.publishSubmission(activation, this.submitAdmitted(activation, content, options, parent))
      })
      /* v8 ignore start -- only a delivery that lost the disposal cutoff retries. */
      if (live !== undefined) return this.confirmSubmission(live)
      this.activations.assertAdmitting(parent)
      options.signal.throwIfAborted()
      /* v8 ignore stop */
    }
  }

  /**
   * Interrupt one live continuable child's current turn. Admission is
   * synchronous and the cancellation effect is asynchronous. An absent or
   * already-closing target is an accepted no-op after authority checks.
   * @param targetSessionId - the durable child session id to interrupt.
   * @param authority - the human parent address or exact live ancestor Agent.
   */
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    this.activations.interrupt(targetSessionId, authority)
  }

  /** Deliver one resident continuable child's message to its live direct parent. */
  private async sendToParent(
    activation: Activation,
    sender: Agent,
    content: ContentBlock[],
  ): Promise<MessageId> {
    /* v8 ignore next 6 -- only synchronous re-entrant teardown can open this
     * transaction between exact-agent authorization and this no-await span. */
    if (activation.inbox.closing !== undefined) {
      throw new SubagentError(
        `subagent "${sender.id}" activation is being disposed; the message was not delivered`,
        'ACTIVATION_CLOSING',
      )
    }
    const parent = this.ctx.agents.get(activation.parentSession)
    if (parent === undefined) {
      throw new SubagentError(
        'direct parent is not live; the message was not delivered',
        'PARENT_UNAVAILABLE',
      )
    }
    const message = createAgentMessage(sender, content)
    const receipt = this.sendAgentMessage(parent, message)
    if (receipt !== undefined) await receipt
    return message.id
  }

  /** Send one Agent message while translating only the target's own rejection. */
  private sendAgentMessage(
    parent: Agent,
    message: ReturnType<typeof createUserMessage>,
  ): ReturnType<ContinuableActivationRegistry['sendWaking']> {
    try {
      const receipt = this.activations.sendWaking(parent, message, 'steer')
      return receipt?.catch((error: unknown) => {
        throw new SubagentError('direct parent did not acknowledge durable receipt', 'PARENT_UNAVAILABLE', { cause: error })
      })
    } catch (error: unknown) {
      throw new SubagentError(
        'direct parent is not live; the message was not delivered',
        'PARENT_UNAVAILABLE',
        { cause: error },
      )
    }
  }

  /** Close manager-wide admission and release every live Activation. */
  async drain(): Promise<void> {
    await this.activations.drain()
  }

  /**
   * Stop only the continuable descendants of exact live host-owned parents.
   * @param parents - exact live roots whose continuable descendants must stop.
   */
  async drainDescendants(parents: readonly Agent[]): Promise<void> {
    await this.activations.drainDescendants(parents)
  }

  /**
   * Release selected resident direct children of one exact live parent.
   * @param parent - exact live direct parent authorizing the selected release.
   * @param childIds - durable direct-child ids to release when resident.
   */
  async drainChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void> {
    await this.activations.drainChildren(parent, childIds)
  }

  /**
   * Cold-resume a persisted child and submit the waiting turn. The descriptor
   * supplies every reconstruction input; no subagent provider is dispatched.
   */
  private async coldResume(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
  ): Promise<SubmittedInput> {
    const activation = await this.restoreActivation(parent, childId, options.signal)
    return await this.submitMaterialized(activation, content, options, parent)
  }

  /** Reconstruct composition from the child's own persisted descriptor, never from a provider. */
  private async restoreActivation(parent: Agent, childId: SessionId, signal: AbortSignal,
    preparation = false): Promise<Activation> {
    const query = this.requireSessionQuery()
    let observation: SessionObservation
    try {
      observation = await query.observeSession(childId, {
        signal,
      })
    } catch (error: unknown) {
      signal.throwIfAborted()
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    using source = observation
    this.activations.assertAdmitting(parent)
    this.activations.authorizeLineage(parent, childId, source.header.parentSession)
    const descriptor = foldSubagentDescriptor(
      source.events.slice(source.inheritedEventCount),
    )
    const preset = foldContinuablePreset(source.events.slice(source.inheritedEventCount))
    if (descriptor === undefined || descriptor.mode !== 'continuable') {
      throw new SubagentError(
        `subagent "${childId}" has no supported continuation state and cannot be resumed; choose a different target`,
        'NOT_RESUMABLE',
      )
    }
    let activation: Activation
    try {
      activation = await this.activations.materialize({
        childId,
        provider: descriptor.provider,
        parent,
        agentOptions: {
          ...descriptor.agentProvider !== undefined ? { provider: descriptor.agentProvider } : {},
          ...descriptor.agentModel !== undefined ? { model: descriptor.agentModel } : {},
          ...descriptor.agentReasoningEffort !== undefined
            ? { reasoningEffort: ReasoningEffortId(descriptor.agentReasoningEffort) }
            : {},
        },
        composition: { persona: descriptor.persona, toolFilter: descriptor.toolFilter },
        ...preset === undefined ? {} : { preset },
        ...preparation ? { preparation: true } : {}, signal,
      })
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SubagentError) throw error
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    return activation
  }

  /** Admit a materialized child, commit its creation fact, and release it on failure. */
  private async submitMaterialized(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
    commit?: () => void,
  ): Promise<SubmittedInput> {
    try {
      await this.ctx.serial('subagent/continuable-admission', activation.handle.agent)
      if (contentHasImage(content)) {
        await this.assertImageCapable(activation.handle.agent, options.signal)
        if (activation.inbox.closing !== undefined) {
          throw new SubagentError(`subagent "${activation.childId}" is closing`, 'ACTIVATION_CLOSING')
        }
      }
      return this.publishSubmission(activation, this.submitAdmitted(activation, content, options, parent), commit)
    } catch (error: unknown) {
      try {
        await this.activations.dispose(activation)
      } catch (cleanupError: unknown) {
        this.ctx.logger.warn(
          `subagent continuation: disposal after admission or catalog append failure also failed: ${String(cleanupError)}`,
        )
      }
      throw error
    }
  }

  /** Keep synchronous admission unchanged; controlled custody commits after its receipt. */
  private publishSubmission(activation: Activation, submission: SubmittedInput, commit?: () => void): SubmittedInput {
    const accepted = (executable: boolean): void => {
      if (commit !== undefined && executable) activation.observer.initialInput(submission.messageId)
      commit?.()
      if (executable) activation.announced = true
    }
    if (submission.receipt === undefined) {
      accepted(true)
      return submission
    }
    return { messageId: submission.messageId, receipt: submission.receipt.then((receipt) => {
      accepted(receipt.location === 'inbox')
      return receipt
    }) }
  }

  /** Await controlled receipt outside the child lock; custody is not model execution. */
  private async confirmSubmission(submission: SubmittedInput): Promise<Pick<ContinuableStart, 'messageId' | 'inputLocation'>> {
    if (submission.receipt === undefined) return { messageId: submission.messageId }
    const receipt = await submission.receipt
    return { messageId: submission.messageId, inputLocation: receipt.location }
  }

  /** Build and submit one message across the final synchronous admission cutoff. */
  private submitAdmitted(
    activation: Activation,
    content: ContentBlock[],
    options: ChildDeliveryOptions,
    parent: Agent,
  ): SubmittedInput {
    if (options.messageId !== undefined && !this.ctx.agents.isInputControlled(activation.handle.agent.session)
      && [...activation.handle.agent.inbox.nextTurn,
        ...activation.handle.agent.inbox.nextStep].some(message => message.id === options.messageId)) {
      const agent = activation.handle.agent
      if (agent.wakePending === undefined) {
        throw new SubagentError('continuable input recovery requires a driver that can wake its durable inbox', 'NOT_RESUMABLE')
      }
      agent.wakePending()
      this.recordAcceptedInput(activation, options.messageId)
      return { messageId: options.messageId }
    }
    const message = options.source === undefined
      ? createAgentMessage(parent, content)
      : createUserMessage({ content, source: options.source })
    const identified = options.messageId === undefined ? message : Object.freeze({ ...message, id: options.messageId })
    const previous = this.ctx.agents.inputControlState(activation.handle.agent.session).records
      .find(record => record.input.message.id === identified.id)
    const original = previous?.originalInput ?? previous?.input
    const originalTarget = original?.requestedTarget ?? original?.target
    const submission = this.activations.submitAdmitted(
      activation,
      identified,
      originalTarget === undefined ? options.delivery : originalTarget === 'next-turn' ? 'queue' : 'steer',
      parent,
      options.signal,
    )
    this.recordAcceptedInput(activation, submission.messageId)
    return submission
  }

  /** Retain one accepted identity for both queued wake-up and ordinary delivery. */
  private recordAcceptedInput(activation: Activation, messageId: MessageId): void {
    let accepted = this.acceptedInputs.get(activation)
    if (accepted === undefined) {
      accepted = new Set()
      this.acceptedInputs.set(activation, accepted)
    }
    accepted.add(messageId)
  }

  /** Refuse image content for a child whose fixed model accepts text only. */
  private async assertImageCapable(
    agent: Agent,
    signal: AbortSignal,
  ): Promise<void> {
    const { provider, model } = agent.options
    if (provider === undefined || model === undefined) return
    const llm = this.ctx.get('llm')
    /* v8 ignore next -- without an LLM registry, delivery defers to projection. */
    if (llm === undefined) return
    const info = await llm.resolveModelInfo(provider, model, signal)
    if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
      throw new SubagentError(
        `Model "${model}" does not support image input.`,
        'MODEL_DOES_NOT_SUPPORT_IMAGES',
      )
    }
  }

  /** Resolve the persistence service continuable children require, or fail loud. */
  private requirePersistence(): SessionPersistence {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new SubagentError(
        'continuable subagents require session persistence (load a dsh-session-persistence backend)',
        'PERSISTENCE_UNAVAILABLE',
      )
    }
    return persistence
  }

  /** Resolve the Session query service used for cold child observations. */
  private requireSessionQuery(): SessionQueryEngine {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) {
      throw new SubagentError(
        'continuable subagents require session query (load @deepseek-ai/dsh-session-query)',
        'CONTINUATION_UNAVAILABLE',
      )
    }
    return query
  }
}

export default SubagentContinuationManager
