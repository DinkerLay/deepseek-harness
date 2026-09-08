import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type Session, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionDeletion, { SessionDeletionError } from '../src/index.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** Create stable metadata in one parentSession lineage. */
function header(id: string, cwd: string, parentSession?: ReturnType<typeof SessionId>): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    isSeeded: false,
    cwd,
    ...parentSession === undefined ? {} : { parentSession },
  }
}

/** Materialize one closed durable Session. */
async function persist(ctx: Context, meta: SessionHeader): Promise<void> {
  await ctx.sessionPersistence.create(meta)
  await ctx.sessionPersistence.append(meta.id, [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
}

/** Mount one real persistence provider and the Host-only deletion service. */
async function mounted(): Promise<{ readonly ctx: Context; readonly cwd: string }> {
  const ctx = new Context()
  contexts.push(ctx)
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-session-deletion-cwd-'))
  directories.push(cwd)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-deletion-jsonl-'))
  directories.push(root)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(SessionDeletion)
  return { ctx, cwd }
}

/** Register one minimal idle Agent over an already-live Session. */
function registerIdleAgent(ctx: Context, session: Session): { readonly agent: Agent; readonly detach: () => void } {
  const agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
  } satisfies Agent
  return { agent, detach: ctx.agents.register(agent) }
}

describe('SessionDeletion (JSONL)', () => {
  it('deletes a complete persisted subtree bottom-up', async () => {
    const { ctx, cwd } = await mounted()
    const root = header('jsonl-root', cwd)
    const child = header('jsonl-child', cwd, root.id)
    const grandchild = header('jsonl-grandchild', cwd, child.id)
    await persist(ctx, root)
    await persist(ctx, child)
    await persist(ctx, grandchild)
    const deletedEvents: string[] = []
    ctx.on('session-persistence/deleted', meta => void deletedEvents.push(meta.id))

    const preview = await ctx.sessionDeletion.preview(root.id)
    expect(preview.sessionIds).toEqual([grandchild.id, child.id, root.id])
    await expect(ctx.sessionDeletion.deleteTree(root.id)).resolves.toEqual({
      rootSessionId: root.id,
      sessionIds: [grandchild.id, child.id, root.id],
      deletedSessionIds: [grandchild.id, child.id, root.id],
    })
    expect(deletedEvents).toEqual([grandchild.id, child.id, root.id])
    expect(await ctx.sessionPersistence.list()).toEqual([])
    await expect(ctx.sessionDeletion.deleteTree(root.id)).resolves.toEqual({
      rootSessionId: root.id,
      sessionIds: [],
      deletedSessionIds: [],
    })
  })

  it('deletes a lazy Session identity and notifies derived consumers', async () => {
    const { ctx, cwd } = await mounted()
    const root = header('jsonl-lazy-root', cwd)
    await ctx.sessionPersistence.create(root)
    const deletedEvents: string[] = []
    ctx.on('session-persistence/deleted', meta => void deletedEvents.push(meta.id))

    await expect(ctx.sessionDeletion.deleteTree(root.id)).resolves.toEqual({
      rootSessionId: root.id,
      sessionIds: [root.id],
      deletedSessionIds: [root.id],
    })
    expect(deletedEvents).toEqual([root.id])
    expect(await ctx.sessionPersistence.listDeletionHeaders()).toEqual([])
  })

  it('rejects an unretained live Session before deleting durable state', async () => {
    const { ctx, cwd } = await mounted()
    const meta = header('jsonl-unretained', cwd)
    const session = ctx.sessions.create(meta.id, { meta: { cwd } })
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)

    await expect(ctx.sessionDeletion.deleteTree(meta.id)).rejects.toMatchObject({
      code: 'SESSION_HANDLE_NOT_RETAINED',
      sessionId: meta.id,
    } satisfies Partial<SessionDeletionError>)
    expect((await ctx.sessionPersistence.list()).map(item => item.id)).toContain(meta.id)
  })

  it('claims a retained idle lifecycle and then deletes its durable record', async () => {
    const { ctx, cwd } = await mounted()
    const meta = header('jsonl-tracked', cwd)
    const session = ctx.sessions.prepare(meta.id, { meta: { cwd } })
    const detachSession = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    const { agent, detach: detachAgent } = registerIdleAgent(ctx, session)
    const dispose = vi.fn(async () => {
      detachAgent()
      detachSession()
    })
    const handle = {
      agent,
      dispose,
      reserveIdleDisposal: () => ({ dispose, release: () => {} }),
    }
    vi.spyOn(ctx.agents, 'reserveIdleDisposal').mockReturnValue({
      kind: 'claimed',
      reservation: handle.reserveIdleDisposal(),
    })

    await expect(ctx.sessionDeletion.deleteTree(meta.id)).resolves.toMatchObject({
      deletedSessionIds: [meta.id],
    })
    expect(dispose).toHaveBeenCalledOnce()
    expect(ctx.sessions.get(meta.id)).toBeUndefined()
    expect(ctx.agents.get(meta.id)).toBeUndefined()
  })

  it('releases every earlier live claim when a later subtree member is busy', async () => {
    const { ctx, cwd } = await mounted()
    const rootMeta = header('jsonl-atomic-root', cwd)
    const childMeta = header('jsonl-atomic-child', cwd, rootMeta.id)
    const root = ctx.sessions.create(rootMeta.id, { meta: { cwd } })
    const child = ctx.sessions.create(childMeta.id, { meta: { cwd, parentSession: rootMeta.id } })
    for (const session of [root, child]) {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await ctx.sessions.flush(session)
      registerIdleAgent(ctx, session)
    }
    const release = vi.fn()
    const dispose = vi.fn(async () => {})
    vi.spyOn(ctx.agents, 'reserveIdleDisposal').mockImplementation(id => id === child.id
      ? { kind: 'claimed', reservation: { release, dispose } }
      : { kind: 'busy' })

    await expect(ctx.sessionDeletion.deleteTree(root.id)).rejects.toMatchObject({
      code: 'SESSION_NOT_IDLE',
      sessionId: root.id,
    })
    expect(release).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
    expect((await ctx.sessionPersistence.list()).map(item => item.id).sort())
      .toEqual([child.id, root.id].sort())
  })
})

