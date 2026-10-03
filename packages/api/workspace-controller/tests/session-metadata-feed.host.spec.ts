/** Workspace follow generations publish active Session metadata and native membership facts. */
import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { WorkspaceFeed } from '../src/feed.ts'
import type { WorkspaceFollowFrame } from '../src/types.ts'

const contexts = new Set<Context>()
const directories = new Set<string>()
afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  contexts.clear()
  await Promise.all([...directories].map(path => rm(path, { recursive: true, force: true })))
  directories.clear()
})

async function boot(root: string, sessionMetadataDomain?: string) {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(Sessions)
  await ctx.plugin(Jsonl, { root: join(root, `sessions-${sessionMetadataDomain ?? 'legacy'}`), compression: 'none' })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(WorkspaceRegistry, sessionMetadataDomain === undefined ? {} : { sessionMetadataDomain })
  return ctx
}

async function next(iterator: AsyncIterator<WorkspaceFollowFrame>): Promise<WorkspaceFollowFrame> {
  const result = await iterator.next()
  if (result.done === true) throw new Error('Workspace follow ended before its committed frame')
  return result.value
}

it('keeps old archive/pin and unobserved Session ids out of both the active baseline and Project increments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-generation-feed-'))
  directories.add(root)
  const cwd = join(root, 'project')
  await mkdir(cwd)
  const old = await boot(root)
  const project = await old.workspaceRegistry.create(cwd, 'Shared Project')
  for (const value of ['same-archive-id', 'same-pin-id', 'retired-id']) {
    const id = SessionId(value)
    old.sessions.create(id, { meta: { cwd } })
    await project.attachSession(id)
  }
  await old.workspaceRegistry.archiveSession(SessionId('same-archive-id'))
  await old.workspaceRegistry.pinSession(SessionId('same-pin-id'))
  await old.fiber.dispose()

  const ctx = await boot(root, 'workspace_active_feed_test')
  for (const value of ['same-archive-id', 'same-pin-id']) ctx.sessions.create(SessionId(value), { meta: { cwd } })
  const feed = new WorkspaceFeed(ctx)
  const controller = new AbortController()
  const iterator = feed.follow(controller.signal)[Symbol.asyncIterator]()
  try {
    const baseline = await next(iterator)
    expect(baseline).toMatchObject({ type: 'baseline', value: { archivedSessionIds: [], pinnedSessionIds: [] } })
    if (baseline.type !== 'baseline') throw new Error('Missing Workspace baseline')
    expect(baseline.value.items[0]?.sessionIds).not.toContain(SessionId('retired-id'))

    await ctx.workspaceRegistry.pinSession(SessionId('same-archive-id'))
    expect(await next(iterator)).toEqual({ type: 'pinned', pinnedSessionIds: [SessionId('same-archive-id')] })
    await ctx.workspaceRegistry.archiveSession(SessionId('same-pin-id'))
    expect(await next(iterator)).toEqual({ type: 'archived', archivedSessionIds: [SessionId('same-pin-id')] })

    const current = ctx.workspaceRegistry.get(project.id)
    if (current === undefined) throw new Error('Missing shared Project')
    await current.setTitle('Renamed Project')
    const updated = await next(iterator)
    expect(updated).toMatchObject({ type: 'upsert', workspace: { workspaceId: project.id, title: 'Renamed Project' } })
    if (updated.type !== 'upsert') throw new Error('Missing Project increment')
    expect(updated.workspace.sessionIds).toEqual(current.sessionIds)
    expect(updated.workspace.sessionIds).not.toContain(SessionId('retired-id'))

    const otherPath = join(root, 'other-project')
    await mkdir(otherPath)
    const other = await ctx.workspaceRegistry.create(otherPath, 'Other Project')
    expect(await next(iterator)).toMatchObject({ type: 'upsert', workspace: { workspaceId: other.id } })
    expect(await next(iterator)).toEqual({ type: 'order', workspaceIds: [other.id, project.id] })
    expect(feed.baseline()).toMatchObject({
      archivedSessionIds: [SessionId('same-pin-id')], pinnedSessionIds: [SessionId('same-archive-id')],
    })
  } finally { controller.abort(); await iterator.return?.() }
})
