/** Optional provider-owned input control; ordinary drivers keep synchronous receipt. */

import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Agent, SessionStartSource } from './runtime-types.ts'
import type { AgentInput, AgentInputMutation, InputControllerId as ControllerId, InputControlState, InputReceipt } from './input-control-types.ts'
import type { StoredInputCustody, StoredInputCustodySource, StoredInputDriver } from './input-control-types.ts'
import { acquireStoredInputCustody, capturePendingInput, releaseHeldInput, selectedPendingInput } from './input-control-stored.ts'
/** Stable identity of one optional input policy provider. */
export type InputControllerId = ControllerId

/** Brand a provider's stable registration identity.
 * @param id - configuration-owned identity.
 * @returns the same string with the controller brand.
 */
export function InputControllerId(id: string): ControllerId { return id as ControllerId }

/** Decision before an ordinary input becomes executable. */
export type InputAdmission = { readonly kind: 'accept' | 'hold' }
  | { readonly kind: 'reject'; readonly reason: string }

/** Policy callbacks do not enqueue, drive, or grant tool authority. */
export interface AgentInputController {
  admit(agent: Agent, input: AgentInput): InputAdmission
  canStart(agent: Agent): boolean
  canClaim(agent: Agent): boolean
  prepare?(session: Session): Promise<void>
  /** Finish owner-controlled pending-input disposition before the concrete inbox claims a batch.
   * @param agent - exact receiving execution.
   * @param signal - current driver cancellation; preparation owns its admitted writes through settlement.
   * @returns after queue/custody confirmation without submitting model work.
   */
  prepareClaim?(agent: Agent, signal: AbortSignal): Promise<void>
  /** Bind or validate an unpublished Session before its scoped composition mounts.
   * @param session - Session under the factory's exclusive preparation ownership.
   * @param source - fresh creation or persisted resumption.
   * @returns preparation work, or undefined when this provider does not own the Session.
   */
  initialize?(session: Session, source: SessionStartSource): Promise<void> | void
}

/** Concrete driver operations; only the registered provider can preload. */
export interface ControlledInputDriver {
  resolve(input: AgentInput): AgentInput
  enqueue(input: AgentInput, prepend: boolean): void
  wake(): void
  remove(messageId: MessageId): boolean
  replace(messageId: MessageId, message: UserMessage): boolean
  hold(messageId: MessageId): boolean
}

/** Host provider capabilities remain tied to their registration lifetime. */
export interface InputControllerHandle {
  readonly id: ControllerId
  bind(session: Session): void
  preload(agent: Agent, input: AgentInput, prepend?: boolean): Promise<InputReceipt>
  release(agent: Agent, messageId: MessageId): Promise<void>
  /** Preserve pending, audited input outside the executable queue before transfer.
   * @param agent - provider-bound receiving execution.
   * @returns the captured input in its current queue order, after durable confirmation.
   */
  holdPending(agent: Agent, messageIds?: readonly MessageId[]): Promise<readonly AgentInput[]>
  /** Own an inactive original Session's input without restoring its Agent or composition.
   * @param sessionId - existing persisted source owned by this controller.
   * @param signal - caller cancellation; a late acquired writer is still closed.
   * @param validate - optional synchronous validation of the exclusive original cut before repair or any source write.
   * @returns an exclusive custody capability after source repair durability is confirmed.
   */
  acquireStoredCustody(sessionId: SessionId, signal: AbortSignal,
    validate?: (source: StoredInputCustodySource) => undefined): Promise<StoredInputCustody>
  dispose(): Promise<void>
}

/** Pending input cannot be changed, and no uncertain removal remains to confirm. */
export class InputMutationUnavailableError extends Error {
  /** @param messageId - input identity whose pending mutation is unavailable. */
  constructor(readonly messageId: MessageId) {
    super('controlled input is no longer pending or has no recorded intent')
    this.name = 'InputMutationUnavailableError'
  }
}

interface Registration {
  readonly id: ControllerId
  readonly policy: AgentInputController
  readonly jobs: Set<Promise<unknown>>
  active: boolean
  readonly lifetime: AbortController
  readonly stored: Set<StoredInputCustody>
}

