import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import Invariants from '@deepseek-ai/dsh-invariants'
import { describe, expect, it, onTestFinished } from 'vitest'
import { approvalAuditProjection } from '../src/audit.ts'
import { ApprovalAnswererRouteId, ApprovalRequestId } from '../src/index.ts'
import * as ApprovalInvariant from '../src/invariant.ts'
import { captureUnansweredCut, offlineRejectionHarness } from './rejection-harness.ts'

function audit(session: Session) {
  let state = approvalAuditProjection.init(session.header, session.inheritedEventCount)
  for (const event of session.snapshotEvents()) state = approvalAuditProjection.apply(state, event)
  return state
}

function plain(route = true) {
  const session = Session.create(SessionId('approval-audit-fixture'))
  if (route) session.append('approval/answerer-route', { version: 1, routeId: ApprovalAnswererRouteId('audit-route') })
  session.append('turn/start', { turn: 1 })
  const id = ApprovalRequestId('audit-question')
  session.append('approval/asked', { id, toolName: 'sensitive-operation' })
  return { session, id }
}

describe('approval audit recovery projection', () => {
  it('round-trips actual checkpoint values with and without optional call/failure fields', async () => {
    const { cut } = await captureUnansweredCut()
    const session = Session.create(cut.header.id, cut.events, cut.header)
    const state = audit(session)
    expect(approvalAuditProjection.stateSchema.parse(state)).toEqual(state)
    const basic = plain()
    const value = audit(basic.session)
    expect(approvalAuditProjection.stateSchema.parse(value)).toEqual(value)
    basic.session.append('approval/asked', { id: basic.id, toolName: 'duplicate' })
    const failed = audit(basic.session)
    expect(failed.failure).toMatch(/invalid turn, identity or tool/)
    expect(approvalAuditProjection.stateSchema.parse(failed)).toEqual(failed)
    basic.session.append('approval/policy', { policy: 'never' })
    expect(audit(basic.session)).toEqual(failed)
  })

  it('does not adopt a fork-inherited question as a locally-owned request', () => {
    const { session, id } = plain()
    const events = session.snapshotEvents()
    const fork = Session.create(SessionId('approval-audit-fork'), events, { ...session.header,
      id: SessionId('approval-audit-fork'), parentSession: session.id, isSeeded: true }, SessionLogOffset(events.length))
    expect(audit(fork).requests[id]).toBeUndefined()
    expect(audit(fork).routeId).toBe(ApprovalAnswererRouteId('audit-route'))
  })

  it.each(['outside turn', 'empty tool'] as const)('does not accept an %s question from a detached durable stream', (kind) => {
    const session = Session.create(SessionId('bad-question'))
    if (kind === 'empty tool') session.append('turn/start', { turn: 1 })
    session.append('approval/asked', { id: ApprovalRequestId('bad-question'), toolName: kind === 'empty tool' ? '' : 'sensitive' })
    expect(audit(session).failure).toMatch(/invalid turn, identity or tool/)
  })

  it.each(['unpaired', 'duplicate terminal', 'wrong turn', 'open recovery', 'unrouted recovery'] as const)(
    'rejects %s audit transitions', (kind) => {
      const { session, id } = plain(kind !== 'unrouted recovery')
      if (kind === 'unpaired') session.append('approval/decided', { id: ApprovalRequestId('another'), outcome: 'rejected' })
      else if (kind === 'duplicate terminal') {
        session.append('approval/decided', { id, outcome: 'rejected' })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        session.append('approval/interrupted-rejected', { version: 1, id })
      } else if (kind === 'wrong turn') {
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        session.append('turn/start', { turn: 2 })
        session.append('approval/decided', { id, outcome: 'rejected' })
      } else {
        if (kind === 'unrouted recovery') session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        session.append('approval/interrupted-rejected', { version: 1, id })
      }
      expect(audit(session).failure).toBeDefined()
    },
  )

  it('validates a malformed persisted rejection version without constructing an invalid typed caller value', async () => {
    const { cut, captured } = await captureUnansweredCut()
    const first = await offlineRejectionHarness(cut)
    expect(await first.ctx.approval.rejectInterruptedStored(captured)).toBe(true)
    await first.ctx.fiber.dispose()
    const path = join(first.resources.root, 'sessions', '_no-cwd', cut.header.id, 'session.v4.jsonl')
    const valid = await readFile(path, 'utf8')
    const corrupted = valid.split('\n').map(line => line.includes('approval/interrupted-rejected')
      ? line.replace('"version":1', '"version":2') : line).join('\n')
    expect(corrupted).not.toBe(valid)
    await writeFile(path, corrupted)
    const restored = await offlineRejectionHarness(cut, first.resources)
    const stored = await restored.read()
    const session = Session.create(stored.header.id, stored.events, stored.header)
    expect(audit(session).failure).toMatch(/version 1/)
    await expect(restored.ctx.approval.rejectInterruptedStored(captured)).rejects.toThrow(/valid approval audit projection/)
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SessionStore)
    await ctx.plugin(Invariants)
    await ctx.plugin(ApprovalInvariant)
    expect(() => ctx.sessions.create(session.id, { seed: stored.events, meta: stored.header })).toThrow(/requires version 1/)
  })
})

describe('approval interrupted rejection invariants', () => {
  it.each(['reused id', 'wrong turn', 'open recovery', 'unpaired recovery', 'unrouted recovery', 'duplicate recovery'] as const)(
    'refuses %s before committing the terminal event', async (kind) => {
      const ctx = new Context()
      onTestFinished(async () => { await ctx.fiber.dispose() })
      await ctx.plugin(SessionStore)
      await ctx.plugin(Invariants)
      await ctx.plugin(ApprovalInvariant)
      const session = ctx.sessions.create()
      const id = ApprovalRequestId('invariant-question')
      if (kind !== 'unrouted recovery') session.append('approval/answerer-route', { version: 1, routeId: ApprovalAnswererRouteId('invariant-route') })
      session.append('turn/start', { turn: 1 })
      session.append('approval/asked', { id, toolName: 'sensitive-operation' })
      if (kind === 'reused id') {
        session.append('approval/decided', { id, outcome: 'rejected' })
        expect(() => session.append('approval/asked', { id, toolName: 'second-question' })).toThrow(/reused terminal id/)
      } else if (kind === 'wrong turn') {
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        session.append('turn/start', { turn: 2 })
        expect(() => session.append('approval/decided', { id, outcome: 'rejected' })).toThrow(/another turn/)
      } else if (kind === 'open recovery') {
        expect(() => session.append('approval/interrupted-rejected', { version: 1, id })).toThrow(/no open turn/)
      } else {
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        if (kind === 'unpaired recovery') {
          expect(() => session.append('approval/interrupted-rejected', { version: 1, id: ApprovalRequestId('unknown') })).toThrow(/unmatched/)
        } else if (kind === 'unrouted recovery') {
          expect(() => session.append('approval/interrupted-rejected', { version: 1, id })).toThrow(/originally routed/)
        } else {
          session.append('approval/interrupted-rejected', { version: 1, id })
          expect(() => session.append('approval/interrupted-rejected', { version: 1, id })).toThrow(/unmatched/)
        }
      }
    },
  )
})
