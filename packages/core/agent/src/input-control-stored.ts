/** Original-writer custody for input whose execution is not resident. */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { interruptedTurnClosers, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { InputControllerId, InputControlState, StoredInputCustody, StoredInputCustodySource,
  StoredInputDriver, StoredPendingInput } from './input-control-types.ts'

/** Capture the concrete pending queue; a held-before-splice crash completes its existing removal.
 * @param session - original source, live or exclusively detached.
 * @param controllerId - capability owner.
 * @param state - source custody state.
 * @param pending - concrete pending items, not historical receipt records.
 * @param hold - concrete driver's non-waking custody removal.
 */
export function capturePendingInput(session: Session, controllerId: InputControllerId, state: InputControlState,
  pending: readonly { readonly message: UserMessage; readonly target?: StoredPendingInput['target'] }[],
  hold: (id: MessageId) => boolean): void {
  const inputs = pending.map(({ message, target }) => {
    const record = state.records.find(candidate => candidate.input.message.id === message.id)
    if (record === undefined || record.location !== 'inbox' && (record.location !== 'held' || record.captured !== true)
      || !isDeepStrictEqual(record.input.message, message) || target !== undefined && record.input.target !== target) {
      throw new Error(`pending input "${message.id}" has no reliable recorded contents and wake intent`)
    }
    return record
  })
  for (const record of inputs) {
    if (record.location === 'inbox') session.append('agent/input/held', { version: 1, controllerId, input: record.input, captured: true })
    if (!hold(record.input.message.id)) throw new Error('pending input changed before custody removal')
  }
}

/** Select concrete pending input or reconfirm previously held selected identities.
 * @param state - source custody facts.
 * @param pending - concrete current queue.
 * @param messageIds - exact selection, or undefined for all pending input.
 * @returns selected queue items in original order.
 */
export function selectedPendingInput<T extends { readonly message: UserMessage }>(state: InputControlState,
  pending: readonly T[], messageIds?: readonly MessageId[]): readonly T[] {
  if (messageIds === undefined) return pending
  for (const id of messageIds) {
    if (!pending.some(item => item.message.id === id) && !state.records.some(record => record.input.message.id === id && record.location === 'held')) {
      throw new Error('selected input is not pending or held')
    }
  }
  return pending.filter(item => messageIds.includes(item.message.id))
}

/** Settle only an exact held identity; a retry reconfirms its existing release.
 * @param session - original source.
 * @param controllerId - registered source owner.
 * @param state - original custody facts.
 * @param messageId - original held identity.
 */
export function releaseHeldInput(session: Session, controllerId: InputControllerId, state: InputControlState, messageId: MessageId): void {
  const record = state.records.find(item => item.input.message.id === messageId)
  if (record?.location !== 'held' && record?.location !== 'released') throw new Error('input release requires held custody')
  if (record.location !== 'released') session.append('agent/input/released', { version: 1, controllerId, messageId })
}

interface Owner {
  controllerId: InputControllerId
  assertActive(): void
  state(session: Session): InputControlState
  prepareDriver(session: Session): StoredInputDriver
  acquired(scope: StoredInputCustody): void
  validate?(source: StoredInputCustodySource): undefined
  released(scope: StoredInputCustody): void
}

/** Acquire only storage ownership, never Agent setup or execution.
 * @param ctx - core registry owner.
 * @param id - original persisted source.
 * @param signal - caller and registry lifetime.
 * @param owner - existing controller capability and driver provider.
 * @returns sealed custody after standard interrupted repair confirmation.
 */
export async function acquireStoredInputCustody(ctx: Context, id: SessionId, signal: AbortSignal,
  owner: Owner): Promise<StoredInputCustody> {
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  if (sessions === undefined || persistence === undefined) throw new Error('stored custody requires Sessions and persistence')
  const inactive = () => {
    owner.assertActive()
    signal.throwIfAborted()
    if (sessions.get(id) !== undefined || ctx.agents.get(id) !== undefined) throw new Error('stored custody source is live')
  }
  inactive()
  const cancelled = Promise.withResolvers<never>()
  const abort = () => { const reason: unknown = signal.reason; cancelled.reject(reason) }
  signal.addEventListener('abort', abort, { once: true })
  const pending = Promise.resolve().then(() => { inactive(); return persistence.open(id, 'write', { signal }) })
  let handle: SessionHandle
  try { handle = await Promise.race([pending, cancelled.promise]) }
  catch (error: unknown) {
    if (signal.aborted) void pending.then(acquired => acquired.close(), () => undefined).catch((failure: unknown) => {
      ctx.logger.warn(`late stored-input writer close failed: ${String(failure)}`)
    })
    throw error
  } finally { signal.removeEventListener('abort', abort) }
  let adopted = false
  try {
    inactive()
    if (handle.id !== id || handle.header.id !== id) throw new Error('stored custody writer returned another Session')
    const stored = await handle.read(0, undefined, { signal })
    inactive()
    owner.validate?.(deepFreeze(structuredClone({ header: handle.header, events: stored.events,
      inheritedEventCount: handle.inheritedEventCount })))
    inactive()
    const repairs = interruptedTurnClosers(stored.events)
    const session = sessions.prepare(id, { seed: [...stored.events, ...repairs], meta: handle.header,
      inheritedEventCount: handle.inheritedEventCount })
    if (owner.state(session).controllerId !== owner.controllerId) {
      throw new Error('stored custody belongs to another input controller')
    }
    const driver = owner.prepareDriver(session)
    driver.pending()
    // Constructor markers are preparations, not facts that an Agent was activated.
    const start = session.seq
    let disposed = false
    let closing: Promise<void> | undefined
    let tail: Promise<void> = Promise.resolve()
    const assert = () => {
      if (disposed) throw new Error('stored input custody is closed')
      inactive()
    }
    const events = () => {
      // oxlint-disable-next-line typescript/no-deprecated -- Original-writer suffix excludes preparation markers.
      const suffix = [...repairs, ...session.snapshotEvents(SessionLogOffset(start))]
        .map((event, index) => ({ ...event, seq: SessionSeq(stored.events.length + index) }))
      return [...stored.events, ...suffix]
    }
    const flush = async () => {
      assert()
      const expected = events()
      const current = await handle.read(0, undefined, { signal })
      assert()
      if (current.events.length > expected.length || !isDeepStrictEqual(current.events, expected.slice(0, current.events.length))) {
        throw new Error('stored custody writer prefix changed')
      }
      const suffix = expected.slice(current.events.length)
      if (suffix.length > 0) await handle.append(suffix, { signal })
      await handle.flush({ signal })
      assert()
    }
    const run = <T>(operation: () => Promise<T>): Promise<T> => {
      const job = tail.then(async () => { assert(); return operation() })
      tail = job.then(() => {}, () => {})
      return job
    }
    const scope: StoredInputCustody = {
      read: () => {
        assert()
        return deepFreeze(structuredClone({ header: session.header, events: events(), inheritedEventCount: session.inheritedEventCount,
          inputControl: owner.state(session), pending: driver.pending() }))
      },
      holdPending: messageIds => run(async () => {
        const state = owner.state(session)
        capturePendingInput(session, owner.controllerId, state,
          selectedPendingInput(state, driver.pending(), messageIds), id => driver.hold(id))
        await flush()
        return structuredClone(owner.state(session).records.filter(record => record.location === 'held'
          && (messageIds === undefined || messageIds.includes(record.input.message.id))).map(record => record.input))
      }),
      restoreHeld: messageIds => run(async () => {
        for (const id of messageIds) {
          const record = owner.state(session).records.find(item => item.input.message.id === id)
          if (record?.location === 'held') driver.preload(record.input)
          else if (record?.location !== 'inbox' || !driver.pending().some(item => item.message.id === id)) {
            throw new Error('input restoration requires held custody or its still-pending retry')
          }
        }
        await flush()
      }),
      releaseHeld: messageId => run(async () => {
        releaseHeldInput(session, owner.controllerId, owner.state(session), messageId)
        await flush()
      }),
      dispose: () => {
        if (closing !== undefined) return closing
        disposed = true
        closing = tail.then(() => handle.close()).finally(() => { owner.released(scope) })
        return closing
      },
    }
    await flush()
    owner.acquired(scope)
    adopted = true
    return scope
  } finally { if (!adopted) await handle.close() }
}
