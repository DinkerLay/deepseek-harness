/** Real prior-runtime artifact conversion; DSH_LEGACY_RUNTIME_ROOT names its installed package root. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, resolveSessionCwd } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '../src/index.ts'
import { exportLegacySqlite } from '../src/legacy-sqlite.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const runtimeRoot = process.env.DSH_LEGACY_RUNTIME_ROOT
const executeFile = promisify(execFile)
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(runtimeRoot === undefined)('legacy SQLite public-API export', { retry: 0 }, () => {
  it.each([false, true])('preserves the database and converts an old corpus; empty=%s', async (empty) => {
    if (runtimeRoot === undefined) throw new Error('Prior runtime root is required.')
    const root = await mkdtemp(join(tmpdir(), 'dsh-legacy-sqlite-'))
    roots.push(root)
    const database = join(root, 'legacy.sqlite')
    const expected = join(root, 'expected.json')
    const cwd = join(root, 'project')
    await executeFile(process.execPath, [fileURLToPath(new URL('./fixtures/legacy-sqlite/create.mjs', import.meta.url)), JSON.stringify({
      runtimeRoot, database, expected, cwd, empty,
    })])
    const original = await readFile(database)
    const records = JSON.parse(await readFile(expected, 'utf8')) as Array<{
      meta: { id: string; cwd: string; seedLength?: number; delegationDepth?: number }
      events: SessionEvent[]
    }>
    const result = await exportLegacySqlite({ runtimeRoot, database, destination: join(root, 'converted') })
    expect(result.sessions).toBe(records.length)
    expect(result.events).toBe(records.reduce((count, record) => count + record.events.length, 0))
    expect(await readFile(database)).toEqual(original)

    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'Resume the retained conversation.' } })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: result.sessionRoot, compression: 'none', packChunks: false })
    expect((await ctx.sessionPersistence.list()).map(meta => meta.id).sort()).toEqual(records.map(record => record.meta.id).sort())
    for (const record of records) {
      const observed = await ctx.sessionPersistence.inspect(SessionId(record.meta.id))
      expect(observed.events).toEqual(record.events)
      const { seedLength, ...header } = record.meta
      expect(observed.meta).toEqual({ ...header, delegationDepth: header.delegationDepth ?? 0, isSeeded: seedLength !== undefined })
      expect(observed.inheritedEventCount).toBe(record.meta.seedLength ?? 0)
    }
    if (empty) return
    const adapter = new MockAdapter([textResponse('Resumed from SQLite history')])
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(AgentLoop, { agents: [] })
    const handle = await ctx.agents.resume({ resumeSessionId: SessionId('legacy-child'), agentOptions: { provider: 'mock', model: 'mock' } })
    expect(resolveSessionCwd(handle.agent.session)).toBe(join(cwd, 'child-worktree'))
    handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue' }] }))
    await handle.agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
    const branch = ctx.sessions.fork(handle.agent.session, undefined, SessionId('converted-fork'))
    expect(branch.header.parentSession).toBe(handle.agent.id)
    expect(branch.header.cwd).toBe(join(cwd, 'child-worktree'))
    await handle.dispose()
  })

  it('rejects an occupied output and cancellation without changing existing content', async () => {
    if (runtimeRoot === undefined) throw new Error('Prior runtime root is required.')
    const root = await mkdtemp(join(tmpdir(), 'dsh-legacy-occupied-'))
    roots.push(root)
    const marker = join(root, 'keep.txt')
    await writeFile(marker, 'retained')
    await expect(exportLegacySqlite({ runtimeRoot, database: join(root, 'absent.sqlite'), destination: root })).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(exportLegacySqlite({ runtimeRoot, database: join(root, 'absent.sqlite'), destination: join(root, 'cancelled'), signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled')
    expect(await readFile(marker, 'utf8')).toBe('retained')
  })
})
