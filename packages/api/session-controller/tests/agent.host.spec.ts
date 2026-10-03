import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import SessionStore, { SESSION_FORMAT_VERSION, SessionLogOffset, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionNotFound,
  ApiSessionSubagentOwnership,
  inspectApiSession,
} from '../src/agent.ts'
import { installModelSelectionProjection } from '../src/model-selection-projection.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const roots: Context[] = []

/** Session cwd roots created per test, removed after their context settles. */
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function harness(): Promise<{ ctx: Context; agents: ApiSessionAgentController }> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.sessionProjections.register(agentPresetProjectionDefinition)
  installModelSelectionProjection(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  return { ctx, agents: new ApiSessionAgentController(ctx) }
}

function header(id: string, cwd: string | null = '/workspace'): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    isSeeded: false,
    ...(cwd === null ? {} : { cwd }),
  }
}

function providePersistence(ctx: Context, persistence: Record<string, unknown>): () => void {
  return ctx.provide('sessionPersistence', testSessionPersistence(ctx, persistence) as never)
}

function agent(ctx: Context, meta: SessionHeader): Agent {
  const session = ctx.sessions.create(meta.id, { meta })
  return { id: meta.id, session, status: 'idle', ctx } as Agent
}

function unpublishedAgent(ctx: Context, meta: SessionHeader): Agent {
  return {
    id: meta.id,
    session: { id: meta.id, header: meta, events: [] },
    status: 'idle',
    ctx,
  } as unknown as Agent
}

function activationCut(meta: SessionHeader): SessionObservation {
  const cut: SessionObservation = {
    source: 'prepared', header: meta, inheritedEventCount: SessionLogOffset(0),
    events: [], cursor: -1, projections: { asOfSeq: -1, values: {} },
    retain: () => cut, [Symbol.dispose]: () => {},
  }
  return cut
}

function expectActivationFailure(result: Awaited<ReturnType<ApiSessionAgentController['resolveObservedAgent']>>, fragment: string): void {
  if (!('error' in result)) throw new Error('activation unexpectedly published an Agent')
  expect(result.error.message).toContain(fragment)
}

