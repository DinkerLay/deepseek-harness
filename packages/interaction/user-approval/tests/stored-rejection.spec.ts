import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi, onTestFinished } from 'vitest'
import ApprovalService from '../src/index.ts'
import { captureUnansweredCut, offlineRejectionHarness } from './rejection-harness.ts'

describe('source-owned offline approval rejection', () => {
  it('reopens the original JSONL writer after Context restart and preserves header/prefix without activating any Agent', async () => {
    const { cut, captured } = await captureUnansweredCut()
    const first = await offlineRejectionHarness(cut)
    await first.ctx.fiber.dispose()
    const restored = await offlineRejectionHarness(cut, first.resources)
    expect(restored.ctx.agents.list()).toEqual([])
    expect(restored.ctx.sessions.list()).toEqual([])
    expect(await restored.ctx.approval.rejectInterruptedStored(captured)).toBe(true)
    const saved = await restored.read()
    expect(saved.header).toEqual(cut.header)
    expect(saved.events.slice(0, cut.events.length)).toEqual(cut.events)
    expect(saved.events.filter(event => event.type === 'approval/interrupted-rejected').map(event => event.data)).toEqual([{ version: 1, id: captured.id }])
    expect(saved.events.filter(event => event.type === 'approval/decided')).toEqual([])
    expect(saved.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(restored.ctx.agents.list()).toEqual([])
    expect(restored.ctx.sessions.list()).toEqual([])
    await restored.ctx.fiber.dispose()
    const restarted = await offlineRejectionHarness(cut, first.resources)
    expect(await restarted.ctx.approval.rejectInterruptedStored(captured)).toBe(true)
    expect((await restarted.read()).events).toEqual(saved.events)
  })

  it.each(['append', 'flush', 'close'] as const)('does not report a failed %s as recovery success and retries the original sole terminal', async (failure) => {
    const { cut, captured } = await captureUnansweredCut()
    const test = await offlineRejectionHarness(cut)
    const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
    let first = true
    const boundary = vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementation(async (id, access, options) => {
      const handle = await open(id, access, options)
      if (access === 'write' && first) {
        first = false
        if (failure === 'append') vi.spyOn(handle, 'append').mockRejectedValueOnce(new Error('append failed before acceptance'))
        else if (failure === 'flush') vi.spyOn(handle, 'flush').mockRejectedValueOnce(new Error('durability checkpoint failed'))
        else {
          const close = handle.close.bind(handle)
          vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await close(); throw new Error('close observer failed after release') })
        }
      }
      return handle
    })
    await expect(test.ctx.approval.rejectInterruptedStored(captured)).rejects.toThrow()
    expect(await test.ctx.approval.rejectInterruptedStored(captured)).toBe(true)
    const saved = await test.read()
    expect(saved.header).toEqual(cut.header)
    expect(saved.events.filter(event => event.type === 'approval/interrupted-rejected')).toHaveLength(1)
    expect(test.ctx.agents.list()).toEqual([])
    boundary.mockRestore()
  })

  it('writes nothing for uncaptured facts and leaves another pending request untouched', async () => {
    const { cut, captured } = await captureUnansweredCut()
    const test = await offlineRejectionHarness(cut)
    expect(await test.ctx.approval.rejectInterruptedStored({ ...captured, toolName: 'not-the-captured-operation' })).toBe(false)
    expect((await test.read()).events).toEqual(cut.events)
    expect(test.ctx.agents.list()).toEqual([])
    expect(test.ctx.sessions.list()).toEqual([])
  })

  it('refuses an already-live Session before acquiring its offline writer', async () => {
    const { cut, captured } = await captureUnansweredCut()
    const test = await offlineRejectionHarness(cut)
    test.ctx.sessions.create(captured.originSessionId)
    const open = vi.spyOn(test.ctx.sessionPersistence, 'open')
    expect(await test.ctx.approval.rejectInterruptedStored(captured)).toBe(false)
    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
    expect((await test.read()).events).toEqual(cut.events)
  })

  it('lets the atomic backend refuse an existing writer instead of appending under another ownership', async () => {
    const { cut, captured } = await captureUnansweredCut()
    const test = await offlineRejectionHarness(cut)
    const held = await test.ctx.sessionPersistence.open(captured.originSessionId, 'write')
    try {
      await expect(test.ctx.approval.rejectInterruptedStored(captured)).rejects.toThrow(/owned|writer|lock/i)
      expect((await held.read()).events).toEqual(cut.events)
    } finally { await held.close() }
    expect(await test.ctx.approval.rejectInterruptedStored(captured)).toBe(true)
  })

  it.each(['read', 'append', 'flush'] as const)('honors cancellation at the %s boundary and confirms only on a later retry', async (phase) => {
    const { cut, captured } = await captureUnansweredCut()
    const test = await offlineRejectionHarness(cut)
    const cancel = new AbortController()
    const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
    let first = true
    const boundary = vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementation(async (id, access, options) => {
      const handle = await open(id, access, options)
      if (access === 'write' && first) {
        first = false
        if (phase === 'read') {
          const read = handle.read.bind(handle)
          vi.spyOn(handle, 'read').mockImplementationOnce(async (...args) => { const result = await read(...args); cancel.abort(); return result })
        } else if (phase === 'append') {
          const append = handle.append.bind(handle)
          vi.spyOn(handle, 'append').mockImplementationOnce(async (...args) => { await append(...args); cancel.abort() })
        } else {
          const flush = handle.flush.bind(handle)
          vi.spyOn(handle, 'flush').mockImplementationOnce(async (...args) => { await flush(...args); cancel.abort() })
        }
      }
      return handle
    })
    await expect(test.ctx.approval.rejectInterruptedStored(captured, cancel.signal)).rejects.toThrow()
    expect(await test.ctx.approval.rejectInterruptedStored(captured)).toBe(true)
    expect((await test.read()).events.filter(event => event.type === 'approval/interrupted-rejected')).toHaveLength(1)
    boundary.mockRestore()
  })

  it('rechecks live publication that appeared while its original writer was being read', async () => {
    const { cut, captured } = await captureUnansweredCut()
    const test = await offlineRejectionHarness(cut)
    const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
    const boundary = vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementation(async (id, access, options) => {
      const handle = await open(id, access, options)
      if (access === 'write') {
        const read = handle.read.bind(handle)
        vi.spyOn(handle, 'read').mockImplementationOnce(async (...args) => {
          const value = await read(...args)
          test.ctx.sessions.create(captured.originSessionId)
          return value
        })
      }
      return handle
    })
    expect(await test.ctx.approval.rejectInterruptedStored(captured)).toBe(false)
    boundary.mockRestore()
    expect((await test.read()).events).toEqual(cut.events)
  })

  it('refuses missing persistence or Session prerequisites without inventing a fallback writer', async () => {
    const { captured } = await captureUnansweredCut()
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(ApprovalService)
    await expect(ctx.approval.rejectInterruptedStored(captured)).rejects.toThrow(/requires the Session store/)
    await ctx.plugin(SessionStore)
    await expect(ctx.approval.rejectInterruptedStored(captured)).rejects.toThrow(/requires Session persistence/)
    await expect(ctx.approval.rejectInterruptedStored(captured, AbortSignal.abort(new Error('cancelled before recovery'))))
      .rejects.toThrow('cancelled before recovery')
  })

  it('returns cancellation promptly but keeps disposal waiting until an uncooperative late write handle really closes', async () => {
    const { cut, captured } = await captureUnansweredCut()
    const test = await offlineRejectionHarness(cut)
    const acquired = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const closeEntered = Promise.withResolvers<undefined>()
    const closeFinish = Promise.withResolvers<undefined>()
    test.releases.push(() => { release.resolve(undefined); closeFinish.resolve(undefined) })
    const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
    const boundary = vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementation(async (id, access) => {
      const handle = await open(id, access)
      if (access === 'write') {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          closeEntered.resolve(undefined)
          await closeFinish.promise
          await close()
        })
        acquired.resolve(undefined)
        await release.promise
      }
      return handle
    })
    const cancel = new AbortController()
    const waiting = test.ctx.approval.rejectInterruptedStored(captured, cancel.signal)
    const rejected = expect(waiting).rejects.toThrow('cancel late acquisition')
    await acquired.promise
    cancel.abort(new Error('cancel late acquisition'))
    await rejected
    let disposed = false
    const disposal = test.approval.dispose().then(() => { disposed = true })
    release.resolve(undefined)
    await closeEntered.promise
    expect(disposed).toBe(false)
    closeFinish.resolve(undefined)
    await disposal
    expect(disposed).toBe(true)
    boundary.mockRestore()
    const proof = await test.ctx.sessionPersistence.open(captured.originSessionId, 'write')
    expect((await proof.read()).events).toEqual(cut.events)
    await proof.close()
    expect(test.ctx.agents.list()).toEqual([])
  })

  it('refuses a real backend handle naming another Session and still releases that handle', async () => {
    const { cut, captured } = await captureUnansweredCut()
    const test = await offlineRejectionHarness(cut)
    const otherId = SessionId('other-stored-approval-session')
    const created = await test.ctx.sessionPersistence.create({ ...cut.header, id: otherId })
    await created.flush()
    await created.close()
    const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
    const boundary = vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementation((_id, access, options) => open(otherId, access, options))
    await expect(test.ctx.approval.rejectInterruptedStored(captured)).rejects.toThrow(/another Session/)
    boundary.mockRestore()
    const proof = await open(otherId, 'write')
    expect((await proof.read()).events).toEqual([])
    await proof.close()
    expect((await test.read()).events).toEqual(cut.events)
  })

  it.each(['open failure', 'close failure'] as const)('owns an abandoned backend result through its eventual %s', async (failure) => {
    const { cut, captured } = await captureUnansweredCut()
    const test = await offlineRejectionHarness(cut)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const errors: unknown[] = []
    test.ctx.logger.exporter({ export: (message) => {
      if (message.type === 'error') for (const argument of message.args) { const error: unknown = argument; errors.push(error) }
    } })
    test.releases.push(() => { release.resolve(undefined) })
    const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
    const boundary = vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementation(async (id, access) => {
      const handle = await open(id, access)
      if (access !== 'write') return handle
      entered.resolve(undefined)
      await release.promise
      if (failure === 'open failure') { await handle.close(); throw new Error('late backend acquisition failed') }
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw new Error('late close observer failed') })
      return handle
    })
    const cancel = new AbortController()
    const waiting = test.ctx.approval.rejectInterruptedStored(captured, cancel.signal)
    const rejected = expect(waiting).rejects.toThrow('cancel abandoned writer')
    await entered.promise
    cancel.abort(new Error('cancel abandoned writer'))
    await rejected
    const disposal = test.approval.dispose()
    release.resolve(undefined)
    await disposal
    if (failure === 'close failure') expect(errors.map(String)).toEqual(['Error: late close observer failed'])
    else expect(errors).toEqual([])
    boundary.mockRestore()
    const proof = await open(captured.originSessionId, 'write')
    expect((await proof.read()).events).toEqual(cut.events)
    await proof.close()
  })
})