interface DriverEntry {
  readonly driver: ControlledInputDriver
  readonly jobs: Set<Promise<unknown>>
  readonly uncertain: Set<MessageId>
  tail: Promise<void>
  wakeRequested: boolean
  active: boolean
}

/** Registry implementation shared by policy providers and the default driver. */
export class AgentInputControls {
  private readonly policies = new Map<ControllerId, Registration>()
  private readonly drivers = new WeakMap<Agent, DriverEntry>()
  private readonly lifetime = new AbortController()

  constructor(private readonly ctx: Context, private readonly prepareStoredInput: (session: Session) => StoredInputDriver) {
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('input-control registry is closed'))
      await Promise.all([...this.policies.values()].flatMap(entry => [...entry.stored].map(scope => scope.dispose())))
    }, 'agents.storedInputCustody()')
  }

  /** Read one driver-owned fold, never a fork-inherited policy binding.
   * @param session - exact Session, including unpublished factory preparations.
   * @returns required policy and receipt state; absence rejects instead of opening execution.
   */
  state(session: Session): InputControlState {
    const projections = this.ctx.get('sessionProjections')
    const state = projections?.stateOf(session, 'inputControl')
    if (state === undefined) throw new Error('input-control projection is not registered')
    return state
  }

  /** Register the concrete driver's owned callbacks and drain them on teardown.
   * @param agent - driver identity under its scoped lifecycle.
   * @param driver - non-waking mutation and wake operations.
   * @returns an owner-scoped disposer that closes admission and awaits pending receipts.
   */
  attach(agent: Agent, driver: ControlledInputDriver): () => Promise<void> {
    if (this.drivers.has(agent)) throw new Error('input driver is already registered')
    const entry: DriverEntry = { driver, jobs: new Set(), uncertain: new Set(),
      tail: Promise.resolve(), wakeRequested: false, active: true }
    this.drivers.set(agent, entry)
    return agent.ctx.effect(() => async () => {
      entry.active = false
      await Promise.allSettled([...entry.jobs])
      this.drivers.delete(agent)
    }, 'agents.inputDriver()')
  }

  /** Register one stable policy; removal leaves existing Sessions closed.
   * @param owner - provider lifetime.
   * @param id - immutable durable binding identity.
   * @param policy - admission, preparation and execution decisions.
   * @returns exclusive mutation capabilities whose removal drains admitted operations.
   */
  register(owner: Context, id: ControllerId, policy: AgentInputController): InputControllerHandle {
    if (!id) throw new Error('input controller id is empty')
    if (this.policies.has(id)) throw new Error(`input controller "${id}" is already registered`)
    const entry: Registration = { id, policy, jobs: new Set(), active: true, lifetime: new AbortController(), stored: new Set() }
    const dispose = owner.effect(() => {
      this.policies.set(id, entry)
      return async () => {
        entry.active = false
        entry.lifetime.abort(new Error('input controller registration is closed'))
        await Promise.all([...entry.stored].map(scope => scope.dispose()))
        await Promise.allSettled([...entry.jobs])
        this.policies.delete(id)
      }
    }, 'agents.inputController()')
    return { id,
      bind: (session) => {
        this.assertActive(entry)
        const state = this.state(session)
        if (state.controllerId === id) return
        if (state.controllerId !== null) throw new Error('Session already has another input controller')
        session.append('agent/input/controller-bound', { version: 1, controllerId: id })
      },
      preload: (agent, input, prepend = false) => this.deliver(agent, input, { entry, prepend }),
      release: (agent, messageId) => this.release(entry, agent, messageId),
      holdPending: (agent, messageIds) => this.holdPending(entry, agent, messageIds),
      acquireStoredCustody: (sessionId, signal, validate) => {
        const combined = AbortSignal.any([signal, entry.lifetime.signal, this.lifetime.signal])
        const job = acquireStoredInputCustody(this.ctx, sessionId, combined, {
          assertActive: () => { this.assertActive(entry) },
          controllerId: entry.id,
          state: session => this.state(session),
          prepareDriver: this.prepareStoredInput,
          acquired: (scope) => { this.assertActive(entry); entry.stored.add(scope) },
          released: (scope) => { entry.stored.delete(scope) },
          ...validate === undefined ? {} : { validate },
        })
        entry.jobs.add(job)
        const settled = () => { entry.jobs.delete(job) }
        void job.then(settled, settled)
        return job
      },
      dispose: async () => { await dispose() },
    }
  }

  /** Prepare a bound execution before caller composition mounts.
   * @param session - exact unpublished bound Session.
   */
  async prepare(session: Session): Promise<void> {
    const id = this.state(session).controllerId
    if (id !== null) await this.require(id).policy.prepare?.(session)
  }

  /** Initialize optional policy ownership without adding an await to ordinary Sessions.
   * @param session - exact unpublished Session.
   * @param source - creation or resumption source.
   * @returns preparation work when a provider owns the Session, otherwise undefined.
   */
  initialize(session: Session, source: SessionStartSource): Promise<void> | undefined {
    let pending: Promise<void> | undefined
    for (const entry of this.policies.values()) {
      if (!entry.active || entry.policy.initialize === undefined) continue
      const initialize = () => {
        this.assertActive(entry)
        return entry.policy.initialize?.(session, source)
      }
      if (pending !== undefined) pending = pending.then(initialize)
      else {
        const result = initialize()
        if (result !== undefined) pending = result
      }
    }
    const prepare = () => this.bound(session) ? this.prepare(session) : undefined
    return pending === undefined ? prepare() : pending.then(prepare)
  }

  /** Report whether a Session requires the reliable controlled receipt path.
   * @param session - exact receiver Session.
   * @returns whether its own log binds a provider.
   */
  bound(session: Session): boolean { return this.state(session).controllerId !== null }

  /** Gate new turns, including explicit wakePending and teardown wake replay.
   * @param agent - receiving driver.
   * @returns whether the policy and receipt lifecycle permit starting.
   */
  canStart(agent: Agent): boolean { return this.allowed(agent, 'canStart') }

  /** Gate input consumption before claim without removing any pending item.
   * @param agent - receiving driver.
   * @returns whether the next inbox batch can be consumed.
   */
  canClaim(agent: Agent): boolean { return this.allowed(agent, 'canClaim') }

  /** Prepare only a bound provider's claim; unbound and callback-free drivers keep the synchronous path.
   * @param agent - exact receiving driver.
   * @param signal - its current turn cancellation.
   * @returns owner preparation when registered, otherwise undefined.
   */
  prepareClaim(agent: Agent, signal: AbortSignal): Promise<void> | undefined {
    const id = this.state(agent.session).controllerId
    if (id === null) return undefined
    const entry = this.require(id)
    const prepare = entry.policy.prepareClaim?.bind(entry.policy)
    if (prepare === undefined) return undefined
    const driver = this.drivers.get(agent)
    const combined = AbortSignal.any([signal, entry.lifetime.signal, this.lifetime.signal])
    const job = Promise.resolve().then(async () => {
      this.assertActive(entry)
      combined.throwIfAborted()
      await prepare(agent, combined)
      this.assertActive(entry)
      combined.throwIfAborted()
    })
    entry.jobs.add(job)
    driver?.jobs.add(job)
    const settled = () => { entry.jobs.delete(job); driver?.jobs.delete(job) }
    void job.then(settled, settled)
    return job
  }

  /** Receive one ordinary input; an unbound Session must use its original synchronous driver.
   * @param agent - controlled receiver.
   * @param input - original message identity and intent, preserved on retry.
   * @returns custody confirmed by a successful persistence flush, not model processing.
   */
  receive(agent: Agent, input: AgentInput): Promise<InputReceipt> { return this.deliver(agent, input) }

  private require(id: ControllerId): Registration {
    const entry = this.policies.get(id)
    if (entry === undefined || !entry.active) throw new Error(`input controller "${id}" is unavailable`)
    return entry
  }

  private assertActive(entry: Registration): void {
    if (!entry.active || this.policies.get(entry.id) !== entry) throw new Error('input controller registration is closed')
  }

  private allowed(agent: Agent, operation: 'canStart' | 'canClaim'): boolean {
    const driver = this.drivers.get(agent)
    if (driver !== undefined && (!driver.active || driver.jobs.size > 0 || driver.uncertain.size > 0)) return false
    const id = this.state(agent.session).controllerId
    if (id === null) return true
    const entry = this.policies.get(id)
    if (entry === undefined || !entry.active) return false
    try {
      return entry.policy[operation](agent)
    } catch (error: unknown) {
      this.ctx.logger.warn(`input ${operation} policy failed: ${String(error)}`)
      return false
    }
  }

  private enqueue<T>(entry: Registration, agent: Agent, operation: (driver: DriverEntry) => Promise<T>): Promise<T> {
    const driver = this.drivers.get(agent)
    if (driver === undefined || !driver.active) return Promise.reject(new Error('controlled input driver is unavailable'))
    const job = driver.tail.then(async () => {
      this.assertActive(entry)
      if (!driver.active) throw new Error('controlled input driver is closed')
      return operation(driver)
    })
    driver.tail = job.then(() => {}, () => {})
    driver.jobs.add(job)
    entry.jobs.add(job)
    const settled = () => {
      driver.jobs.delete(job)
      entry.jobs.delete(job)
      if (driver.jobs.size === 0 && driver.wakeRequested && this.canStart(agent)) {
        driver.wakeRequested = false
        driver.driver.wake()
      }
    }
    // Contain only the cleanup observer; the original job still rejects to its caller.
    void job.then(settled, settled).catch((error: unknown) => {
      this.ctx.logger.warn(`input completion observer failed: ${String(error)}`)
    })
    return job
  }

  private async deliver(agent: Agent, source: AgentInput, preload?: { entry: Registration; prepend: boolean }): Promise<InputReceipt> {
    const id = this.state(agent.session).controllerId
    if (id === null) return Promise.reject(new Error('Session has no input controller binding'))
    const entry = this.require(id)
    if (preload !== undefined && preload.entry !== entry) return Promise.reject(new Error('preload capability belongs to another controller'))
    const input = structuredClone(source)
    const currentDriver = this.drivers.get(agent)
    if (currentDriver === undefined || !currentDriver.active) throw new Error('controlled input driver is unavailable')
    const captured = currentDriver.driver.resolve(input)
    return this.enqueue(entry, agent, async (driver) => {
      const previous = this.state(agent.session).records.find(record => record.input.message.id === input.message.id)
      if (previous !== undefined) {
        const received = preload === undefined ? previous.originalInput ?? previous.input : previous.input
        if (!isDeepStrictEqual(received.message, input.message) || received.wakeup !== input.wakeup
          || (received.requestedTarget ?? received.target) !== (input.requestedTarget ?? input.target)) {
          throw new Error('input identity reused with different contents or intent')
        }
        if (preload !== undefined && previous.location === 'held') {
          driver.uncertain.add(input.message.id)
          driver.driver.enqueue(previous.input, preload.prepend)
        } else if (preload !== undefined && previous.location === 'released') {
          throw new Error('released input cannot be preloaded again')
        }
      } else {
        const resolved = captured
        const decision = preload === undefined ? entry.policy.admit(agent, resolved) : { kind: 'accept' as const }
        this.assertActive(entry)
        if (decision.kind === 'reject') throw new Error(decision.reason)
        driver.uncertain.add(input.message.id)
        if (decision.kind === 'hold') {
          agent.session.append('agent/input/held', { version: 1, controllerId: id, input: resolved })
        } else driver.driver.enqueue(resolved, preload?.prepend ?? false)
      }
      const sessions = this.ctx.get('sessions')
      if (sessions === undefined) throw new Error('Session store is unavailable for input durability')
      const confirmed = await sessions.flush(agent.session)
      if (!confirmed) throw new Error('input durability was not confirmed: no persistence listener')
      this.assertActive(entry)
      if (!driver.active) throw new Error('controlled input driver is closed')
      driver.uncertain.delete(input.message.id)
      const record = this.state(agent.session).records.find(item => item.input.message.id === input.message.id)
      if (record === undefined) throw new Error('input receipt is missing after flush')
      if (preload === undefined && record.location === 'inbox' && record.input.wakeup
        && [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(item => item.id === input.message.id)) {
        driver.wakeRequested = true
      }
      return { messageId: input.message.id, location: record.location }
    })
  }

  /** Mutate pending audited input or confirm one exact uncertain removal without reinsertion.
   * @param agent - controlled receiver.
   * @param action - caller-authorized pending edit, removal or steering.
   */
  async mutate(agent: Agent, action: AgentInputMutation): Promise<void> {
    const id = this.state(agent.session).controllerId
    if (id === null) throw new Error('Session has no input controller binding')
    const entry = this.require(id)
    return this.enqueue(entry, agent, async (driver) => {
      const record = this.state(agent.session).records.find(item => item.input.message.id === action.messageId)
      const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(item => item.id === action.messageId)
      const confirmingRemoval = action.kind === 'remove' && !pending && driver.uncertain.has(action.messageId)
      if (record?.location !== 'inbox' || !pending && !confirmingRemoval) throw new InputMutationUnavailableError(action.messageId)
      if (!confirmingRemoval) {
        const next = action.kind === 'replace' ? { ...record.input, message: { ...record.input.message, content: [...action.content] } }
          : action.kind === 'steer' ? driver.driver.resolve({ message: record.input.message, target: 'next-step', wakeup: true })
            : record.input
        if (entry.policy.admit(agent, next).kind !== 'accept') throw new Error('pending input cannot be changed while admission is closed')
        driver.uncertain.add(action.messageId)
        if (action.kind === 'replace') driver.driver.replace(action.messageId, next.message)
        else {
          driver.driver.remove(action.messageId)
          if (action.kind === 'steer') driver.driver.enqueue(next, false)
        }
      }
      const sessions = this.ctx.get('sessions')
      if (sessions === undefined || !await sessions.flush(agent.session)) throw new Error('input mutation durability was not confirmed')
      this.assertActive(entry)
      driver.uncertain.delete(action.messageId)
      if (action.kind === 'steer') driver.wakeRequested = true
    })
  }

  private async holdPending(entry: Registration, agent: Agent, messageIds?: readonly MessageId[]): Promise<readonly AgentInput[]> {
    if (this.state(agent.session).controllerId !== entry.id) throw new Error('capture capability belongs to another controller')
    return this.enqueue(entry, agent, async (driver) => {
      const state = this.state(agent.session)
      const pending = selectedPendingInput(state,
        [...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(message => ({ message })), messageIds)
      capturePendingInput(agent.session, entry.id, state, pending, (messageId) => {
        driver.uncertain.add(messageId)
        return driver.driver.hold(messageId)
      })
      const heldInputs = this.state(agent.session).records.filter(record => record.location === 'held'
        && (messageIds === undefined || messageIds.includes(record.input.message.id))).map(record => record.input)
      const sessions = this.ctx.get('sessions')
      if (sessions === undefined || !await sessions.flush(agent.session)) throw new Error('input capture durability was not confirmed')
      this.assertActive(entry)
      for (const input of heldInputs) driver.uncertain.delete(input.message.id)
      return heldInputs
    })
  }

  private async release(entry: Registration, agent: Agent, messageId: MessageId): Promise<void> {
    if (this.state(agent.session).controllerId !== entry.id) return Promise.reject(new Error('release capability belongs to another controller'))
    return this.enqueue(entry, agent, async (driver) => {
      releaseHeldInput(agent.session, entry.id, this.state(agent.session), messageId)
      driver.uncertain.add(messageId)
      const sessions = this.ctx.get('sessions')
      if (sessions === undefined || !await sessions.flush(agent.session)) throw new Error('input release durability was not confirmed')
      this.assertActive(entry)
      driver.uncertain.delete(messageId)
    })
  }
}
