/** Controller-owned quiescence and original-input handback shared by native seats. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentInput, InputControllerHandle, StoredInputCustody, StoredInputCustodySnapshot } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { TeamExecutionMaintenanceRequest, TeamExecutionMaintenanceScope } from './execution-maintenance-types.ts'
import { TeamError } from './error.ts'
import { cancellable } from './lead-runtime.ts'
import { readLiveExecution } from './execution-observation.ts'

/** Owner closures preserve the sole controller and seat-specific identity rules. */
export interface ExecutionMaintenanceOwner {
  readonly input: InputControllerHandle
  readonly lifetime: AbortSignal
  assertCurrent(): void
  canHandback(): boolean
  admitted(input: AgentInput): boolean
  transact<R>(action: () => Promise<R>): Promise<R>
  withStored<R>(signal: AbortSignal, callback: (scope: Pick<StoredInputCustody,
    'read' | 'holdPending' | 'restoreHeld' | 'releaseHeld'> | undefined, signal: AbortSignal) => Promise<R>): Promise<R>
}

/** Settle obsolete work input and restore eligible original held input before claim.
 * @param ctx - native controller owner.
 * @param input - sole registered input capability.
 * @param agent - exact current receiver.
 * @param admitted - shared work/coordination classification.
 * @param signal - current driver cancellation.
 * @param assertCurrent - synchronous current receiver and native readiness check.
 * @param transact - existing Team serialization for controlled source writes only.
 */
export async function prepareControlledClaim(ctx: Context, input: InputControllerHandle, agent: Agent,
  admitted: (input: AgentInput) => boolean, signal: AbortSignal, assertCurrent: () => void,
  transact: <R>(action: () => Promise<R>) => Promise<R>): Promise<void> {
  const check = () => { signal.throwIfAborted(); assertCurrent() }
  for (const record of ctx.agents.inputControlState(agent.session).records) {
    check()
    if (record.location === 'held') await transact(async () => {
      check()
      if (admitted(record.input)) await input.preload(agent, record.input)
      else await input.release(agent, record.input.message.id)
      check()
    })
  }
  const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
  const state = ctx.agents.inputControlState(agent.session)
  const obsolete = pending.flatMap((message) => {
    const record = state.records.find(record => record.input.message.id === message.id)
    return record !== undefined && !admitted(record.input) ? [message.id] : []
  })
  if (obsolete.length > 0) {
    await transact(async () => {
      check()
      const current = ctx.agents.inputControlState(agent.session)
      const exact = obsolete.filter(id => current.records.some(record => record.input.message.id === id && !admitted(record.input)))
      await input.holdPending(agent, exact)
      for (const id of exact) { check(); await input.release(agent, id) }
    })
  }
  check()
}

/** Stop only the preview's running turn, then retain source custody until callback and handback settle.
 * @param ctx - exact native runtime owner.
 * @param request - pinned execution identity and product check.
 * @param signal - registration and caller lifetime.
 * @param owner - existing input-controller capability and identity closures.
 * @param callback - actual exclusive quiet source, never a reconstructed fake Agent.
 * @returns the callback result only after non-waking original-input handback succeeds.
 */
