import { expect, it, onTestFinished } from 'vitest'
import { livePresetMounts } from '../src/index.ts'
import { harness, declare, contribution } from './harness.ts'

it('reports uncloneable plugin config as unavailable without publishing a portable composition', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  const base = contribution('dynamic-config-tool')
  await declare(ctx, { ...base, plugins: base.plugins.map(row => ({
    ...row, config: { tool: 'dynamic-config-tool', callback: () => 42 },
  })) })
  const listed = await ctx.agentPresets.list()
  expect(listed).toHaveLength(1)
  expect(listed[0]?.id).toBe(base.id)
  expect(listed[0]?.broken).toMatch(/cloned/u)
  await expect(ctx.agentPresets.acquireComposition(base.id)).rejects.toMatchObject({ code: 'agent-preset/invalid' })
  expect(livePresetMounts(ctx.fiber)).toEqual([])
  expect(ctx.agents.list()).toEqual([])
})
