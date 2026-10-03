import { describe, expect, it } from 'vitest'
import { leadCoordinatorHarness as setup } from './lead-coordinator-harness.ts'
import { nativeFacadeHarness } from './native-facade-harness.ts'
import { TeamLeadOperationId } from '../src/index.ts'

const begin = { kind: 'begin' as const, applicationId: 'profile-application', profileId: 'profile',
  profileVersion: 1, targetJson: '{}', retiringMemberIds: [], previousPhase: 'dynamic' as const }

describe('native Lead coordination admission', () => {
  it('refuses coordination while a Profile owns the Team composition', async () => {
    const test = await setup()
    await test.ctx.agentTeams.commitComposition(test.lead, () => begin)
    await expect(test.stage('requested')).rejects.toThrow(/Profile application/)
    expect(test.state().leadCoordination).toBeUndefined()
    expect(test.ctx.agentTeams.composition(test.lead).phase).toBe('applying')
  })

  it('refuses Profile begin as soon as coordination reserves the Team, before freezing', async () => {
    const test = await setup()
    await test.stage('requested')
    await expect(test.ctx.agentTeams.commitComposition(test.lead, () => begin))
      .rejects.toMatchObject({ code: 'TEAM_COMPOSITION_APPLYING' })
    expect(test.state().composition?.phase ?? 'dynamic').toBe('dynamic')
    expect(test.state().leadCoordination?.phase).toBe('requested')
  })

  it.each(['composition', 'task'] as const)('rechecks a queued old Lead %s write after the freeze reaches the same lock', async (kind) => {
    const test = await setup()
    await test.stage('requested')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const lock = test.ctx.agentTeams.readCompositionLocked(test.lead, async () => {
      entered.resolve(undefined)
      await release.promise
    })
    await entered.promise
    const freezing = test.stage('frozen')
    // record() reserves its owning job in a microtask. This barrier advances
    // that exact queued operation while the transaction above still owns the lock.
    await Promise.resolve()
    let builderEntered = false
    const late = kind === 'composition'
      ? test.ctx.agentTeams.commitComposition(test.lead, () => { builderEntered = true; return begin })
      : test.ctx.agentTeams.createTask(test.lead, { subject: 'late write', description: 'must not cross freeze' })
    const denied = expect(late).rejects.toThrow()
    try {
      expect(test.state().leadCoordination?.phase).toBe('requested')
      release.resolve(undefined)
      await lock
      await freezing
      await denied
      expect(builderEntered).toBe(false)
      expect(test.state().tasks).toEqual([])
      expect(test.state().composition?.phase ?? 'dynamic').toBe('dynamic')
      expect(test.state().leadCoordination?.phase).toBe('frozen')
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([lock, freezing, denied])
    }
  })

  it.each(['operation', 'term', 'phase'] as const)('refuses reuse of a durable record id with different %s semantics', async (field) => {
    const test = await setup()
    await test.stage('requested')
    await expect(test.coordinator.record(test.lead, { recordId: 'handoff-1-requested',
      operationId: TeamLeadOperationId(field === 'operation' ? 'different-operation' : 'handoff-1'),
      previousTerm: field === 'term' ? 2 : 1,
      phase: field === 'phase' ? 'frozen' : 'requested', dataJson: JSON.stringify({ phase: 'requested' }),
    })).rejects.toThrow()
    expect(test.state().leadCoordination?.phase).toBe('requested')
  })

  it('does not acknowledge an old safe record outside a live maintenance occupation', async () => {
    const test = await setup()
    await test.freeze()
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async () => undefined)
    const count = test.lead.session.snapshotEvents().length
    await expect(test.coordinator.record(test.lead, { operationId: TeamLeadOperationId('handoff-1'), previousTerm: 1,
      phase: 'safe', recordId: 'handoff-1-safe', dataJson: '{}',
    })).rejects.toMatchObject({ code: 'TEAM_LEAD_SAFE_POINT_REQUIRED' })
    expect(test.lead.session.snapshotEvents()).toHaveLength(count)
  })

  it('keeps ordinary official Task creation unchanged without coordination', async () => {
    const test = await nativeFacadeHarness()
    const task = await test.ctx.agentTeams.createTask(test.lead, { subject: 'official task', description: 'ordinary native flow' })
    expect(task).toMatchObject({ revision: 1, status: 'pending', subject: 'official task' })
    expect(test.ctx.sessionProjections.stateOf(test.lead.session, 'agentTeam')?.leadCoordination).toBeUndefined()
    expect(test.lead.session.snapshotEvents().some(event => event.type === 'team/lead/transaction')).toBe(false)
  })
})