export async function maintainExecution<T>(ctx: Context, request: TeamExecutionMaintenanceRequest, signal: AbortSignal,
  owner: ExecutionMaintenanceOwner, callback: (scope: TeamExecutionMaintenanceScope) => Promise<T>): Promise<T> {
  const target = request.target
  const assert = () => { signal.throwIfAborted(); owner.assertCurrent(); request.assertCurrent?.() }
  assert()
  let agent = ctx.agents.get(target.executionId)
  if (agent?.status === 'running') {
    // oxlint-disable-next-line typescript/no-deprecated -- Exact current turn identity is a driver-owned observation.
    const events = agent.session.snapshotEvents()
    const start = events.findLast(event => event.type === 'turn/start')
    if (start?.type !== 'turn/start' || target.turn === undefined || start.data.turn !== target.turn
      || events.some(event => event.type === 'turn/end' && event.data.turn === target.turn)) {
      throw new TeamError('execution turn changed before maintenance', 'TEAM_MEMBER_OPERATION_STALE')
    }
    agent.cancel({ kind: 'user' }, { keepInbox: true })
  }
  if (agent !== undefined) await cancellable(agent.whenIdle(), signal)
  assert()
  agent = ctx.agents.get(target.executionId)
  const invoke = async (source: 'live' | 'stored' | 'absent', read: () => StoredInputCustodySnapshot | undefined,
    capture: (ids?: readonly MessageId[]) => Promise<readonly AgentInput[]>, restore: (ids: readonly MessageId[]) => Promise<void>,
    release: (ids: readonly MessageId[]) => Promise<void>, ownedSignal: AbortSignal, resourceSignal: AbortSignal): Promise<T> => {
    let active = true
    const scopeAbort = new AbortController()
    const close = () => {
      active = false
      scopeAbort.abort(new TeamError('execution maintenance scope is closed', 'TEAM_MEMBER_OPERATION_STALE'))
    }
    const revalidate = () => { assert(); ownedSignal.throwIfAborted() }
    const check = () => {
      if (!active) throw new TeamError('execution maintenance scope is closed', 'TEAM_MEMBER_OPERATION_STALE')
      revalidate()
    }
    const jobs: Promise<unknown>[] = []
    const operation = <R>(action: () => Promise<R>): Promise<R> => {
      check()
      const job = owner.transact(async () => { revalidate(); return await action() })
        .then((result) => { assert(); ownedSignal.throwIfAborted(); return result })
      jobs.push(job)
      // The owner drains even mutations which a callback did not await.
      void job.catch(() => undefined)
      return job
    }
    const scope: TeamExecutionMaintenanceScope = { target, source, signal: AbortSignal.any([ownedSignal, scopeAbort.signal]),
      read: () => { check(); return read() },
      capture: ids => operation(() => capture(ids)),
      restore: ids => operation(async () => {
        for (const id of ids) {
          revalidate()
          const record = read()?.inputControl.records.find(record => record.input.message.id === id)
          if (record === undefined || !owner.admitted(record.input)) throw new TeamError('work input is no longer schedulable', 'TEAM_INVALID_ARGUMENT')
          await restore([id])
        }
      }), release: ids => operation(async () => { for (const id of ids) { revalidate(); await release([id]) } }) }
    try {
      const result = await callback(scope)
      close()
      await owner.transact(() => { revalidate(); return Promise.resolve() })
      return result
    }
    finally {
      close()
      const canHandback = () => {
        owner.lifetime.throwIfAborted(); resourceSignal.throwIfAborted()
        return owner.canHandback()
      }
      const handback = async () => {
        if (!canHandback()) return
        const snapshot = read()
        const obsolete = snapshot?.pending.flatMap((item) => {
          const record = snapshot.inputControl.records.find(record => record.input.message.id === item.message.id)
          return record !== undefined && !owner.admitted(record.input) ? [item.message.id] : []
        }) ?? []
        if (obsolete.length > 0) {
          await owner.transact(async () => { if (canHandback()) await capture(obsolete) })
          if (!canHandback()) return
        }
        const settled = read()?.inputControl.records.filter(record => record.location === 'held' && !owner.admitted(record.input))
          .map(record => record.input.message.id) ?? []
        for (const id of settled) {
          if (!canHandback()) return
          await owner.transact(async () => { if (canHandback()) await release([id]) })
        }
        const eligible = read()?.inputControl.records.filter(record => record.location === 'held' && owner.admitted(record.input))
          .map(record => record.input.message.id) ?? []
        for (const id of eligible) {
          if (!canHandback()) return
          await owner.transact(async () => {
            if (!canHandback()) return
            const record = read()?.inputControl.records.find(record => record.input.message.id === id)
            if (record !== undefined && owner.admitted(record.input)) await restore([id])
          })
        }
      }
      const outcomes = await Promise.allSettled(jobs)
      await handback()
      await owner.transact(() => { revalidate(); return Promise.resolve() })
      const failures = outcomes.flatMap((result) => {
        if (result.status !== 'rejected') return []
        const reason: unknown = result.reason
        return [reason]
      })
      if (failures.length > 0) throw new AggregateError(failures, 'execution input disposition was not confirmed')
    }
  }
  if (agent !== undefined) {
    const current = agent
    return current.runMaintenance(async (maintenanceSignal) => {
      const ownedSignal = AbortSignal.any([signal, maintenanceSignal])
      assert()
      if (!await ctx.sessions.flush(current.session)) throw new TeamError('execution source durability was not confirmed', 'TEAM_INPUT_DURABILITY')
      assert(); ownedSignal.throwIfAborted()
      const read = () => readLiveExecution(ctx, current)
      return invoke('live', read, ids => owner.input.holdPending(current, ids), async (ids) => {
        for (const id of ids) {
          const record = ctx.agents.inputControlState(current.session).records.find(record => record.input.message.id === id)
          if (record === undefined || record.location === 'released' || record.location === 'inbox'
            && ![...current.inbox.nextStep, ...current.inbox.nextTurn].some(message => message.id === id)) {
            throw new TeamError('input cannot return after release or consumption', 'TEAM_INVALID_ARGUMENT')
          }
          await owner.input.preload(current, record.input)
        }
      }, async (ids) => { for (const id of ids) await owner.input.release(current, id) }, ownedSignal, maintenanceSignal)
    })
  }
  return owner.withStored(owner.lifetime, async (stored, resourceSignal) => {
    assert()
    const ownedSignal = AbortSignal.any([signal, resourceSignal])
    if (stored === undefined) {
      const unavailable = (): Promise<never> => Promise.reject(new TeamError('source input is unavailable', 'TEAM_MEMBER_OPERATION_STALE'))
      return await invoke('absent', () => undefined, async (ids) => {
        if (ids !== undefined && ids.length > 0) return await unavailable()
        return []
      }, unavailable, unavailable, ownedSignal, resourceSignal)
    }
    return await invoke('stored', () => stored.read(), ids => stored.holdPending(ids), ids => stored.restoreHeld(ids),
      async (ids) => { for (const id of ids) await stored.releaseHeld(id) }, ownedSignal, resourceSignal)
  })
}
