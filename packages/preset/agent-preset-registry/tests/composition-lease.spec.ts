import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentPresetRegistry, { livePresetMounts } from '../src/index.ts'
import { harness, declare, contribution } from './harness.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() { const ctx = await harness(); contexts.push(ctx); return ctx }

describe('creation composition lease', () => {
  it('refuses a lease whose registry was unloaded while the Host remains live', async () => {
    const ctx = new Context(); contexts.push(ctx)
    await ctx.plugin(Loader)
    await ctx.plugin(SessionProjectionRegistry)
    const registry = ctx.plugin(AgentPresetRegistry, { default: 'standard' })
    await registry
    const unregister = await ctx.agentPresets.register({ id: 'standard', plugins: [] })
    const selected = await ctx.agentPresets.acquireComposition()
    const target = createScope(ctx, {})
    await registry.dispose()
    await expect(selected.mount(target.ctx)).rejects.toThrow('registry has been closed')
    await unregister()
    await selected[Symbol.asyncDispose]()
  })
  it('binds the selected generation after its declaration has been replaced and retains it for the new Agent', async () => {
    const ctx = await setup()
    const old = await declare(ctx, contribution('standard'))
    const selected = await ctx.agentPresets.acquireComposition('standard')
    expect(selected.revision).toMatch(/^[a-f0-9]{64}$/)
    await old.dispose()
    await declare(ctx, { ...contribution('replacement'), id: 'standard' })
    await using replacement = await ctx.agentPresets.acquireComposition('standard')
    expect(replacement.revision).not.toBe(selected.revision)
    const handle = await ctx.agents.create({
      sessionId: SessionId('leased'), meta: { agentPreset: selected.id },
      setup: async (child) => { await selected.mount(child) },
    })
    await selected[Symbol.asyncDispose]()
    expect(ctx.tools.schemas(handle.agent).map(row => row.name)).toEqual(['standard'])
    expect(handle.agent.session.header.agentPreset).toBe('standard')
    expect(livePresetMounts(ctx.fiber)).toHaveLength(2)
    await handle.dispose()
    expect(livePresetMounts(ctx.fiber)).toHaveLength(1)
  })

  it('rejects lease reuse after release and does not leak a retired composition', async () => {
    const ctx = await setup()
    const definition = await declare(ctx, contribution('standard'))
    const selected = await ctx.agentPresets.acquireComposition()
    await definition.dispose()
    await selected[Symbol.asyncDispose]()
    await selected[Symbol.asyncDispose]()
    const scope = createScope(ctx, {})
    await expect(selected.mount(scope.ctx)).rejects.toThrow('released')
    expect(livePresetMounts(ctx.fiber)).toHaveLength(0)
  })

  it('refuses unscoped, closed, already bound and published targets', async () => {
    const ctx = await setup()
    await declare(ctx, contribution('standard'))
    await using selected = await ctx.agentPresets.acquireComposition()
    const foreign = await setup()
    await expect(selected.mount(createScope(foreign, {}).ctx)).rejects.toThrow('another Host')
    await expect(selected.mount(ctx)).rejects.toThrow('scoped')
    const scope = createScope(ctx, {})
    await selected.mount(scope.ctx)
    await expect(selected.mount(scope.ctx)).rejects.toThrow('existing binding')
    const closed = createScope(ctx, {})
    await closed.dispose()
    await expect(selected.mount(closed.ctx)).rejects.toThrow('closed scope')
    const handle = await ctx.agents.create({ sessionId: SessionId('published-bare') })
    await expect(selected.mount(handle.agent.ctx)).rejects.toThrow('published')
    await handle.dispose()
  })

  it('releases a failed creation binding while keeping the caller-owned lease usable', async () => {
    const ctx = await setup()
    const definition = await declare(ctx, contribution('standard'))
    const selected = await ctx.agentPresets.acquireComposition()
    await definition.dispose()
    await expect(ctx.agents.create({ sessionId: SessionId('failed-setup'), setup: async (child) => {
      await selected.mount(child)
      throw new Error('setup failed')
    } })).rejects.toThrow('setup failed')
    expect(ctx.agents.get(SessionId('failed-setup'))).toBeUndefined()
    expect(livePresetMounts(ctx.fiber)).toHaveLength(1)
    await selected[Symbol.asyncDispose]()
    expect(livePresetMounts(ctx.fiber)).toHaveLength(0)
  })
})