describe('optional cold activation preparation', () => {
  it('skips a closing provider retained by an earlier preparation while another activation advances', async () => {
    const { ctx, agents } = await harness()
    const firstEntered = Promise.withResolvers<undefined>()
    const firstRelease = Promise.withResolvers<undefined>()
    const secondEntered = Promise.withResolvers<undefined>()
    const secondRelease = Promise.withResolvers<undefined>()
    const drainingMeta = header('draining-preparation')
    const concurrentMeta = header('concurrent-preparation')
    const concurrentAgent = agent(ctx, concurrentMeta)
    agents.registerActivationPreparation(ctx, 'earlier', async (observation) => {
      if (observation.header.id === concurrentMeta.id) {
        firstEntered.resolve(undefined)
        await firstRelease.promise
      }
      return undefined
    })
    const prepareClosing = vi.fn(async () => {
      secondEntered.resolve(undefined)
      await secondRelease.promise
      return undefined
    })
    const dispose = agents.registerActivationPreparation(ctx, 'closing', prepareClosing)
    vi.spyOn(ctx.agents, 'resume').mockResolvedValue({ agent: concurrentAgent, dispose: () => Promise.resolve() })
    const draining = agents.resolveObservedAgent(activationCut(drainingMeta))
    let concurrent: ReturnType<ApiSessionAgentController['resolveObservedAgent']> | undefined
    let disposed = false
    let disposal: Promise<void> | undefined
    try {
      await secondEntered.promise
      concurrent = agents.resolveObservedAgent(activationCut(concurrentMeta))
      await firstEntered.promise
      disposal = dispose().then(() => { disposed = true })
      expect(disposed).toBe(false)
      firstRelease.resolve(undefined)
      expect(await concurrent).toEqual({ agent: concurrentAgent })
      expect(prepareClosing).toHaveBeenCalledOnce()
      secondRelease.resolve(undefined)
      expectActivationFailure(await draining, 'registration is closed')
      await disposal
      expect(disposed).toBe(true)
    } finally {
      firstRelease.resolve(undefined); secondRelease.resolve(undefined)
      await Promise.all([concurrent, draining, disposal]); await dispose()
    }
  })

  it('rejects owner removal even when its pending preparation returns no contribution', async () => {
    const { ctx, agents } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const dispose = agents.registerActivationPreparation(ctx, 'empty-owner', async () => {
      entered.resolve(undefined)
      await release.promise
      return undefined
    })
    const activating = agents.resolveObservedAgent(activationCut(header('closed-empty-owner')))
    try {
      await entered.promise
      const disposal = dispose()
      release.resolve(undefined)
      expectActivationFailure(await activating, 'registration is closed')
      await disposal
    } finally { release.resolve(undefined); await activating; await dispose() }
  })

  it.each(['before setup', 'during setup', 'before commit'] as const)('rejects preparation removed %s', async (stage) => {
    const { ctx, agents } = await harness()
    const meta = header(`removed-${stage}`)
    const target = agent(ctx, meta)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const cleanup = vi.fn(() => Promise.resolve())
    const mounted = vi.fn(async () => {
      if (stage === 'during setup') { entered.resolve(undefined); await release.promise }
      return { commit: vi.fn() }
    })
    const dispose = agents.registerActivationPreparation(ctx, 'closing-setup', () => ({
      setup: mounted, [Symbol.asyncDispose]: cleanup,
    }))
    vi.spyOn(ctx.agents, 'resume').mockImplementation(async (options) => {
      if (stage === 'before setup') await dispose()
      const commit = await options.setup?.(ctx, target)
      if (stage === 'before commit') await dispose()
      commit?.commit()
      return { agent: target, dispose: () => Promise.resolve() }
    })
    const activating = agents.resolveObservedAgent(activationCut(meta))
    try {
      if (stage === 'during setup') { await entered.promise; await dispose(); release.resolve(undefined) }
      expectActivationFailure(await activating, 'registration is closed')
      expect(cleanup).toHaveBeenCalledOnce()
      expect(mounted).toHaveBeenCalledTimes(stage === 'before setup' ? 0 : 1)
    } finally { release.resolve(undefined); await activating; await dispose() }
  })

  it('prepares the host before exact composition and releases the preparation after publication', async () => {
    const { ctx, agents } = await harness()
    const order: string[] = []
    const meta = { ...header('prepared-activation'), agentPreset: 'target' }
    const target = agent(ctx, meta)
    const defaultComposition = vi.spyOn(agents, 'composeAgent')
    const dispose = agents.registerActivationPreparation(ctx, 'owner', (observation) => {
      expect(observation.header.id).toBe(meta.id)
      order.push('host prepared')
      return { setup: () => { order.push('exact composition'); return { commit: () => { order.push('validated') } } },
        [Symbol.asyncDispose]: () => { order.push('lease released'); return Promise.resolve() } }
    })
    vi.spyOn(ctx.agents, 'resume').mockImplementation(async (options) => {
      const commit = await options.setup?.(ctx, target)
      commit?.commit()
      order.push('published')
      return { agent: target, dispose: () => Promise.resolve() }
    })
    expect(await agents.resolveObservedAgent(activationCut(meta))).toEqual({ agent: target })
    expect(order).toEqual(['host prepared', 'exact composition', 'validated', 'published', 'lease released'])
    expect(defaultComposition).not.toHaveBeenCalled()
    await dispose()
  })

  it('does not resolve or mount a default Preset after preparation rejects', async () => {
    const { ctx, agents } = await harness()
    const meta = header('rejected-activation')
    const composition = vi.spyOn(agents, 'composeAgent')
    const resume = vi.spyOn(ctx.agents, 'resume')
    agents.registerActivationPreparation(ctx, 'owner', () => { throw new Error('restore the recorded declaration') })
    expectActivationFailure(await agents.resolveObservedAgent(activationCut(meta)), 'recorded declaration')
    expect(composition).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('rejects competing owners and releases both contributions without mounting either', async () => {
    const { ctx, agents } = await harness()
    const meta = header('competing-activation')
    const mount = vi.fn()
    const releaseFirst = vi.fn(() => Promise.resolve())
    const releaseSecond = vi.fn(() => Promise.resolve())
    agents.registerActivationPreparation(ctx, 'first', () => ({ setup: mount, [Symbol.asyncDispose]: releaseFirst }))
    agents.registerActivationPreparation(ctx, 'second', () => ({ setup: mount, [Symbol.asyncDispose]: releaseSecond }))
    const resume = vi.spyOn(ctx.agents, 'resume')
    expectActivationFailure(await agents.resolveObservedAgent(activationCut(meta)), 'multiple providers')
    expect(releaseFirst).toHaveBeenCalledOnce()
    expect(releaseSecond).toHaveBeenCalledOnce()
    expect(mount).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('drains a preparing owner on removal and rejects its late contribution', async () => {
    const { ctx, agents } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const ready = Promise.withResolvers<undefined>()
    const released = vi.fn(() => Promise.resolve())
    const mount = vi.fn()
    const dispose = agents.registerActivationPreparation(ctx, 'owner', async () => {
      entered.resolve(undefined)
      await ready.promise
      return { setup: mount, [Symbol.asyncDispose]: released }
    })
    expect(() => agents.registerActivationPreparation(ctx, 'owner', () => undefined)).toThrow(/already registered/)
    const activation = agents.resolveObservedAgent(activationCut(header('unloaded-activation')))
    await entered.promise
    let removed = false
    const removal = dispose().then(() => { removed = true })
    expect(removed).toBe(false)
    ready.resolve(undefined)
    expectActivationFailure(await activation, 'registration is closed')
    await removal
    expect(released).toHaveBeenCalledOnce()
    expect(mount).not.toHaveBeenCalled()
  })

  it('keeps default composition when no owner accepts the Session and after disposal', async () => {
    const { ctx, agents } = await harness()
    const meta = header('unowned-activation')
    const target = agent(ctx, meta)
    const prepare = vi.fn(() => undefined)
    const dispose = agents.registerActivationPreparation(ctx, 'owner', prepare)
    vi.spyOn(ctx.agents, 'resume').mockResolvedValue({ agent: target, dispose: () => Promise.resolve() })
    const composition = vi.spyOn(agents, 'composeAgent')
    await agents.resolveObservedAgent(activationCut(meta))
    expect(prepare).toHaveBeenCalledOnce()
    expect(composition).toHaveBeenCalledOnce()
    await dispose()
    await agents.resolveObservedAgent(activationCut(meta))
    expect(prepare).toHaveBeenCalledOnce()
    expect(composition).toHaveBeenCalledTimes(2)
  })
})

describe('ApiSession identity failures', () => {
  it('describes cwd conflicts with and without a recorded cwd', () => {
    expect(new ApiSessionCwdConflict(SessionId('missing-cwd'), '/wanted', undefined).message)
      .toContain('records no cwd')
    expect(new ApiSessionCwdConflict(SessionId('wrong-cwd'), '/wanted', '/existing').message)
      .toContain('belongs to "/existing"')
  })

  it('maps absent and cwd-less point observations to not found', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    await expect(inspectApiSession(ctx, SessionId('missing')))
      .rejects.toBeInstanceOf(ApiSessionNotFound)

    const inspect = vi.fn(() => Promise.resolve(undefined))
    const stat = vi.fn(() => Promise.resolve(undefined))
    const disposeMissing = providePersistence(ctx, {
      list: () => Promise.resolve([]),
      stat,
      inspect,
    })
    await expect(inspectApiSession(ctx, SessionId('missing'))).rejects.toBeInstanceOf(ApiSessionNotFound)
    // Absence is decided by the stat preflight; the log itself is never opened.
    expect(stat).toHaveBeenCalledOnce()
    expect(inspect).not.toHaveBeenCalled()
    disposeMissing()

    const listed = header('cwd-less-catalog', null)
    const disposeListed = providePersistence(ctx, {
      list: () => Promise.resolve([listed]),
      inspect: () => Promise.resolve({ meta: listed, events: [] }),
    })
    await expect(inspectApiSession(ctx, listed.id)).rejects.toBeInstanceOf(ApiSessionNotFound)
    disposeListed()

    const catalog = header('cwd-less-inspect')
    const inspected = header('cwd-less-inspect', null)
    providePersistence(ctx, {
      list: () => Promise.resolve([catalog]),
      inspect: () => Promise.resolve({ meta: inspected, events: [] }),
    })
    await expect(inspectApiSession(ctx, catalog.id)).rejects.toBeInstanceOf(ApiSessionNotFound)
  })

  it('forwards an explicit inspection signal', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    const meta = header('signalled-inspection')
    const inspect = vi.fn(() => Promise.resolve({ meta, inheritedEventCount: SessionLogOffset(0), events: [] }))
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect,
    })
    const signal = new AbortController().signal

    await expect(inspectApiSession(ctx, meta.id, signal)).resolves.toEqual({ meta, inheritedEventCount: SessionLogOffset(0), events: [] })
    expect(inspect).toHaveBeenCalledWith(meta.id, signal)
  })
})

