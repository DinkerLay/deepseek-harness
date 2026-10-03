import { describe, expect, it } from 'vitest'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { teamProjectionDefinition } from '../src/projection.ts'
import { TeamId } from '../src/types.ts'
import { TeamMessageId, TeamTaskId } from '../src/types.ts'
import type { TeamLeadTransaction } from '../src/lead-seat.ts'

const anchor = SessionId('seat-anchor')
const teamId = TeamId(anchor)
const binding = { executionId: SessionId('seat-execution'), term: 2,
  presetId: 'analyst', revision: 'a'.repeat(64) }
const transaction: TeamLeadTransaction = { version: 1, teamId, previousTerm: 1, binding,
  extension: { id: 'task-writer', dataJson: '{}' }, releases: [] }

function fold(data: unknown = transaction, controlled = true) {
  let state = teamProjectionDefinition.init({ id: anchor, createdAt: 0,
    version: SESSION_FORMAT_VERSION, isSeeded: false })
  if (controlled) state = teamProjectionDefinition.apply(state, { type: 'team/mode', seq: SessionSeq(0), time: 0,
    data: { version: 1, teamId, mode: { kind: 'controlled', requiredTaskExtensionId: 'task-writer',
      permissionTableId: 'table', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } } })
  return teamProjectionDefinition.apply(state, { type: 'team/lead/transaction', seq: SessionSeq(1), time: 0, data } as SessionEvent)
}

