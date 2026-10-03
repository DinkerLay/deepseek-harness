import { describe, expect, it, vi } from 'vitest'
import { TeamLeadOperationId, TeamMessageId, TeamTaskId } from '../src/index.ts'
import type { TeamLeadSafePointHandle } from '../src/index.ts'
import { leadCoordinatorHarness } from './lead-coordinator-harness.ts'

describe('registered native Lead coordinator', () => {
  it('freezes only Lead writes, releases work and preloads material before durable readiness', async () => {
    const test = await leadCoordinatorHarness()
    await test.writer.commit(test.lead, snapshot => ({ dataJson: '{}', updates: [{ previousRevision: null,
      task: { id: TeamTaskId(`task-${snapshot.nextTaskNumber}`), revision: 1, subject: 'Lead task', description: 'owned',
        ownerId: test.lead.id, status: 'in_progress', blockedBy: [], writeScopes: [] } }] }))
    const releases = await test.releases()
    await test.freeze()
    expect(test.ctx.agentTeams.leadContext(test.lead).ready).toBe(false)
    expect(test.ctx.agentTeams.listTasks(test.lead)).toHaveLength(1)
    await expect(test.writer.commitRecord(test.lead, () => ({ recordId: 'model-record', dataJson: '{}' })))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_FROZEN' })
    const next = await test.create('coordinator-next', 2)
    let retained!: TeamLeadSafePointHandle
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      retained = safe
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      await safe.commitLeadTransaction({ binding: { executionId: next.agent.id, term: 2,
        presetId: 'reviewer', revision: test.state().leadHistory?.at(-1)?.revision ??
          test.ctx.sessionProjections.stateOf(next.agent.session, 'teamLeadExecutionRecord')!.identity!.revision }, releases,
      record: { recordId: 'committed', dataJson: '{"summary":"ready material"}' },
      notices: [{ id: TeamMessageId('handoff-summary'), senderId: test.lead.id, senderName: 'lead', targetId: test.lead.id,
        content: [{ type: 'text', text: 'Automatic handoff material' }] }] })
    })
    expect(retained.signal.aborted).toBe(true)
    await expect(retained.record({ recordId: 'late', dataJson: '{}' })).rejects.toMatchObject({ code: 'TEAM_LEAD_SAFE_POINT_REQUIRED' })
    expect(test.state().tasks[0]).toMatchObject({ status: 'pending', revision: 2 })
    expect(test.state().tasks[0]?.ownerId).toBeUndefined()
    expect(test.state().leadCoordination?.phase).toBe('committed')
    expect(test.state().extensionRecords.find(item => item.recordId === 'committed')?.writerId).toBe('facade-coordinator')
    expect(test.adapter.requests).toHaveLength(0)
    await expect(test.stage('ready')).rejects.toThrow(/mailbox/)
    await test.owner.preloadLeadMail(test.lead, { executionId: next.agent.id, term: 2 })
    expect(test.adapter.requests).toHaveLength(0)
    await test.stage('ready')
    expect(test.ctx.agentTeams.membership(next.agent).role).toBe('lead')
    expect(test.ctx.agentTeams.leadContext(test.lead).ready).toBe(true)
  })

  it('does not mistake failed durability for a record receipt and confirms retry without another event', async () => {
    const test = await leadCoordinatorHarness()
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(test.stage('requested')).rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
    expect(test.state().leadCoordination?.phase).toBe('requested')
    await test.stage('requested')
    expect(test.state().extensionRecords.filter(item => item.recordId === 'handoff-1-requested')).toHaveLength(1)
    flush.mockRestore()
    await expect(test.coordinator.record(test.lead, { operationId: TeamLeadOperationId('handoff-1'), previousTerm: 1,
      recordId: 'handoff-1-requested', dataJson: '{"other":1}', phase: 'requested' })).rejects.toThrow(/different material/)
    await test.stage('frozen')
    await test.stage('cancelled')
    expect(test.ctx.agentTeams.leadContext(test.lead).ready).toBe(true)
    await expect(test.stage('requested', 'stale', 2)).rejects.toThrow(/stale seat/)
  })

  it('shows blockers before idle, never records safe on failed occupation and aborts a hanging idle wait', async () => {
    const test = await leadCoordinatorHarness()
    await test.freeze()
    const idle = vi.spyOn(test.lead, 'whenIdle')
    await expect(test.coordinator.runAtSafePoint(test.lead, { ...test.safeRequest(),
      readBlockers: () => [{ id: 'question', description: 'waiting for an answer' }] }, async () => undefined))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_BLOCKED' })
    expect(idle).not.toHaveBeenCalled()
    const occupy = vi.spyOn(test.lead, 'runMaintenance').mockImplementationOnce(() => { throw new Error('another owner') })
    await expect(test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async () => undefined))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_SAFE_POINT_BUSY' })
    expect(test.state().leadCoordination?.phase).toBe('frozen')
    occupy.mockRestore()
    const entered = Promise.withResolvers<undefined>()
    idle.mockImplementation(() => { entered.resolve(undefined); return new Promise(() => {}) })
    const waiting = test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async () => undefined)
    const observed = expect(waiting).rejects.toMatchObject({ code: 'TEAM_LEAD_COORDINATOR_CLOSED' })
    await entered.promise
    await test.coordinator.dispose()
    await observed
    idle.mockRestore()
  })
})