describe('ApiSession Agent lookup and recovery', () => {
  it('rejects an attached subagent published while a cold observation is being acquired', async () => {
    const { ctx, agents } = await harness()
    const meta = header('raced-cold-owner')
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async () => {
      ctx.sessions.create(meta.id, { meta: { ...meta, origin: 'subagent' } })
      return activationCut(meta)
    })
    const resume = vi.spyOn(ctx.agents, 'resume')
    expect(await agents.resolveAgent(meta.id)).toMatchObject({ error: { code: 'session/agent-busy' } })
    expect(resume).not.toHaveBeenCalled()
  })

  it('resumes directly from a retained observation and rejects an invalid observed header', async () => {
    const { ctx, agents } = await harness()
    const meta = header('observed-resume')
    const resumed = unpublishedAgent(ctx, meta)
    const resume = vi.spyOn(ctx.agents, 'resume').mockResolvedValue({
      agent: resumed,
      dispose: () => Promise.resolve(),
    })
    const observed = {
      source: 'prepared',
      header: meta,
      events: [],
      cursor: -1,
      projections: { asOfSeq: -1, values: {} },
      retain: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    } as unknown as SessionObservation

    await expect(agents.resolveObservedAgent(observed)).resolves.toEqual({ agent: resumed })
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: meta.id }))

    const invalid = {
      ...observed,
      header: header('observed-without-cwd', null),
    } as SessionObservation
    await expect(agents.resolveObservedAgent(invalid)).resolves.toMatchObject({
      error: { code: 'session/not-found' },
    })
  })

  it('projects live Agent contexts and maps missing cold identities through Typert lookup failures', async () => {
    const { ctx } = await harness()
    const live = agent(ctx, header('live'))
    await ctx.agents.register(live)
    providePersistence(ctx, {
      list: () => Promise.resolve([]),
      inspect: vi.fn(),
    })
    const host = ctx.typert.contexts.getHost('agent')
    if (host === undefined) throw new Error('Agent Context resolver was not registered')

    await expect(host.resolve(live.id)).resolves.toBe(live.ctx)
    await expect(host.resolve(SessionId('missing'))).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('returns raced ordinary Agents and ownership failures after resume throws', async () => {
    const ordinary = await harness()
    const ordinaryMeta = header('ordinary-race')
    providePersistence(ordinary.ctx, {
      list: () => Promise.resolve([ordinaryMeta]),
      inspect: () => Promise.resolve({ meta: ordinaryMeta, events: [] }),
    })
    const winner = agent(ordinary.ctx, ordinaryMeta)
    vi.spyOn(ordinary.ctx.agents, 'resume').mockImplementation(async () => {
      await ordinary.ctx.agents.register(winner)
      throw new Error('raced publication')
    })
    await expect(ordinary.agents.resolveAgent(ordinaryMeta.id)).resolves.toEqual({ agent: winner })

    const child = await harness()
    const childMeta = header('child-race')
    providePersistence(child.ctx, {
      list: () => Promise.resolve([childMeta]),
      inspect: () => Promise.resolve({ meta: childMeta, events: [] }),
    })
    vi.spyOn(child.ctx.agents, 'resume').mockImplementation(async () => {
      child.ctx.sessions.create(childMeta.id, {
        meta: { ...childMeta, parentSession: SessionId('parent'), origin: 'subagent' },
      })
      throw new Error('raced child publication')
    })
    await expect(child.agents.resolveAgent(childMeta.id)).resolves.toMatchObject({
      error: { code: 'session/agent-busy' },
    })
  })

  it('reports not-found and ordinary resume failures without fabricating an Agent', async () => {
    const missing = await harness()
    providePersistence(missing.ctx, {
      list: () => Promise.resolve([]),
      inspect: vi.fn(),
    })
    await expect(missing.agents.resolveAgent(SessionId('missing'))).resolves.toMatchObject({
      error: { code: 'session/not-found' },
    })

    const failed = await harness()
    const meta = header('failed')
    providePersistence(failed.ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: [] }),
    })
    vi.spyOn(failed.ctx.agents, 'resume').mockRejectedValue(new Error('factory unavailable'))
    await expect(failed.agents.resolveAgent(meta.id)).resolves.toMatchObject({
      error: { code: 'gateway/internal', message: expect.stringContaining('factory unavailable') as string },
    })
  })

  it('identifies a held Session writer without classifying other resume failures as contention', async () => {
    const { ctx, agents } = await harness()
    const meta = header('owned-session')
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: [] }),
    })
    const resume = vi.spyOn(ctx.agents, 'resume').mockRejectedValue(new SessionAlreadyOwnedError(meta.id))
    await expect(agents.resolveAgent(meta.id)).resolves.toMatchObject({
      error: { code: 'session/writer-held', details: { sessionId: meta.id } },
    })
    resume.mockRejectedValue(Object.assign(new Error('another module copy'), { name: 'SessionAlreadyOwnedError' }))
    await expect(agents.resolveAgent(meta.id)).resolves.toMatchObject({
      error: { code: 'session/writer-held', details: { sessionId: meta.id } },
    })
    resume.mockRejectedValue(new Error('unrelated failure'))
    await expect(agents.resolveAgent(meta.id)).resolves.toMatchObject({
      error: { code: 'gateway/internal' },
    })
  })

  it('retains resume diagnostics without a persistence service', async () => {
    const { ctx, agents } = await harness()
    const meta = header('memory-only-resume')
    ctx.sessions.create(meta.id, { meta })
    vi.spyOn(ctx.agents, 'resume').mockRejectedValue(new Error('factory unavailable'))
    await expect(agents.resolveAgent(meta.id)).resolves.toMatchObject({
      error: { code: 'gateway/internal', message: expect.stringContaining('factory unavailable') as string },
    })
  })

  it('requires projected observations before activation', async () => {
    const { agents } = await harness()
    const meta = header('unprojected-observation')
    const observed = {
      source: 'prepared',
      header: meta,
      events: [],
      cursor: -1,
      retain: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    } as unknown as SessionObservation

    expect(() => agents.presetForObservation(observed)).toThrow(
      'Agent activation requires a projected Session observation',
    )
  })
})