describe('SessionDeletion recovery and lineage validation', () => {
  it('rejects an unsupported persistence provider before touching a live Session', async () => {
    const { ctx, cwd } = await mounted()
    const session = ctx.sessions.create(SessionId('unsupported-provider'), { meta: { cwd } })
    Object.defineProperty(ctx.sessionPersistence, 'supportsDeletion', { value: false })

    await expect(ctx.sessionDeletion.deleteTree(session.id)).rejects.toMatchObject({
      code: 'PERSISTENCE_UNSUPPORTED',
      sessionId: session.id,
    })
    expect(ctx.sessions.get(session.id)).toBe(session)
  })

  it('claims and disposes a real AgentLoop handle through the registry', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-session-deletion-loop-cwd-'))
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-deletion-loop-jsonl-'))
    directories.push(cwd, root)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { persona: 'Deletion lifecycle test.' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SessionDeletion)
    const sessionId = SessionId('real-loop-idle-deletion')
    await ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { cwd },
    })
    expect(ctx.agents.get(sessionId)).toBeDefined()
    expect(ctx.sessions.get(sessionId)).toBeDefined()
    await expect(ctx.sessionDeletion.preview(sessionId)).resolves.toMatchObject({ sessionIds: [sessionId] })

    await expect(ctx.sessionDeletion.deleteTree(sessionId)).resolves.toMatchObject({
      sessionIds: [sessionId],
      deletedSessionIds: [],
    })
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    expect(await ctx.sessionPersistence.listDeletionHeaders()).toEqual([])
  })

  it('retries after a child commit and converges on the remaining root', async () => {
    const { ctx, cwd } = await mounted()
    const root = header('retry-root', cwd)
    const child = header('retry-child', cwd, root.id)
    await persist(ctx, root)
    await persist(ctx, child)
    const actualDelete = ctx.sessionPersistence.delete.bind(ctx.sessionPersistence)
    let failRoot = true
    vi.spyOn(ctx.sessionPersistence, 'delete').mockImplementation(async (id) => {
      if (id === root.id && failRoot) {
        failRoot = false
        throw new Error('root deletion failed')
      }
      return actualDelete(id)
    })

    await expect(ctx.sessionDeletion.deleteTree(root.id)).rejects.toThrow('root deletion failed')
    expect((await ctx.sessionPersistence.list()).map(item => item.id)).toEqual([root.id])
    await expect(ctx.sessionDeletion.deleteTree(root.id)).resolves.toEqual({
      rootSessionId: root.id,
      sessionIds: [root.id],
      deletedSessionIds: [root.id],
    })
    expect(await ctx.sessionPersistence.list()).toEqual([])
  })

  it('rejects a cyclic durable lineage before reserving or deleting it', async () => {
    const { ctx, cwd } = await mounted()
    const first = header('cycle-first', cwd, SessionId('cycle-second'))
    const second = header('cycle-second', cwd, first.id)
    vi.spyOn(ctx.sessionPersistence, 'listDeletionHeaders').mockResolvedValue([first, second])

    await expect(ctx.sessionDeletion.preview(first.id)).rejects.toMatchObject({
      code: 'SESSION_LINEAGE_INVALID',
      sessionId: first.id,
    })
    expect(await ctx.sessionPersistence.list()).toEqual([])
  })
})
