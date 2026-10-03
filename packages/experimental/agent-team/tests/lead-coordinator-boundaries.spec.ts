import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamLeadOperationId, TeamMessageId, TeamTaskId } from '../src/index.ts'
import type { TeamLeadCoordinatorCommit } from '../src/index.ts'
import { leadCoordinatorHarness } from './lead-coordinator-harness.ts'
import { nativeFacadeHarness } from './native-facade-harness.ts'

describe('owned Lead coordination boundaries', () => {
  it('owns one registration and refuses Task namespaces, official anchors and absent operations', async () => {
    const test = await leadCoordinatorHarness()
    expect(() => test.ctx.agentTeams.installLeadCoordinator({ id: 'another' })).toThrow(/already installed/)
    await expect(test.coordinator.record(test.lead, { operationId: TeamLeadOperationId('none'), previousTerm: 1,
      recordId: 'material', dataJson: '{}' })).rejects.toMatchObject({ code: 'TEAM_LEAD_STALE_TERM' })
    await test.coordinator.dispose()
    const wrong = test.ctx.agentTeams.installLeadCoordinator({ id: 'facade-writer' })
    await expect(test.stage('requested', 'wrong', 1, wrong)).rejects.toMatchObject({ code: 'TEAM_LEAD_COORDINATOR_INVALID' })
    const official = await nativeFacadeHarness()
    const coordinator = official.ctx.agentTeams.installLeadCoordinator({ id: 'coordinator' })
    await expect(coordinator.record(official.lead, { operationId: TeamLeadOperationId('wrong'), previousTerm: 1,
      recordId: 'wrong', dataJson: '{}', phase: 'requested' })).rejects.toThrow(/controlled/)
  })

  it('captures a detached product cut inside the freeze transaction', async () => {
    const test = await leadCoordinatorHarness()
    await test.stage('requested')
    await test.coordinator.record(test.lead, { operationId: TeamLeadOperationId('handoff-1'), previousTerm: 1, phase: 'frozen' }, (snapshot) => {
      expect(snapshot.seat).toMatchObject({ executionId: test.lead.id, term: 1 })
      expect(snapshot.records).toEqual([{ recordId: 'handoff-1-requested', dataJson: '{"phase":"requested"}' }])
      expect(snapshot.tasks).toEqual([])
      return { recordId: 'locked-frozen', dataJson: '{"pendingApprovals":["exact-request"]}' }
    })
    await test.coordinator.record(test.lead, { operationId: TeamLeadOperationId('handoff-1'), previousTerm: 1,
      recordId: 'summary-input', dataJson: '{}' })
    await test.stage('failed')
    expect(test.ctx.agentTeams.leadContext(test.lead).ready).toBe(true)
    await test.stage('requested', 'next')
    await expect(test.coordinator.record(test.lead, { operationId: TeamLeadOperationId('next'), previousTerm: 0,
      recordId: 'invalid-term', dataJson: '{}' })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
  })

  it.each(['invalid-json', 'too-large'] as const)('rejects %s product records before changing the Team', async (kind) => {
    const test = await leadCoordinatorHarness({ config: { maxTaskExtensionBytes: 64 } })
    await expect(test.coordinator.record(test.lead, { operationId: TeamLeadOperationId('handoff-1'), previousTerm: 1,
      recordId: 'invalid', dataJson: kind === 'invalid-json' ? '{' : JSON.stringify('x'.repeat(65)), phase: 'requested' }))
      .rejects.toMatchObject({ code: kind === 'invalid-json' ? 'TEAM_TASK_EXTENSION_INVALID' : 'TEAM_TASK_EXTENSION_TOO_LARGE' })
    expect(test.state().leadCoordination).toBeUndefined()
  })

  it('keeps frozen records recoverable after flush throws and checks caller cancellation', async () => {
    const test = await leadCoordinatorHarness()
    await test.stage('requested')
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('storage failed'))
    await expect(test.stage('frozen')).rejects.toThrow('storage failed')
    await test.stage('frozen')
    flush.mockRestore()
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    await expect(test.coordinator.runAtSafePoint(test.lead, { ...test.safeRequest(), signal: controller.signal }, async () => undefined))
      .rejects.toThrow('caller cancelled')
    expect(test.state().leadCoordination?.phase).toBe('frozen')
  })

  it.each([1, 2] as const)('rechecks blockers at observation %i before writing safe', async (blockedAt) => {
    const test = await leadCoordinatorHarness()
    await test.freeze()
    let observed = 0
    await expect(test.coordinator.runAtSafePoint(test.lead, { ...test.safeRequest(), readBlockers: () => observed++ === blockedAt
      ? [{ id: 'external', description: 'external work is still active' }] : [] }, async () => undefined))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_BLOCKED' })
    expect(test.state().leadCoordination?.phase).toBe('frozen')
  })

  it('cancels an occupied preparation without releasing Tasks or retaining the capability', async () => {
    const test = await leadCoordinatorHarness()
    await test.freeze()
    await expect(test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'summary', dataJson: '{}' })
      await test.stage('cancelled')
      return await new Promise(() => {})
    })).rejects.toMatchObject({ code: 'TEAM_LEAD_CANCELLED' })
    expect(test.state().lead).toBeUndefined()
    expect(test.state().leadCoordination?.phase).toBe('cancelled')
    await test.lead.whenIdle()
  })

  it('requires a frozen operation before occupation and prepared product material before commit', async () => {
    const test = await leadCoordinatorHarness()
    await test.stage('requested')
    await expect(test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async () => undefined))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_SAFE_POINT_REQUIRED' })
    await test.stage('frozen')
    const candidate = await test.create('not-prepared', 2)
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      await expect(safe.commitLeadTransaction({ binding: test.binding(candidate.agent), releases: [],
        record: { recordId: 'commit', dataJson: '{}' } })).rejects.toMatchObject({ code: 'TEAM_LEAD_SAFE_POINT_REQUIRED' })
    })
  })

  it('compares complete effects on a commit retry after uncertain persistence', async () => {
    const test = await leadCoordinatorHarness()
    await test.freeze()
    const candidate = await test.create('retry-commit', 2)
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      const plan: TeamLeadCoordinatorCommit = { binding: test.binding(candidate.agent), releases: [],
        record: { recordId: 'commit', dataJson: '{}' } }
      const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
      await expect(safe.commitLeadTransaction(plan)).rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
      await expect(safe.commitLeadTransaction({ ...plan, notices: [{ id: TeamMessageId('different'), senderId: test.lead.id,
        senderName: 'lead', targetId: test.lead.id, content: [] }] })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
      await expect(safe.commitLeadTransaction({ ...plan, record: { ...plan.record, dataJson: '{"changed":true}' } }))
        .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
      await expect(safe.commitLeadTransaction({ ...plan, binding: { ...plan.binding, executionId: SessionId('different') } }))
        .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
      const retry = await safe.commitLeadTransaction(plan)
      expect(retry.executionId).toBe(candidate.agent.id)
      flush.mockRestore()
    })
    expect(test.state().leadHistory).toHaveLength(1)
  })

  it.each(['missing', 'mismatched'] as const)('rejects a %s immutable candidate without changing the seat', async (kind) => {
    const test = await leadCoordinatorHarness()
    await test.freeze()
    const candidate = await test.create('candidate-identity', 2)
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      await expect(safe.commitLeadTransaction({ binding: { ...test.binding(candidate.agent),
        ...kind === 'missing' ? { executionId: SessionId('not-loaded') } : { revision: 'b'.repeat(64) } }, releases: [],
      record: { recordId: 'commit', dataJson: '{}' } })).rejects.toMatchObject({ code: 'TEAM_LEAD_IDENTITY_INVALID' })
    })
    expect(test.state().lead).toBeUndefined()
  })

  it.each(['author', 'sender', 'name', 'target', 'term', 'bytes', 'capacity'] as const)('refuses material with invalid %s', async (kind) => {
    const test = await leadCoordinatorHarness({ config: { maxMessageBytes: 256, maxPendingMessagesPerMember: 1 } })
    await test.freeze()
    const candidate = await test.create('invalid-material', 2)
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      const notice = { id: TeamMessageId('summary'), senderId: test.lead.id, senderName: 'lead', targetId: test.lead.id,
        content: [{ type: 'text' as const, text: kind === 'bytes' ? '文'.repeat(256) : 'facts' }] }
      const notices = kind === 'capacity' ? [notice, { ...notice, id: TeamMessageId('extra') }] : [{ ...notice,
        ...kind === 'author' ? { contentAuthors: [{ executionId: test.lead.id, term: 1 }] } : {},
        ...kind === 'sender' ? { senderId: candidate.agent.id } : {},
        ...kind === 'name' ? { senderName: 'coordinator' } : {},
        ...kind === 'target' ? { targetId: candidate.agent.id } : {},
        ...kind === 'term' ? { senderTerm: 1 } : {},
      }]
      await expect(safe.commitLeadTransaction({ binding: test.binding(candidate.agent), releases: [], notices,
        record: { recordId: 'commit', dataJson: '{}' } })).rejects.toThrow()
    })
    expect(test.state().lead).toBeUndefined()
  })

  it('rejects stale release revisions and modified Task requirements atomically', async () => {
    const test = await leadCoordinatorHarness()
    await test.writer.commit(test.lead, () => ({ dataJson: '{}', updates: [{ previousRevision: null,
      task: { id: TeamTaskId('task-1'), revision: 1, subject: 'Lead work', description: 'immutable', ownerId: test.lead.id,
        status: 'in_progress', blockedBy: [], writeScopes: [] } }] }))
    const releases = await test.releases()
    await test.freeze()
    const candidate = await test.create('stale-release', 2)
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      for (const invalid of [[], [{ ...releases[0]!, previousRevision: 2, task: { ...releases[0]!.task, revision: 3 } }],
        [{ ...releases[0]!, task: { ...releases[0]!.task, subject: 'changed' } }]]) {
        await expect(safe.commitLeadTransaction({ binding: test.binding(candidate.agent), releases: invalid,
          record: { recordId: 'commit', dataJson: '{}' } })).rejects.toMatchObject({ code: 'TEAM_LEAD_TRANSACTION_INVALID' })
      }
    })
    expect(test.state().tasks[0]).toMatchObject({ status: 'in_progress', revision: 1 })
    expect(test.state().lead).toBeUndefined()
  })
})