describe('ApiSession model selection', () => {
  it('requires the model-selection projection', async () => {
    const { ctx, agents } = await harness()
    const live = agent(ctx, header('missing-model-projection'))
    vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValue(undefined)

    expect(() => agents.selectionFor(live)).toThrow('required modelSelection projection')
  })

  it('reads a reasoning-free request and consumes only the exact pending selection', async () => {
    const { ctx, agents } = await harness()
    const logged = agent(ctx, header('logged-model'))
    logged.session.append('request/header', {
      header: { config: { provider: 'logged-provider', model: 'logged-model' } },
      reason: 'initial',
    })
    expect(agents.selectionFor(logged).current).toEqual({
      provider: 'logged-provider',
      model: 'logged-model',
    })

    const pending = agent(ctx, header('pending-model'))
    const selection = agents.selectionFor(pending)
    agents.selectForNextRequest(pending, {
      provider: 'selected-provider',
      model: 'selected-model',
      reasoningEffort: 'high' as never,
    })
    expect(selection.current).toMatchObject({
      provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'high',
    })
    expect(agents.consumeSelection(pending, 'other-provider', 'selected-model', 'high')).toBe(false)
    expect(agents.consumeSelection(pending, 'selected-provider', 'other-model', 'high')).toBe(false)
    expect(agents.consumeSelection(pending, 'selected-provider', 'selected-model', 'low')).toBe(false)
    expect(agents.consumeSelection(pending, 'selected-provider', 'selected-model', 'high')).toBe(true)
    expect(selection.current).toEqual({ provider: 'fixture', model: 'fixture-model' })

    const untouched = agent(ctx, header('uninstalled-model'))
    expect(agents.consumeSelection(untouched, 'fixture', 'fixture-model', undefined)).toBe(false)
  })
})

