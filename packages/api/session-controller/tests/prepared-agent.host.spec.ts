/** Strict Host activation reads beside ordinary reentrant reads, using real factory hooks and JSONL. */

import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { initializationHarness } from './model-initialization-harness.ts'

async function storedOrdinary(id: ReturnType<typeof SessionId>) {
  const initial = await initializationHarness()
  await initial.controller.create({ sessionId: id, cwd: initial.root })
  await initial.controller.rename({ sessionId: id, title: 'Stored prepared-resolution fixture' })
  const agent = initial.ctx.agents.get(id)
  if (agent === undefined) throw new Error('fixture did not create its Agent')
  await initial.ctx.sessions.flush(agent.session)
  await initial.ctx.fiber.dispose()
  return await initializationHarness(initial.root)
}

describe('Host prepared Agent resolution', () => {
  it.each(['create', 'resume', 'prepared-resume'] as const)('joins %s hooks while ordinary resolution retains its published reentrant behavior', async (kind) => {
    const id = SessionId(`prepared-${kind}`)
    const test = kind === 'create' ? await initializationHarness() : await storedOrdinary(id)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let published: Agent | undefined
    const remove = test.ctx.on('agent/created', async ({ agent }) => {
      if (agent.id !== id) return
      published = agent
      await expect(test.controller.resolveAgent(id)).resolves.toEqual({ agent })
      entered.resolve(undefined)
      await release.promise
    })
    const activating = kind === 'create'
      ? test.controller.create({ sessionId: id, cwd: test.root }) : kind === 'prepared-resume'
        ? test.controller.resolvePreparedAgent(id) : test.controller.resolveAgent(id)
    let completed = false
    try {
      await entered.promise
      expect(test.ctx.agents.get(id)).toBe(published)
      await expect(test.controller.resolveAgent(id)).resolves.toEqual({ agent: published })
      const prepared = test.controller.resolvePreparedAgent(id).then((result) => { completed = true; return result })
      await test.controller.create({ sessionId: SessionId('independent-prepared'), cwd: test.root })
      expect(completed).toBe(false)
      expect(test.adapter.requests).toHaveLength(0)
      release.resolve(undefined)
      await activating
      expect(await prepared).toEqual({ agent: published })
      expect(completed).toBe(true)
      expect(test.adapter.requests).toHaveLength(0)
    } finally { release.resolve(undefined); await activating; remove() }
  })

  it.each(['create', 'resume', 'prepared-resume'] as const)('does not accept a temporarily live %s whose remaining factory hook fails', async (kind) => {
    const id = SessionId(`failed-prepared-${kind}`)
    const test = kind === 'create' ? await initializationHarness() : await storedOrdinary(id)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const remove = test.ctx.on('agent/created', async ({ agent }) => {
      if (agent.id !== id) return
      entered.resolve(undefined)
      await release.promise
      throw new Error('remaining factory initialization failed')
    })
    const activating = kind === 'create'
      ? test.controller.create({ sessionId: id, cwd: test.root }).then(() => undefined, (error: unknown) => error)
      : kind === 'prepared-resume' ? test.controller.resolvePreparedAgent(id) : test.controller.resolveAgent(id)
    try {
      await entered.promise
      const temporary = test.ctx.agents.get(id)
      expect(temporary).toBeDefined()
      await expect(test.controller.resolveAgent(id)).resolves.toEqual({ agent: temporary })
      const prepared = test.controller.resolvePreparedAgent(id)
      release.resolve(undefined)
      const result = await prepared
      expect(result).toMatchObject({ error: { code: 'gateway/internal' } })
      if (!('error' in result)) throw new Error('failed factory was accepted')
      expect(result.error.message).toContain('factory initialization failed')
      await activating
      expect(test.ctx.agents.get(id)).toBeUndefined()
      expect(test.adapter.requests).toHaveLength(0)
    } finally { release.resolve(undefined); await activating; remove() }
  })

  it('retains ordinary live and missing-Session outcomes when this Controller owns no pending factory', async () => {
    const test = await initializationHarness()
    const id = SessionId('already-prepared')
    await test.controller.create({ sessionId: id, cwd: test.root })
    await expect(test.controller.resolvePreparedAgent(id)).resolves.toEqual({ agent: test.ctx.agents.get(id) })
    await expect(test.controller.resolvePreparedAgent(SessionId('missing-prepared')))
      .resolves.toMatchObject({ error: { code: 'session/not-found' } })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('retains the real subagent ownership refusal without pending Controller work', async () => {
    const test = await initializationHarness()
    const parent = await test.ctx.agents.create({ sessionId: SessionId('prepared-parent'), meta: { cwd: test.root } })
    const child = await test.ctx.agents.create({ sessionId: SessionId('prepared-subagent'), parentAgent: parent.agent,
      meta: { cwd: test.root, parentSession: parent.agent.id, origin: 'subagent' } })
    await expect(test.controller.resolvePreparedAgent(child.agent.id))
      .resolves.toMatchObject({ error: { code: 'session/agent-busy' } })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('rejects a real factory outcome claimed by subagent routing after the pending creation completes', async () => {
    const test = await initializationHarness()
    const id = SessionId('claimed-prepared-subagent')
    const parent = await test.ctx.agents.create({ sessionId: SessionId('claimed-prepared-parent'), meta: { cwd: test.root } })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const remove = test.ctx.on('agent/created', async ({ agent }) => {
      if (agent.id !== id) return
      entered.resolve(undefined)
      await release.promise
    })
    const original = test.ctx.agents.create.bind(test.ctx.agents)
    const create = vi.spyOn(test.ctx.agents, 'create').mockImplementation(async options => await original({ ...options,
      parentAgent: parent.agent, meta: { ...options.meta, parentSession: parent.agent.id, origin: 'subagent' } }))
    const activating = test.controller.create({ sessionId: id, cwd: test.root }).then(() => undefined, (error: unknown) => error)
    try {
      await entered.promise
      const prepared = test.controller.resolvePreparedAgent(id)
      release.resolve(undefined)
      await expect(prepared).resolves.toMatchObject({ error: { code: 'session/agent-busy' } })
      await activating
      expect(test.ctx.agents.get(id)?.session.header.origin).toBe('subagent')
      expect(test.adapter.requests).toHaveLength(0)
    } finally { release.resolve(undefined); await activating; create.mockRestore(); remove() }
  })

  it('does not turn its first failed cold activation into success when another real lifecycle wins the registry race', async () => {
    const id = SessionId('first-prepared-race')
    const test = await storedOrdinary(id)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const remove = test.ctx.on('agent/created', async ({ agent }) => {
      if (agent.id !== id) return
      entered.resolve(undefined)
      await release.promise
      throw new Error('first prepared factory failed')
    })
    const original = test.ctx.agents.resume.bind(test.ctx.agents)
    let replacement: Agent | undefined
    const resume = vi.spyOn(test.ctx.agents, 'resume').mockImplementation(async (options) => {
      try { return await original(options) } catch (error: unknown) {
        remove()
        replacement = (await original(options)).agent
        throw error
      }
    })
    const prepared = test.controller.resolvePreparedAgent(id)
    try {
      await entered.promise
      await expect(test.controller.resolveAgent(id)).resolves.toEqual({ agent: test.ctx.agents.get(id) })
      release.resolve(undefined)
      const result = await prepared
      expect(result).toMatchObject({ error: { code: 'gateway/internal' } })
      if (!('error' in result)) throw new Error('raced failed factory was accepted')
      expect(result.error.message).toContain('first prepared factory failed')
      expect(replacement).toBeDefined()
      expect(test.ctx.agents.get(id)).toBe(replacement)
      await expect(test.controller.resolvePreparedAgent(id)).resolves.toEqual({ agent: replacement })
      expect(test.adapter.requests).toHaveLength(0)
    } finally { release.resolve(undefined); await prepared; resume.mockRestore(); remove() }
  })

  it('maps a shared missing cold activation without adopting any transient identity', async () => {
    const test = await initializationHarness()
    const id = SessionId('shared-missing-prepared')
    const ordinary = test.controller.resolveAgent(id)
    await expect(test.controller.resolvePreparedAgent(id)).resolves.toMatchObject({ error: { code: 'session/not-found' } })
    await expect(ordinary).resolves.toMatchObject({ error: { code: 'session/not-found' } })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('maps a real JSONL writer contention to the existing failure while joining the pending cold read', async () => {
    const id = SessionId('writer-held-prepared')
    const test = await storedOrdinary(id)
    const competitor = await initializationHarness(test.root)
    const writer = await competitor.ctx.agents.resume({ resumeSessionId: id })
    expect(writer.agent.id).toBe(id)
    const ordinary = test.controller.resolveAgent(id)
    await expect(test.controller.resolvePreparedAgent(id)).resolves.toMatchObject({ error: { code: 'session/writer-held' } })
    await expect(ordinary).resolves.toMatchObject({ error: { code: 'session/writer-held' } })
    expect(test.ctx.agents.get(id)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('rejects an actual registry replacement before the Controller observes the completed factory outcome', async () => {
    const test = await initializationHarness()
    const id = SessionId('replaced-prepared')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const remove = test.ctx.on('agent/created', async ({ agent }) => {
      if (agent.id !== id) return
      entered.resolve(undefined)
      await release.promise
    })
    const original = test.ctx.agents.create.bind(test.ctx.agents)
    let replaced = false
    const create = vi.spyOn(test.ctx.agents, 'create').mockImplementation(async (options) => {
      const handle = await original(options)
      if (options.sessionId !== id) return handle
      await test.controller.rename({ sessionId: id, title: 'Replacement fixture' })
      await test.ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
      const next = await test.ctx.agents.resume({ resumeSessionId: id })
      replaced = true
      expect(next.agent).not.toBe(handle.agent)
      return handle
    })
    const activating = test.controller.create({ sessionId: id, cwd: test.root }).then(() => undefined, (error: unknown) => error)
    try {
      await entered.promise
      const prepared = test.controller.resolvePreparedAgent(id)
      remove()
      release.resolve(undefined)
      await expect(prepared).resolves.toMatchObject({ error: { code: 'gateway/internal' } })
      await activating
      expect(replaced).toBe(true)
      expect(test.ctx.agents.get(id)).toBeDefined()
      expect(test.adapter.requests).toHaveLength(0)
    } finally { release.resolve(undefined); await activating; create.mockRestore(); remove() }
  })
})
