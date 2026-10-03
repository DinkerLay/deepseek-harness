/** Quiet original-Session write ownership for captured approval rejection; never publishes an Agent or Session. */
import type { Context } from '@deepseek-ai/cordis'
import { interruptedTurnClosers, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { PendingApprovalRequest } from './types.ts'

/** Acquire a cancellable lease and close a backend handle returned after abandonment. */
async function acquire(ctx: Context, id: PendingApprovalRequest['originSessionId'], signal: AbortSignal,
  late: (closing: Promise<void>) => void): Promise<SessionHandle> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('stored approval rejection requires Session persistence')
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const abort = () => { const reason: unknown = signal.reason; cancelled.reject(reason) }
  signal.addEventListener('abort', abort, { once: true })
  const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return persistence.open(id, 'write', { signal }) })
  try {
    return await Promise.race([pending, cancelled.promise])
  } catch (error: unknown) {
    if (signal.aborted) late(pending.then(handle => handle.close(), () => undefined))
    throw error
  } finally { signal.removeEventListener('abort', abort) }
}

/** Write only the service-generated repair and exact rejection suffix under an exclusive original-Session lease.
 * @param ctx - approval owner's Host services.
 * @param captured - frozen original question facts, not a replacement operation.
 * @param signal - caller and approval-owner cancellation.
 * @param reject - exact audit matching and rejection owned by the approval service.
 * @param late - lifecycle owner of a backend writer returned after caller cancellation.
 * @returns confirmed original rejection, or false without a write when the Session is live or facts do not match.
 */
export async function rejectStored(ctx: Context, captured: PendingApprovalRequest, signal: AbortSignal,
  reject: (session: Session, captured: PendingApprovalRequest) => boolean, late: (closing: Promise<void>) => void): Promise<boolean> {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new Error('stored approval rejection requires the Session store')
  const live = () => sessions.get(captured.originSessionId) !== undefined || ctx.get('agents')?.get(captured.originSessionId) !== undefined
  signal.throwIfAborted()
  if (live()) return false
  const handle = await acquire(ctx, captured.originSessionId, signal, late)
  try {
    signal.throwIfAborted()
    if (handle.id !== captured.originSessionId || handle.header.id !== captured.originSessionId) {
      throw new Error('stored approval writer returned another Session')
    }
    const stored = await handle.read(0, undefined, { signal })
    signal.throwIfAborted()
    if (live()) return false
    const repairs = interruptedTurnClosers(stored.events)
    const session = sessions.prepare(captured.originSessionId, { seed: [...stored.events, ...repairs],
      meta: handle.header, inheritedEventCount: handle.inheritedEventCount })
    const preparedEnd = session.seq
    if (!reject(session, captured)) return false
    // Preparation's resume marker is not an activation fact. Only standard
    // repairs and the service rejection extend this writer's original prefix.
    // oxlint-disable-next-line typescript/no-deprecated -- The stored writer owns this exact detached suffix.
    const suffix = [...repairs, ...session.snapshotEvents().slice(preparedEnd)]
      .map((event, index) => ({ ...event, seq: SessionSeq(stored.events.length + index) }))
    if (suffix.length > 0) await handle.append(suffix, { signal })
    signal.throwIfAborted()
    await handle.flush({ signal })
    signal.throwIfAborted()
    return true
  } finally { await handle.close() }
}