describe('ApiSession create or adoption', () => {
  it('shares one in-flight creation between concurrent callers', async () => {
    const { ctx, agents } = await harness()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-concurrent-'))
    tempDirs.push(cwd)
    const meta = header('concurrent-create', cwd)
    const created = unpublishedAgent(ctx, meta)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const create = vi.spyOn(ctx.agents, 'create').mockImplementation(async () => {
      await gate
      return { agent: created, dispose: () => Promise.resolve() }
    })

    const first = agents.ensureSession(meta.id, cwd, false)
    const second = agents.ensureSession(meta.id, cwd, false)
    release()

    await expect(Promise.all([first, second])).resolves.toEqual([created, created])
    expect(create).toHaveBeenCalledOnce()
  })

  it('accepts a raced ordinary creation and rejects a raced attached child', async () => {
    const ordinary = await harness()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-create-'))
    tempDirs.push(cwd)
    const ordinaryMeta = header('create-race', cwd)
    const winner = agent(ordinary.ctx, ordinaryMeta)
    vi.spyOn(ordinary.ctx.agents, 'create').mockImplementation(async () => {
      await ordinary.ctx.agents.register(winner)
      throw new Error('raced creation')
    })
    await expect(ordinary.agents.ensureSession(ordinaryMeta.id, cwd, false))
      .resolves.toBe(winner)

    const child = await harness()
    const childCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-child-'))
    tempDirs.push(childCwd)
    const childId = SessionId('create-child-race')
    vi.spyOn(child.ctx.agents, 'create').mockImplementation(async () => {
      child.ctx.sessions.create(childId, {
        meta: { cwd: childCwd, parentSession: SessionId('parent'), origin: 'subagent' },
      })
      throw new Error('raced child creation')
    })
    await expect(child.agents.ensureSession(childId, childCwd, false))
      .rejects.toBeInstanceOf(ApiSessionSubagentOwnership)
  })

  it('validates ownership and cwd on the Agent returned by creation', async () => {
    const child = await harness()
    const childCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-returned-child-'))
    tempDirs.push(childCwd)
    const childMeta = {
      ...header('returned-child', childCwd),
      parentSession: SessionId('parent'),
      origin: 'subagent' as const,
    }
    const childAgent = unpublishedAgent(child.ctx, childMeta)
    vi.spyOn(child.ctx.agents, 'create').mockResolvedValue({
      agent: childAgent,
      dispose: () => Promise.resolve(),
    })
    await expect(child.agents.ensureSession(childMeta.id, childCwd, false))
      .rejects.toBeInstanceOf(ApiSessionSubagentOwnership)

    const wrong = await harness()
    const requestedCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-wrong-cwd-'))
    tempDirs.push(requestedCwd)
    const wrongAgent = unpublishedAgent(wrong.ctx, header('wrong-returned-cwd', '/other'))
    vi.spyOn(wrong.ctx.agents, 'create').mockResolvedValue({
      agent: wrongAgent,
      dispose: () => Promise.resolve(),
    })
    await expect(wrong.agents.ensureSession(wrongAgent.id, requestedCwd, false))
      .rejects.toBeInstanceOf(ApiSessionCwdConflict)
  })

  it('resumes a matching persisted identity and preserves its selected preset', async () => {
    const { ctx, agents } = await harness()
    const meta = { ...header('stored'), agentPreset: 'minimal' }
    const events = [{
      type: 'agent-preset/selected',
      seq: 0,
      time: 1,
      data: { agentPreset: 'minimal' },
    }] as SessionEvent[]
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events }),
    })
    ctx.provide('agentPresets', {
      resolve: (id?: string) => Promise.resolve({ id: id ?? 'minimal' }),
      mount: () => Promise.resolve(),
    } as never)
    const resumed = {
      id: meta.id,
      session: {
        id: meta.id,
        header: meta,
        snapshotEvents: () => events,
        eventAt: (seq: number) => events[seq],
        seq: events.length,
      },
      status: 'idle',
      ctx,
    } as unknown as Agent
    const resume = vi.spyOn(ctx.agents, 'resume').mockResolvedValue({
      agent: resumed,
      dispose: () => Promise.resolve(),
    })

    await expect(agents.ensureSession(meta.id, '/workspace', true, 'minimal')).resolves.toBe(resumed)
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: meta.id }))
  })

  it('rejects an ownership race before resume and a persisted cwd conflict', async () => {
    const child = await harness()
    const childMeta = header('resume-child-race')
    providePersistence(child.ctx, {
      list: () => Promise.resolve([childMeta]),
      inspect: () => Promise.resolve({ meta: childMeta, events: [] }),
    })
    child.ctx.provide('agentPresets', {
      resolve: () => {
        child.ctx.sessions.create(childMeta.id, {
          meta: { ...childMeta, parentSession: SessionId('parent'), origin: 'subagent' },
        })
        return Promise.resolve({ id: 'standard' })
      },
      mount: () => Promise.resolve(),
    } as never)
    await expect(child.agents.resolveAgent(childMeta.id)).resolves.toMatchObject({
      error: { code: 'session/agent-busy' },
    })

    const conflict = await harness()
    const stored = header('stored-cwd-conflict', '/stored')
    providePersistence(conflict.ctx, {
      list: () => Promise.resolve([stored]),
      inspect: () => Promise.resolve({ meta: stored, events: [] }),
    })
    await expect(conflict.agents.ensureSession(stored.id, '/requested', true))
      .rejects.toBeInstanceOf(ApiSessionCwdConflict)
  })

  it('surfaces directory creation failure', async () => {
    const { agents } = await harness()
    const parent = mkdtempSync(join(tmpdir(), 'dsh-session-controller-file-'))
    tempDirs.push(parent)
    const file = join(parent, 'file')
    writeFileSync(file, 'not a directory')
    await expect(agents.ensureSession(SessionId('mkdir-failure'), join(file, 'child'), false))
      .rejects.toThrow('failed to ensure project directory')
  })
})
