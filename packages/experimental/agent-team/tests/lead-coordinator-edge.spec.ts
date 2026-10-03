import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamLeadExecutions } from '../src/lead-runtime.ts'
import { TeamJournal } from '../src/journal.ts'
import { TeamId, TeamLeadOperationId } from '../src/index.ts'
import { leadCoordinatorHarness } from './lead-coordinator-harness.ts'
import { nativeFacadeHarness } from './native-facade-harness.ts'

describe('native coordination owner rejection', () => {
  it('rejects writes by wrappers, non-rostered children and retired identities at the final journal check', async () => {
    const test = await leadCoordinatorHarness()
    const journal = new TeamJournal(test.ctx, () => undefined, true)
    expect(() => journal.assertCallerWrite(new Proxy(test.lead, {}), test.lead)).toThrow(/no longer live/)
    expect(() => journal.assertCallerWrite(test.lead, new Proxy(test.lead, {}))).toThrow(/no longer live/)
    const child = await test.ctx.agents.create({ sessionId: SessionId('admission-child'), meta: { parentSession: test.lead.id },
      agentOptions: { provider: 'mock', model: 'mock' } })
    expect(() => journal.assertCallerWrite(test.lead, child.agent)).toThrow(/no longer holds/)
    const member = { id: child.agent.id, name: 'admission-child', description: 'Admission fixture', provider: 'spawn',
      context: 'fresh' as const, phase: 'provisioning' as const }
    test.lead.session.append('team/member/configured', { version: 3, teamId: TeamId(test.lead.id), member })
    expect(journal.assertCallerWrite(test.lead, child.agent).members).toHaveLength(1)
    test.lead.session.append('team/member/configured', { version: 3, teamId: TeamId(test.lead.id), member: { ...member, phase: 'active' } })
    expect(journal.assertCallerWrite(test.lead, child.agent).members[0]?.phase).toBe('active')
    await test.freeze()
    await test.writer.commitRecord(child.agent, () => ({ recordId: 'member-continues', dataJson: '{}' }))
    expect(journal.assertCallerWrite(test.lead, child.agent).leadCoordination?.phase).toBe('frozen')
    test.lead.session.append('team/member/configured', { version: 3, teamId: TeamId(test.lead.id), member: { ...member, phase: 'retiring' } })
    expect(() => journal.assertCallerWrite(test.lead, child.agent)).toThrow(/no longer holds/)
    await child.dispose()
  })

  it('closes the service registrar and invalidates old readonly Task handles', async () => {
    const test = await leadCoordinatorHarness()
    const service = test.ctx.agentTeams
    test.writer.dispose()
    await expect(test.writer.read(test.lead, snapshot => snapshot.tasks)).rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    const wrong = service.installTaskExtension({ id: 'wrong-writer', create: async () => { throw new Error('unused') },
      update: async () => { throw new Error('unused') } })
    await expect(wrong.read(test.lead, snapshot => snapshot.tasks)).rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
    wrong.dispose()
    await test.fiber.dispose()
    expect(() => service.installLeadCoordinator({ id: 'after-close' })).toThrow(/disposing/)
  })

  it('refuses another live root as the coordinator anchor and reads ordinary unbound writer state', async () => {
    const test = await leadCoordinatorHarness()
    await expect(test.coordinator.record(new Proxy(test.lead, {}), { operationId: TeamLeadOperationId('wrong'), previousTerm: 1,
      recordId: 'wrong', dataJson: '{}', phase: 'requested' })).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
    const official = await nativeFacadeHarness()
    const writer = official.ctx.agentTeams.installTaskExtension({ id: 'official-writer',
      create: async () => { throw new Error('unused') }, update: async () => { throw new Error('unused') } })
    expect(await writer.read(official.lead, snapshot => snapshot.tasks)).toEqual([])
    writer.dispose()
  })

  it('rejects a non-finite typed term at the durable JSON boundary without leaving an admission barrier', async () => {
    const test = await leadCoordinatorHarness()
    const journal = new TeamJournal(test.ctx, () => undefined, true)
    const invalid = { version: 1 as const, teamId: TeamId(test.lead.id), previousTerm: Number.NaN,
      binding: { executionId: SessionId('unpublished'), term: 2, presetId: 'reviewer', revision: 'a'.repeat(64) },
      extension: { id: 'facade-writer', dataJson: '{}' }, releases: [] }
    await expect(journal.appendAndFlush(test.lead, 'team/lead/transaction', invalid, true, true)).rejects.toThrow(/non-JSON/)
    expect(journal.coordinationConfirmed(test.lead)).toBe(true)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(journal.appendAndFlush(test.lead, 'team/extension', { version: 1, teamId: TeamId(test.lead.id),
      extension: { id: 'typed-record-owner', recordId: 'retained', dataJson: '{}' } }, true, true)).rejects.toThrow(/durability/)
    await expect(journal.appendAndFlush(test.lead, 'team/lead/transaction', invalid, true, true)).rejects.toThrow(/non-JSON/)
    expect(journal.coordinationConfirmed(test.lead)).toBe(false)
    await journal.confirm(test.lead)
    flush.mockRestore()
    expect(test.state().messages).toEqual([])
  })

  it.each(['absent', 'invalid-json', 'oversized'] as const)('requires an available bounded Task audit: %s', async (kind) => {
    const test = await leadCoordinatorHarness({ config: { maxTaskExtensionBytes: 64 } })
    await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'lock' }))
    await test.freeze()
    const next = await test.create('audit-candidate', 2)
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      if (kind === 'absent') test.writer.dispose()
      else test.audit.dataJson = kind === 'invalid-json' ? '{' : JSON.stringify('x'.repeat(65))
      await expect(safe.commitLeadTransaction({ binding: test.binding(next.agent), releases: [], record: { recordId: 'commit', dataJson: '{}' } }))
        .rejects.toMatchObject({ code: kind === 'absent' ? 'TEAM_TASK_EXTENSION_UNAVAILABLE'
          : kind === 'invalid-json' ? 'TEAM_TASK_EXTENSION_INVALID' : 'TEAM_TASK_EXTENSION_TOO_LARGE' })
    })
    expect(test.state().lead).toBeUndefined()
  })

  it('does not use an existing non-commit record as a successful seat transaction', async () => {
    const test = await leadCoordinatorHarness()
    await test.freeze()
    const next = await test.create('existing-material', 2)
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      await safe.record({ recordId: 'commit', dataJson: '{}' })
      await expect(safe.commitLeadTransaction({ binding: test.binding(next.agent), releases: [], record: { recordId: 'commit', dataJson: '{}' } }))
        .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    })
  })

  it('refuses oversized raw record identities before corrupting the persisted projection', async () => {
    const test = await leadCoordinatorHarness()
    await expect(test.coordinator.record(test.lead, { operationId: TeamLeadOperationId('handoff-1'), previousTerm: 1,
      recordId: `${' '.repeat(200)}x`, dataJson: '{}', phase: 'requested' }))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_COORDINATOR_INVALID' })
    expect(test.state().leadCoordination).toBeUndefined()
  })

  it('refuses a retained commit capability and a disappeared live occupation', async () => {
    const test = await leadCoordinatorHarness()
    await test.freeze()
    const next = await test.create('expired-occupation', 2)
    let retained!: import('../src/index.ts').TeamLeadSafePointHandle
    const plan = { binding: test.binding(next.agent), releases: [], record: { recordId: 'commit', dataJson: '{}' } }
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      retained = safe
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      const lookup = vi.spyOn(test.ctx.agents, 'get').mockReturnValueOnce(undefined)
      await expect(safe.commitLeadTransaction(plan)).rejects.toMatchObject({ code: 'TEAM_LEAD_SAFE_POINT_REQUIRED' })
      lookup.mockRestore()
    })
    await expect(retained.commitLeadTransaction(plan)).rejects.toMatchObject({ code: 'TEAM_LEAD_SAFE_POINT_REQUIRED' })
  })

  it('rejects a seat that changes while a frozen incumbent is being cold-resolved', async () => {
    const test = await leadCoordinatorHarness()
    await test.freeze()
    const next = await test.create('activation-race-candidate', 2)
    const executions = Reflect.get(test.ctx.agentTeams, 'leadExecutions') as TeamLeadExecutions
    const resolve = executions.resolveCurrent.bind(executions)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let first = true
    const lookup = vi.spyOn(executions, 'resolveCurrent').mockImplementation(async (...args) => {
      if (first) {
        first = false
        entered.resolve(undefined)
        await release.promise
      }
      return await resolve(...args)
    })
    const old = test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async () => undefined)
    const denied = expect(old).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
    try {
      await entered.promise
      await test.stage('cancelled')
      await test.freeze('replacement')
      await test.coordinator.runAtSafePoint(test.lead, test.safeRequest('replacement'), async (safe) => {
        await safe.record({ recordId: 'replacement-prepared', dataJson: '{}' }, true)
        await safe.commitLeadTransaction({ binding: test.binding(next.agent), releases: [], record: { recordId: 'replacement-commit', dataJson: '{}' } })
      })
      release.resolve(undefined)
      await denied
    } finally { release.resolve(undefined); lookup.mockRestore(); await Promise.allSettled([old, denied]) }
  })
})
