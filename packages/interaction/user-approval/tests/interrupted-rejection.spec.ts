import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi, onTestFinished } from 'vitest'
import ApprovalService, { ApprovalRequestId, ApprovalAnswererRouteId } from '../src/index.ts'
import type { PendingApprovalRequest } from '../src/index.ts'
import { rejectionHarness, captureUnansweredCut } from './rejection-harness.ts'

/** Retain the exact persisted unanswered cut, then settle the first process normally.
 * The copied cut, not orderly dispose, supplies this recovery fixture's interrupted question.
 */
const unansweredCut = captureUnansweredCut

describe('captured interrupted approval rejection', () => {
  it('recovers the original id from an actual JSONL cut after ordinary turn repair without reopening a turn', async () => {
    const { cut, captured } = await unansweredCut()
    const restored = await rejectionHarness({ cut })
    expect(restored.source.agent.status).toBe('idle')
    const before = restored.source.agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length
    expect(await restored.ctx.approval.rejectInterrupted(restored.source.agent.session, captured)).toBe(true)
    expect(await restored.ctx.approval.rejectInterrupted(restored.source.agent.session, captured)).toBe(true)
    const saved = await restored.ctx.sessionPersistence.open(restored.source.agent.id, 'read')
    let recovered: { header: SessionHeader; events: readonly SessionEvent[] }
    try { recovered = { header: saved.header, events: (await saved.read()).events } } finally { await saved.close() }
    expect(recovered.events.filter(event => event.type === 'approval/interrupted-rejected').map(event => event.data))
      .toEqual([{ version: 1, id: captured.id }])
    expect(recovered.events.filter(event => event.type === 'approval/decided')).toEqual([])
    expect(recovered.events.filter(event => event.type === 'turn/start')).toHaveLength(before)
    expect(restored.ctx.sessionProjections.stateOf(restored.source.agent.session, 'approvalAudit')?.requests[captured.id]?.outcome).toBe('rejected')
    await restored.source.dispose()
    const restarted = await rejectionHarness({ cut: recovered })
    expect(await restarted.ctx.approval.rejectInterrupted(restarted.source.agent.session, captured)).toBe(true)
    expect(restarted.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/interrupted-rejected')).toHaveLength(1)
    expect(restored.adapter.requests).toEqual([])
    expect(restarted.adapter.requests).toEqual([])
  })

  it.each(['false', 'throw'] as const)('does not treat a %s checkpoint as recovery success, including the in-memory idempotent retry', async (failure) => {
    const { cut, captured } = await unansweredCut()
    const restored = await rejectionHarness({ cut })
    const checkpoint = vi.spyOn(restored.ctx.sessions, 'flush')
    if (failure === 'false') checkpoint.mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    else checkpoint.mockRejectedValueOnce(new Error('interrupted checkpoint failed')).mockRejectedValueOnce(new Error('retry checkpoint failed'))
    await expect(restored.ctx.approval.rejectInterrupted(restored.source.agent.session, captured)).rejects.toThrow()
    await expect(restored.ctx.approval.rejectInterrupted(restored.source.agent.session, captured)).rejects.toThrow()
    expect(await restored.ctx.approval.rejectInterrupted(restored.source.agent.session, captured)).toBe(true)
    expect(restored.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/interrupted-rejected')).toHaveLength(1)
    checkpoint.mockRestore()
    expect(restored.adapter.requests).toEqual([])
  })

  it('requires the exact original Session, route, asked sequence, tool and call facts', async () => {
    const { cut, captured } = await unansweredCut()
    const restored = await rejectionHarness({ cut })
    const { routeId: _route, ...unrouted } = captured
    const { callId: _call, ...withoutCall } = captured
    const wrong: PendingApprovalRequest[] = [
      { ...captured, originSessionId: SessionId('another-origin') }, unrouted,
      { ...captured, id: ApprovalRequestId('uncaptured') },
      { ...captured, askedSeq: SessionSeq(captured.askedSeq + 1) },
      { ...captured, toolName: 'another-operation' }, withoutCall,
      { ...captured, routeId: ApprovalAnswererRouteId('another-route') },
    ]
    for (const request of wrong) expect(await restored.ctx.approval.rejectInterrupted(restored.source.agent.session, request)).toBe(false)
    expect(restored.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/interrupted-rejected')).toEqual([])
    expect(await restored.ctx.approval.rejectInterrupted(restored.source.agent.session, captured)).toBe(true)
  })

  it('does not sweep another unmatched question when recovery names only the captured id', async () => {
    const { cut, captured } = await unansweredCut()
    const last = cut.events.at(-1)
    if (last === undefined) throw new Error('unanswered cut was empty')
    const another = ApprovalRequestId('different-unanswered-question')
    const restored = await rejectionHarness({ cut: { header: cut.header, events: [...cut.events, {
      type: 'approval/asked', seq: SessionSeq(last.seq + 1), time: last.time + 1, data: { id: another, toolName: 'other-sensitive-action' },
    }] } })
    expect(await restored.ctx.approval.rejectInterrupted(restored.source.agent.session, captured)).toBe(true)
    expect(restored.ctx.sessionProjections.stateOf(restored.source.agent.session, 'approvalAudit')?.requests[another]?.outcome).toBeNull()
    expect(restored.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/interrupted-rejected').map(event => event.data.id))
      .toEqual([captured.id])
  })

  it('requires an available valid projection and confirms against a real Session store rather than returning an unflushed success', async () => {
    const { cut, captured } = await unansweredCut()
    const closed = [...cut.events, { type: 'step/end' as const, seq: SessionSeq(cut.events.length), time: 1,
      data: { turn: 1, step: 1 } }, { type: 'turn/end' as const, seq: SessionSeq(cut.events.length + 1), time: 2,
      data: { turn: 1, reason: { kind: 'aborted' as const, reason: { kind: 'user' as const } } } }]
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(ApprovalService)
    const session = Session.create(cut.header.id, closed, cut.header)
    await expect(ctx.approval.rejectInterrupted(session, captured)).rejects.toThrow(/valid approval audit projection/)
    await ctx.plugin(SessionProjections)
    await expect(ctx.approval.rejectInterrupted(session, captured)).rejects.toThrow(/durability was not confirmed/)
    expect(session.snapshotEvents().filter(event => event.type === 'approval/interrupted-rejected')).toHaveLength(1)
  })
})
