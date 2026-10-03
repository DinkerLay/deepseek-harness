import { describe, expect, it, vi } from 'vitest'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { leadCoordinatorHarness } from '../../agent-team/tests/lead-coordinator-harness.ts'
import * as toolTeam from '../src/index.ts'

describe('confirmed native Lead collaboration catalog', () => {
  it('installs collaboration tools only after the new seat readiness checkpoint succeeds', async () => {
    const test = await leadCoordinatorHarness()
    const fiber = await test.ctx.plugin(toolTeam, { controlledTasks: true })
    await test.freeze()
    const candidate = await test.create('confirmed-tool-recipient', 2)
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      await safe.commitLeadTransaction({ binding: test.binding(candidate.agent), releases: [], record: { recordId: 'commit', dataJson: '{}' } })
    })
    const names = () => test.ctx.tools.schemas(scopeOf(candidate.agent.ctx)).map(schema => schema.name)
    expect(names()).toEqual(['review_only'])
    const enter = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      enter.resolve(undefined)
      await release.promise
      return await original(session)
    })
    const ready = test.stage('ready')
    try {
      await enter.promise
      expect(names()).toEqual(['review_only'])
      release.resolve(undefined)
      await ready
      expect(names()).toContain('team_task_create')
      expect(names()).toContain('review_only')
      await fiber.dispose()
      expect(names()).toEqual(['review_only'])
    } finally { release.resolve(undefined); flush.mockRestore(); await Promise.allSettled([ready, fiber.dispose()]) }
  })
})
