import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { TeamId } from '../../agent-team/src/index.ts'
import { facadeControlledMode, nativeFacadeHarness } from '../../agent-team/tests/native-facade-harness.ts'
import * as toolTeam from '../src/index.ts'

const collaborationTools = new Set(['spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'retire_teammate', 'team_message_cancel', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'])

function names(ctx: Context, agent: Agent): string[] {
  return ctx.tools.schemas(scopeOf(agent.ctx)).map(schema => schema.name).sort()
}

function collaborationNames(ctx: Context, agent: Agent): string[] {
  return names(ctx, agent).filter(name => collaborationTools.has(name))
}

/** Publish one product readiness change through the existing native extension event. */
function readinessRecord(ctx: Context, lead: Agent, recordId: string): void {
  lead.session.append('team/extension', { version: 1, teamId: TeamId(lead.id),
    extension: { id: facadeControlledMode.requiredTaskExtensionId, recordId, dataJson: '{}' } })
  expect(ctx.sessionProjections.stateOf(lead.session, 'agentTeam')?.failure).toBeUndefined()
}

describe('native Lead collaboration tool lifecycle', () => {
  it('withholds a controlled-only catalog from an official Team and preserves its Preset tools', async () => {
    const test = await nativeFacadeHarness({ leadPresetId: 'reviewer' })
    const controlled = await test.ctx.plugin(toolTeam, { controlledTasks: true })
    try {
      expect(names(test.ctx, test.lead)).toEqual(['review_only'])
      expect(test.ctx.agentTeams.controlledMode(test.lead)).toBeUndefined()
    } finally { await controlled.dispose() }
    const official = await test.ctx.plugin(toolTeam)
    try {
      expect(collaborationNames(test.ctx, test.lead)).toEqual([...collaborationTools].sort())
      expect(names(test.ctx, test.lead)).toContain('review_only')
    } finally { await official.dispose() }
  })

  it('removes only collaboration registrations while frozen and grants them only to the current ready execution', async () => {
    const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode,
      defaultMemberPresetId: 'reviewer' } })
    let ready = true
    const coordinator = test.ctx.agentTeams.installLeadExecutions({ resolveAnchor: () => Promise.resolve(test.lead),
      isReady: () => ready })
    await coordinator.prepareAnchor(test.lead)
    const fiber = await test.ctx.plugin(toolTeam, { controlledTasks: true })
    const expectedTools = [...collaborationTools].sort()
    expect(collaborationNames(test.ctx, test.lead)).toEqual(expectedTools)
    const spawn = test.ctx.tools.get('spawn_teammate', scopeOf(test.lead.ctx))
    expect(spawn?.parameters).toMatchObject({ properties: { preset_id: {
      description: 'Optional declared Agent Preset for this teammate; omit to use the configured member default.',
    } } })
    await using lease = await test.ctx.agentPresets.acquireComposition('reviewer')
    const revision = lease.revision
    if (revision === undefined) throw new Error('reviewer requires a declaration revision')
    const candidate = await coordinator.create(test.lead, { sessionId: SessionId('tool-lead-candidate'), term: 2,
      presetId: lease.id, revision, agentOptions: { provider: 'mock', model: 'mock' } })
    try {
      expect(test.ctx.agentTeams.tryMembership(candidate.agent)).toBeUndefined()
      expect(names(test.ctx, candidate.agent)).toEqual(['review_only'])
      ready = false
      readinessRecord(test.ctx, test.lead, 'freeze-anchor')
      expect(collaborationNames(test.ctx, test.lead)).toEqual([])
      expect(names(test.ctx, candidate.agent)).toEqual(['review_only'])
      ready = true
      readinessRecord(test.ctx, test.lead, 'ready-anchor')
      expect(collaborationNames(test.ctx, test.lead)).toEqual(expectedTools)
      readinessRecord(test.ctx, test.lead, 'still-ready-anchor')
      expect(collaborationNames(test.ctx, test.lead)).toEqual(expectedTools)
      ready = false
      test.lead.session.append('team/lead/transaction', { version: 1, teamId: TeamId(test.lead.id), previousTerm: 1,
        binding: { executionId: candidate.agent.id, term: 2, presetId: lease.id, revision },
        extension: { id: facadeControlledMode.requiredTaskExtensionId, dataJson: '{}' }, releases: [] })
      expect(test.ctx.agentTeams.tryMembership(test.lead)?.role).toBe('host')
      expect(collaborationNames(test.ctx, test.lead)).toEqual([])
      expect(names(test.ctx, candidate.agent)).toEqual(['review_only'])
      ready = true
      readinessRecord(test.ctx, test.lead, 'ready-new-execution')
      expect(test.ctx.agentTeams.membership(candidate.agent)).toMatchObject({ role: 'lead', term: 2 })
      expect(collaborationNames(test.ctx, candidate.agent)).toEqual(expectedTools)
      expect(names(test.ctx, candidate.agent)).toContain('review_only')
      expect(collaborationNames(test.ctx, test.lead)).toEqual([])
      readinessRecord(test.ctx, test.lead, 'still-ready-new-execution')
      expect(collaborationNames(test.ctx, candidate.agent)).toEqual(expectedTools)
      await fiber.dispose()
      expect(names(test.ctx, candidate.agent)).toEqual(['review_only'])
      expect(test.adapter.requests).toHaveLength(0)
    } finally { await fiber.dispose(); await candidate.dispose(); await coordinator.dispose() }
  })
})
