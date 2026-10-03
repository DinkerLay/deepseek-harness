import { describe, expect, it, vi } from 'vitest'
import { TeamMessageId } from '../src/index.ts'
import type { TeamExtensionNotice, TeamLeadCoordinatorCommit } from '../src/index.ts'
import { TeamTaskBoard } from '../src/task-board.ts'
import { leadCoordinatorHarness } from './lead-coordinator-harness.ts'

describe('native Lead commit retry effects', () => {
  it.each(['omitted', 'empty'] as const)('confirms equivalent %s notices without planning another Task audit', async (initial) => {
    const test = await leadCoordinatorHarness()
    await test.freeze()
    const candidate = await test.create('empty-notice-retry', 2)
    const planner = vi.spyOn(TeamTaskBoard.prototype, 'planLeadRelease')
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      const plan: TeamLeadCoordinatorCommit = { binding: test.binding(candidate.agent), releases: [],
        record: { recordId: 'commit', dataJson: '{}' }, ...initial === 'empty' ? { notices: [] } : {} }
      const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
      await expect(safe.commitLeadTransaction(plan)).rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
      expect(test.ctx.agentTeams.leadContext(test.lead).ready).toBe(false)
      test.audit.dataJson = '{"changedAfterAppend":true}'
      await expect(safe.commitLeadTransaction({ ...plan, notices: [{ id: TeamMessageId('new-notice'), senderId: test.lead.id,
        senderName: 'lead', targetId: test.lead.id, content: [{ type: 'text', text: 'new retained material' }] }] }))
        .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
      const { notices: _notices, ...withoutNotices } = plan
      const retry = initial === 'empty' ? withoutNotices : { ...plan, notices: [] }
      await expect(safe.commitLeadTransaction(retry)).resolves.toEqual(plan.binding)
      expect(planner).toHaveBeenCalledTimes(1)
      flush.mockRestore()
    })
    planner.mockRestore()
    expect(test.state().leadHistory).toHaveLength(1)
    expect(test.state().extensionRecords.filter(item => item.recordId === 'commit')).toHaveLength(1)
    expect(test.lead.session.snapshotEvents().filter(event => event.type === 'team/lead/transaction')
      .map(event => event.data.extension.dataJson)).toEqual(['{}'])
    expect(test.state().messages).toEqual([])
    expect(test.adapter.requests).toEqual([])
  })

  it('confirms notices whose discarded admission hints and overridden authorship retain the same facts', async () => {
    const test = await leadCoordinatorHarness()
    await test.freeze()
    const candidate = await test.create('framed-notice-retry', 2)
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      const notice: TeamExtensionNotice = { id: TeamMessageId('summary'), senderId: test.lead.id, senderName: 'lead',
        targetId: test.lead.id, content: [{ type: 'text', text: 'Automatic reference material' }],
        ordinaryMessageLimit: true, contentParts: ['sender'] }
      const plan: TeamLeadCoordinatorCommit = { binding: test.binding(candidate.agent), releases: [], notices: [notice],
        record: { recordId: 'commit', dataJson: '{"summary":"reference"}' } }
      const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
      await expect(safe.commitLeadTransaction(plan)).rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
      await expect(safe.commitLeadTransaction({ ...plan, notices: [{ ...notice,
        content: [{ type: 'text', text: 'Changed retained reference' }] }] })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
      const { ordinaryMessageLimit: _limit, ...retained } = notice
      await expect(safe.commitLeadTransaction({ ...plan, notices: [{ ...retained,
        contentParts: ['fact'], contentAuthors: [null] }] })).resolves.toEqual(plan.binding)
      flush.mockRestore()
      expect(test.state().messages).toEqual([{ ...retained, contentParts: ['fact'], contentAuthors: [null] }])
    })
    expect(test.state().leadHistory).toHaveLength(1)
    expect(test.adapter.requests).toEqual([])
  })

  it('rejects reordered retained notices after uncertain persistence', async () => {
    const test = await leadCoordinatorHarness()
    await test.freeze()
    const candidate = await test.create('notice-order-retry', 2)
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      const notices: TeamExtensionNotice[] = ['summary', 'supplement'].map(id => ({ id: TeamMessageId(id), senderId: test.lead.id,
        senderName: 'lead', targetId: test.lead.id, content: [{ type: 'text', text: id }] }))
      const plan: TeamLeadCoordinatorCommit = { binding: test.binding(candidate.agent), releases: [], notices,
        record: { recordId: 'commit', dataJson: '{}' } }
      const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
      await expect(safe.commitLeadTransaction(plan)).rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
      await expect(safe.commitLeadTransaction({ ...plan, notices: [...notices].reverse() }))
        .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
      await expect(safe.commitLeadTransaction(plan)).resolves.toEqual(plan.binding)
      flush.mockRestore()
    })
    expect(test.state().messages.map(notice => notice.id)).toEqual(['summary', 'supplement'])
    expect(test.state().leadHistory).toHaveLength(1)
  })
})
