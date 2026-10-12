/** One-shot Team change waiters independent of durable state projection. */

import type { TeamId, TeamWaitResult } from './types.ts'
import { errorMessage, TeamError } from './error.ts'

interface Waiter {
  readonly resolve: () => void
}

/** Owns current Team change waiters and releases each at most once. */
export class TeamActivity {
  private readonly waiters = new Map<TeamId, Set<Waiter>>()
  private closed = false

  /**
   * Wait for one later Team-domain or member-status change.
   * @param id - Team whose next edge wakes the caller.
   * @param timeoutMs - bounded wait duration from ten seconds through one hour.
   * @param signal - caller cancellation for this wait only.
   * @param wakeOn - optional trigger for this wait only: it receives the wake callback and returns its disposer.
   * @returns whether the wait ended by timeout.
   */
  async wait(id: TeamId, timeoutMs: number, signal: AbortSignal,
    wakeOn?: (wake: () => void) => () => void): Promise<TeamWaitResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
      throw new TeamError('timeoutMs must be an integer from 10000 through 3600000', 'TEAM_INVALID_TIMEOUT')
    }
    signal.throwIfAborted()
    if (this.closed) return { timedOut: false }
    const changed = await new Promise<boolean>((resolve, reject) => {
      let waiters = this.waiters.get(id)
      if (waiters === undefined) {
        waiters = new Set()
        this.waiters.set(id, waiters)
      }
      const state: { settled: boolean; unsubscribe?: (() => void) | undefined } = { settled: false }
      const finish = (settle: () => void): void => {
        /* v8 ignore next -- timeout, abort, and notification may race after one winner removes the others. */
        if (state.settled) return
        state.settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        state.unsubscribe?.()
        waiters.delete(waiter)
        if (waiters.size === 0) this.waiters.delete(id)
        settle()
      }
      const onAbort = (): void => {
        finish(() => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error
            ? reason
            : new TeamError(`wait_agent aborted: ${errorMessage(reason)}`, 'TEAM_WAIT_ABORTED'))
        })
      }
      const waiter: Waiter = {
        resolve: () => {
          finish(() => { resolve(true) })
        },
      }
      waiters.add(waiter)
      const timer = setTimeout(() => { finish(() => { resolve(false) }) }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      // AbortSignal does not replay an abort that wins between the pre-check and listener registration.
      /* v8 ignore next -- requires an abort in the synchronous gap between the pre-check and listener registration. */
      if (signal.aborted) onAbort()
      // The extra trigger registers last, so a wake while it registers settles a fully registered wait.
      if (wakeOn !== undefined) {
        try {
          const unsubscribe = wakeOn(waiter.resolve)
          if (state.settled) unsubscribe()
          else state.unsubscribe = unsubscribe
        } catch (error: unknown) {
          finish(() => {
            reject(error instanceof Error ? error : new TeamError(`wait_agent trigger failed: ${errorMessage(error)}`, 'TEAM_WAIT_ABORTED'))
          })
        }
      }
    })
    return { timedOut: !changed }
  }

  /**
   * Wake and remove every current waiter for one Team.
   * @param id - Team whose current waiters observe the change.
   */
  notify(id: TeamId): void {
    const waiters = this.waiters.get(id)
    if (waiters === undefined) return
    this.waiters.delete(id)
    for (const waiter of waiters) waiter.resolve()
  }

  /** Close admission and wake every current waiter during runtime disposal. */
  close(): void {
    this.closed = true
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.resolve()
    }
    this.waiters.clear()
  }
}