describe('native Lead seat projection', () => {
  it('keeps one current seat and retains the execution history without moving the Team', () => {
    const state = fold()
    expect(state.failure).toBeUndefined()
    expect(state.lead).toEqual(binding)
    expect(state.id).toBe(teamId)
    expect(state.members).toEqual([])
    expect(teamProjectionDefinition.stateSchema.safeParse(state).success).toBe(true)
    expect(teamProjectionDefinition.wire.view(state).lead).toEqual(binding)
    const second = teamProjectionDefinition.apply(state, { type: 'team/lead/transaction', seq: SessionSeq(2), time: 0,
      data: { ...transaction, previousTerm: 2, binding: { ...binding, term: 3, executionId: SessionId('third') } } })
    expect(second.lead?.term).toBe(3)
    expect(second.leadHistory?.map(item => item.executionId)).toEqual([binding.executionId, 'third'])
  })

  it.each([
    { ...transaction, previousTerm: 2 },
    { ...transaction, binding: { ...binding, term: 3 } },
    { ...transaction, binding: { ...binding, executionId: anchor } },
    { ...transaction, binding: { ...binding, revision: 'wrong' } },
    { ...transaction, extension: { id: 'task-writer', dataJson: 'invalid JSON' } },
    { ...transaction, extension: { id: 'different-writer', dataJson: '{}' } },
    { ...transaction, releases: [{ previousRevision: null, task: { id: 'task-1', revision: 1,
      subject: 'new', description: 'not a release', status: 'pending', blockedBy: [], writeScopes: [] } }] },
  ])('rejects an invalid persisted seat transaction %j', (data) => {
    expect(fold(data).failure).toBeDefined()
  })

  it('does not let an official Team acquire a product seat transition', () => {
    expect(fold(transaction, false).failure).toMatch(/controlled/)
  })

  it('rejects reuse of an earlier execution on the next term', () => {
    const state = fold()
    const next = teamProjectionDefinition.apply(state, { type: 'team/lead/transaction', seq: SessionSeq(2), time: 0,
      data: { ...transaction, previousTerm: 2, binding: { ...binding, term: 3 } } })
    expect(next.failure).toMatch(/reused/)
    expect(next.lead).toEqual(binding)
  })

  it('releases writer-owned Lead Tasks and queues notices in the same seat event', () => {
    let state = fold()
    const task = { id: TeamTaskId('task-1'), revision: 1, subject: 'Lead work', description: 'release at commit',
      ownerId: anchor, status: 'in_progress' as const, blockedBy: [], writeScopes: [] }
    state = teamProjectionDefinition.apply(state, { type: 'team/task/transaction', seq: SessionSeq(2), time: 0,
      data: { version: 1, teamId, updates: [{ previousRevision: null, task }],
        extension: { id: 'task-writer', dataJson: '{}' } } })
    const { ownerId: _owner, ...withoutOwner } = task
    const notice = { id: TeamMessageId('seat-notice'), senderId: anchor, senderName: 'lead', targetId: anchor,
      content: [{ type: 'text' as const, text: 'automatic material' }] }
    const data = { ...transaction, previousTerm: 2,
      binding: { ...binding, executionId: SessionId('release-third'), term: 3 },
      releases: [{ previousRevision: 1, task: { ...withoutOwner, revision: 2, status: 'pending' as const } }],
      notices: [notice] }
    const result = teamProjectionDefinition.apply(state, { type: 'team/lead/transaction', seq: SessionSeq(3), time: 0, data })
    expect(result.failure).toBeUndefined()
    expect(result.tasks[0]).toMatchObject({ revision: 2, status: 'pending' })
    expect(result.tasks[0]?.ownerId).toBeUndefined()
    expect(result.messages).toEqual([notice])
    expect(result.lead?.term).toBe(3)
    const missing = teamProjectionDefinition.apply(state, { type: 'team/lead/transaction', seq: SessionSeq(3), time: 0,
      data: { ...data, releases: [] } })
    expect(missing.failure).toMatch(/every running Lead Task/)
    const duplicate = teamProjectionDefinition.apply(state, { type: 'team/lead/transaction', seq: SessionSeq(3), time: 0,
      data: { ...data, notices: [notice, notice] } })
    expect(duplicate.failure).toMatch(/queued twice/)
    for (const status of ['in_progress', 'completed'] as const) {
      const invalid = teamProjectionDefinition.apply(state, { type: 'team/lead/transaction', seq: SessionSeq(3), time: 0,
        data: { ...data, releases: [{ previousRevision: 1, task: { ...withoutOwner, revision: 2, status } }] } })
      expect(invalid.failure).toMatch(/release/)
    }
    const retainedOwner = teamProjectionDefinition.apply(state, { type: 'team/lead/transaction', seq: SessionSeq(3), time: 0,
      data: { ...data, releases: [{ previousRevision: 1, task: { ...task, revision: 2, status: 'pending' } }] } })
    expect(retainedOwner.failure).toMatch(/release/)
    const nullRevision = teamProjectionDefinition.apply(state, { type: 'team/lead/transaction', seq: SessionSeq(3), time: 0,
      data: { ...data, releases: [{ previousRevision: null, task: { ...withoutOwner, revision: 2, status: 'pending' } }] } })
    expect(nullRevision.failure).toMatch(/release/)
    const stale = teamProjectionDefinition.apply(state, { type: 'team/lead/transaction', seq: SessionSeq(3), time: 0,
      data: { ...data, releases: [{ previousRevision: 2, task: { ...withoutOwner, revision: 3, status: 'pending' } }] } })
    expect(stale.failure).toMatch(/stale/)
    const queuedState = teamProjectionDefinition.apply(state, { type: 'team/message/queued', seq: SessionSeq(3), time: 0,
      data: { version: 2, teamId, message: notice } })
    expect(teamProjectionDefinition.apply(queuedState, { type: 'team/lead/transaction', seq: SessionSeq(4), time: 0, data })
      .failure).toMatch(/queued twice/)
    const foreignOwner = { ...state, taskWriters: [{ taskId: task.id, writerId: 'foreign' }] }
    expect(teamProjectionDefinition.apply(foreignOwner, { type: 'team/lead/transaction', seq: SessionSeq(3), time: 0, data })
      .failure).toMatch(/writer-owned/)
  })

  it('does not reuse a member execution as a Lead candidate', () => {
    const state = fold()
    const memberId = SessionId('reserved-member')
    const rostered = teamProjectionDefinition.apply(state, { type: 'team/member/configured', seq: SessionSeq(2), time: 0,
      data: { version: 3, teamId, member: { id: memberId, name: 'reserved', description: 'member',
        provider: 'spawn', context: 'fresh', phase: 'provisioning' } } })
    const result = teamProjectionDefinition.apply(rostered, { type: 'team/lead/transaction', seq: SessionSeq(3), time: 0,
      data: { ...transaction, previousTerm: 2, binding: { ...binding, executionId: memberId, term: 3 } } })
    expect(result.failure).toMatch(/reused execution/)
  })
})
