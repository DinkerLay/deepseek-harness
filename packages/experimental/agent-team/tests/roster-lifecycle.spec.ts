import { SessionId } from '@deepseek-ai/dsh-session'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamId, TeamMessageId, type TeamMemberSnapshot } from '../src/index.ts'
import { nativeHarness, nativeInternals, nativeState } from './native-lifecycle-harness.ts'

afterEach(() => { vi.restoreAllMocks() })

function provisioned(name: string): TeamMemberSnapshot {
  return { id: SessionId(name), name, description: 'Recovery fixture', provider: 'spawn', context: 'fresh', phase: 'provisioning' }
}

describe('native roster lifecycle', () => {
  it('rejects group and Preset preflight before reserving a name or starting an execution', async () => {
    const test = await nativeHarness({ validateGroup: (_caller, group) => {
      if (group !== 'reviewers') throw new Error('group is not registered')
    } })
    await expect(test.spawn('preflight-worker', { group: 'unknown', presetId: 'reviewer' })).rejects.toThrow('group is not registered')
    await expect(test.spawn('preflight-worker', { group: 'reviewers', presetId: 'missing' })).rejects.toThrow(/missing/)
    expect(nativeState(test.ctx, test.lead).members).toEqual([])
    expect(test.adapter.requests).toEqual([])
    const registered = await test.spawn('preflight-worker', { group: 'reviewers', presetId: 'reviewer' })
    expect(await test.ctx.sessionPersistence.stat(registered.member.id)).toBeUndefined()
    expect(registered.member.executionStarted).toBe(false)
  })

  it('fails a registered member before its first descriptor and retains pending mail for cancellation', async () => {
    const test = await nativeHarness()
    const registered = await test.spawn('first-failure', { presetId: 'reviewer' })
    const live = await test.ctx.agents.create({ sessionId: registered.member.id,
      meta: { parentSession: test.lead.id, origin: 'subagent' }, agentOptions: { provider: 'mock', model: 'mock' } })
    await expect(test.ctx.agentTeams.cancelPendingMessages(live.agent, registered.member.name, 'not Lead'))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    await test.removeReviewer?.()
    const sent = await test.ctx.agentTeams.sendMessage(test.lead, { target: registered.member.name,
      content: [{ type: 'text', text: 'First work' }], signal: test.signal })
    expect(sent.status).toBe('queued')
    expect(nativeState(test.ctx, test.lead).members[0]?.phase).toBe('failed')
    expect(test.ctx.agentTeams.listMembers(test.lead)[1]?.diagnostics.length).toBe(1)
    expect(await nativeInternals(test.ctx).mailbox.tryDispatch(test.lead,
      nativeState(test.ctx, test.lead).messages.find(message => message.id === sent.messageId)!, test.signal)).toBe(false)
    expect(live.agent.session.snapshotEvents().some(event => event.type === 'subagent/descriptor')).toBe(false)
    const failureId = TeamMessageId(`team-start-failed-${registered.member.id}`)
    expect(nativeState(test.ctx, test.lead).delivered).toContain(failureId)
    expect(await test.ctx.agentTeams.cancelPendingMessages(test.lead, registered.member.name, 'Rebuild explicitly')).toEqual([sent.messageId])
    expect(await test.ctx.agentTeams.cancelPendingMessages(test.lead, registered.member.name, 'Already cancelled')).toEqual([])
    await live.dispose()
    expect((await test.ctx.agentTeams.retireTeammate(test.lead, registered.member.name)).status).toBe('retired')
    await expect(test.spawn(registered.member.name)).rejects.toMatchObject({ code: 'TEAM_MEMBER_NAME_TAKEN' })
    await expect(test.ctx.agentTeams.cancelPendingMessages(test.lead, registered.member.name, 'retired'))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
  })

  it('reconciles controlled provisioning without starting a child and keeps failed-start notices idempotent', async () => {
    const test = await nativeHarness()
    const pending = provisioned('recovered-registration')
    const failed = provisioned('failed-registration')
    test.lead.session.append('team/member/configured', { version: 3, teamId: TeamId(test.lead.id), member: pending })
    test.lead.session.append('team/member/configured', { version: 3, teamId: TeamId(test.lead.id), member: failed })
    test.lead.session.append('team/member/configured', { version: 3, teamId: TeamId(test.lead.id), member: { ...failed, phase: 'failed' } })
    const roster = nativeInternals(test.ctx).roster
    await expect(test.ctx.agentTeams.retireTeammate(test.lead, pending.name)).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_ACTIVE' })
    await roster.recoverFor(test.lead, test.signal)
    await roster.recoverFor(test.lead, test.signal)
    expect(nativeState(test.ctx, test.lead).members.map(member => member.phase)).toEqual(['active', 'failed'])
    expect(nativeState(test.ctx, test.lead).messages.filter(message => message.id === `team-start-failed-${failed.id}`)).toHaveLength(1)
    expect(test.ctx.agents.get(pending.id)).toBeUndefined()
    expect(await test.ctx.sessionPersistence.stat(pending.id)).toBeUndefined()
    expect(test.adapter.requests).toEqual([])
    await roster.failRegisteredMember(test.lead, SessionId('absent'), 'not a member')
    await test.ctx.agentTeams.retireTeammate(test.lead, pending.name)
    await roster.failRegisteredMember(test.lead, pending.id, 'late failure')
    expect(nativeState(test.ctx, test.lead).members[0]?.phase).toBe('retired')
    expect((await test.ctx.agentTeams.retireTeammate(test.lead, pending.name)).status).toBe('retired')
  })

  it('refuses stale application ids and retirement outside the application target', async () => {
    const test = await nativeHarness()
    const selected = await test.spawn('selected-worker')
    const retained = await test.spawn('retained-worker')
    await expect(test.spawn('stale-application', { applicationId: 'expired', slotId: 'slot' }))
      .rejects.toMatchObject({ code: 'TEAM_COMPOSITION_APPLYING' })
    await expect(test.spawn('partial-slot', { slotId: 'slot' })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'begin', applicationId: 'current',
      profileId: 'profile', profileVersion: 1, targetJson: '{}', retiringMemberIds: [selected.member.id], previousPhase: 'dynamic' }))
    await expect(test.ctx.agentTeams.retireTeammate(test.lead, retained.member.name, 'current'))
      .rejects.toMatchObject({ code: 'TEAM_COMPOSITION_APPLYING' })
    expect((await test.ctx.agentTeams.retireTeammate(test.lead, selected.member.name, 'current')).status).toBe('retired')
  })

  it('rechecks the exact Lead after waiting for the roster lock', async () => {
    const test = await nativeHarness()
    const member = await test.spawn('stale-lead-target')
    const service = test.ctx.agentTeams
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const occupied = service.readCompositionLocked(test.lead, async () => {
      entered.resolve(undefined)
      await release.promise
    })
    await entered.promise
    const retirement = service.retireTeammate(test.lead, member.member.name)
    const refused = expect(retirement).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
    try {
      await test.leadHandle.dispose()
      release.resolve(undefined)
      await Promise.all([occupied, refused])
    } finally {
      release.resolve(undefined)
      await occupied
      await retirement.catch(() => undefined)
    }
  })

  it('finishes concurrent retirement once, preserves the name, and recovers a persisted retiring edge', async () => {
    const test = await nativeHarness()
    const member = await test.spawn('concurrent-retirement')
    const results = await Promise.all([
      test.ctx.agentTeams.retireTeammate(test.lead, member.member.name),
      test.ctx.agentTeams.retireTeammate(test.lead, member.member.name),
    ])
    expect(results.map(result => result.status)).toEqual(['retired', 'retired'])
    expect(nativeState(test.ctx, test.lead).members[0]?.phase).toBe('retired')
    const recovering = await test.spawn('recover-retirement')
    const stored = nativeState(test.ctx, test.lead).members.find(row => row.id === recovering.member.id)!
    test.lead.session.append('team/member/configured', { version: 3, teamId: TeamId(test.lead.id), member: { ...stored, phase: 'retiring' } })
    await test.ctx.sessions.flush(test.lead.session)
    const roster = nativeInternals(test.ctx).roster
    await roster.reconcileRetiring(test.lead, test.signal)
    expect(nativeState(test.ctx, test.lead).members[1]?.phase).toBe('retired')
    await expect(roster.settleProvisioning(test.lead, { ...stored, phase: 'active' }))
      .rejects.toMatchObject({ code: 'TEAM_PROVISIONING_CONFLICT' })
    await expect(roster.finishRetirement(test.lead, SessionId('absent')))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_ACTIVE' })
    await expect(test.ctx.agentTeams.retireTeammate(test.lead, 'absent'))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
  })

  it('rejects a non-JSON Preset revision and missing official description before reservation', async () => {
    const test = await nativeHarness({ controlled: false })
    const plugin = new URL('../../../subagent/subagent-in-process-driver/tests/fixtures/plugins/preset-tool.js', import.meta.url).href
    await test.ctx.agentPresets.register({ id: 'non-json', plugins: [{ name: plugin,
      config: { tool: 'fixture-tool', runtimeValue: new Map([['key', 'value']]) } }] })
    await expect(test.spawn('non-json-worker', { presetId: 'non-json' }))
      .rejects.toMatchObject({ code: 'TEAM_PRESET_UNAVAILABLE' })
    await expect(test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'no-description', prompt: [],
      context: 'fresh', provider: 'spawn', signal: test.signal })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    expect(nativeState(test.ctx, test.lead).members).toEqual([])
  })

  it('rejects an empty controlled Preset label before reserving the member', async () => {
    const test = await nativeHarness()
    await test.ctx.agentPresets.register({ id: 'empty-label', name: '', plugins: [] })
    await expect(test.spawn('empty-label-worker', { presetId: 'empty-label' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    expect(nativeState(test.ctx, test.lead).members).toEqual([])
  })

  it('keeps Profile slot identity visible in the roster without activating an execution', async () => {
    const test = await nativeHarness()
    await test.ctx.agentTeams.commitComposition(test.lead, () => ({ kind: 'begin', applicationId: 'slot-application',
      profileId: 'profile', profileVersion: 1, targetJson: '{}', retiringMemberIds: [], previousPhase: 'dynamic' }))
    const registered = await test.spawn('slot-worker', { applicationId: 'slot-application', slotId: 'slot-one' })
    expect(test.ctx.agentTeams.listMembers(test.lead).find(member => member.id === registered.member.id))
      .toMatchObject({ slotId: 'slot-one', executionStarted: false })
    expect(await test.ctx.sessionPersistence.stat(registered.member.id)).toBeUndefined()
    expect(test.adapter.requests).toEqual([])
  })

  it('does not give a marked execution an independent Team after its anchor unloads', async () => {
    const test = await nativeHarness()
    await using lease = await test.ctx.agentPresets.acquireComposition('standard')
    if (lease.revision === undefined) throw new Error('fixture requires a declared Preset')
    const revision = lease.revision
    const candidate = await test.ctx.agents.create({ sessionId: SessionId('orphaned-lead-execution'),
      meta: { parentSession: test.lead.id, agentPreset: lease.id },
      setup: (_ctx, agent) => { agent.session.append('team/lead/execution', {
        version: 1, teamId: TeamId(test.lead.id), term: 2, presetId: lease.id, revision,
      }) } })
    await test.leadHandle.dispose()
    expect(test.ctx.agents.get(candidate.agent.id)).toBe(candidate.agent)
    expect(test.ctx.agentTeams.tryMembership(candidate.agent)).toBeUndefined()
    expect(() => test.ctx.agentTeams.membership(candidate.agent)).toThrow(/not a member/)
    await candidate.dispose()
  })

  it('does not assign a nested Team identity to an unrostered provider child of a live Lead', async () => {
    const test = await nativeHarness({ controlled: false, script: ['hang'] })
    const started = await test.ctx.subagents.startContinuable({ provider: 'spawn', label: 'Independent continuation', signal: test.signal,
      request: { parent: test.lead, prompt: [{ type: 'text', text: 'Independent continuation' }] } })
    const child = await vi.waitFor(() => {
      const current = test.ctx.agents.get(started.childId)
      expect(current).toBeDefined()
      return current!
    })
    await vi.waitFor(() => { expect(child.session.snapshotEvents().some(event => event.type === 'subagent/descriptor')).toBe(true) })
    expect(child.session.header.parentSession).toBe(test.lead.id)
    expect(test.ctx.sessionProjections.stateOf(child.session, 'teamLeadExecutionRecord')).toMatchObject({ identity: null })
    expect(test.ctx.agentTeams.tryMembership(child)).toBeUndefined()
    expect(test.ctx.agents.get(test.lead.id)).toBe(test.lead)
    expect(nativeState(test.ctx, test.lead).members).toEqual([])
  })

  it('preserves a controlled provisioning settlement that wins while recovery waits for the journal', async () => {
    const test = await nativeHarness()
    const member = provisioned('concurrent-registration')
    test.lead.session.append('team/member/configured', { version: 3, teamId: TeamId(test.lead.id), member })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const occupied = test.ctx.agentTeams.readCompositionLocked(test.lead, async () => {
      entered.resolve(undefined)
      await release.promise
    })
    await entered.promise
    const recovering = nativeInternals(test.ctx).roster.reconcileProvisioning(test.lead, test.signal)
    try {
      test.lead.session.append('team/member/configured', { version: 3, teamId: TeamId(test.lead.id),
        member: { ...member, phase: 'failed', error: 'settled before recovery lock' } })
      release.resolve(undefined)
      await Promise.all([occupied, recovering])
      expect(nativeState(test.ctx, test.lead).members[0]).toMatchObject({ phase: 'failed', error: 'settled before recovery lock' })
    } finally {
      release.resolve(undefined)
      await Promise.all([occupied, recovering])
    }
  })

  it.each(['matches', 'preset-id', 'revision'] as const)('reconciles an independently durable child whose Preset %s', async (kind) => {
    const test = await nativeHarness({ controlled: false, script: [textResponse('Initial work complete')] })
    await using lease = await test.ctx.agentPresets.acquireComposition('reviewer')
    if (lease.revision === undefined) throw new Error('fixture requires a declarative Preset')
    const childId = SessionId(`durable-preset-${kind}`)
    await test.ctx.subagents.startContinuable({ childId, provider: 'spawn', label: 'Durable child', signal: test.signal,
      preset: { id: lease.id, revision: lease.revision },
      request: { parent: test.lead, prompt: [{ type: 'text', text: 'Initial work' }] } })
    await vi.waitFor(() => { expect(test.ctx.agents.get(childId)).toBeUndefined() })
    const member = { ...provisioned(`recover-${kind}`), id: childId,
      preset: { id: kind === 'preset-id' ? 'different-preset' : lease.id,
        revision: kind === 'revision' ? 'b'.repeat(64) : lease.revision } }
    test.lead.session.append('team/member/configured', { version: 3, teamId: TeamId(test.lead.id), member })
    await nativeInternals(test.ctx).roster.reconcileProvisioning(test.lead, test.signal)
    expect(nativeState(test.ctx, test.lead).members[0]?.phase).toBe(kind === 'matches' ? 'active' : 'failed')
    expect(test.ctx.agents.get(childId)).toBeUndefined()
  })
})
