/** Session metadata scopes share Project identity while quarantining prior archive and pin state. */
import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage, { storageBackendServiceKey, type StorageBackend } from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry, { WorkspaceId } from '../src/index.ts'

const ACTIVE = 'workspace_native_v4_metadata_test'
const contexts = new Set<Context>()
const directories = new Set<string>()
afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  contexts.clear()
  await Promise.all([...directories].map(path => rm(path, { recursive: true, force: true })))
  directories.clear()
})

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'workspace-session-metadata-'))
  directories.add(path)
  await mkdir(join(path, 'project'))
  return path
}

/** Every service and medium is real; separate JSONL roots represent independent Session generations. */
async function boot(path: string, sessionMetadataDomain?: string, failSharedBinding?: { armed: boolean }) {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(Sessions)
  await ctx.plugin(Jsonl, { root: join(path, `sessions-${sessionMetadataDomain ?? 'legacy'}`), compression: 'none' })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(path, 'storage') })
  let backendName = 'json'
  if (failSharedBinding !== undefined) {
    const underlying = ctx.storage.backend.get('json')
    const facet = underlying.kv
    if (facet === undefined) throw new Error('Missing JSON KV facet')
    const failing: StorageBackend = {
      kv: { open: async (descriptor) => {
        const unit = await facet.open(descriptor)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: async (table, key, value) => {
            if (failSharedBinding.armed && descriptor.name === 'workspace' && table === 'workspaces')
              throw new Error('Selected shared binding write failure')
            await unit.putRecord(table, key, value)
          },
          deleteRecord: (table, key) => unit.deleteRecord(table, key),
          setGlobal: value => unit.setGlobal(value),
          close: () => unit.close(),
        }
      } },
      close: () => underlying.close(),
    }
    ctx.storage.backend.register('failing', failing)
    ctx.provide(storageBackendServiceKey('failing'), failing)
    backendName = 'failing'
  }
  await ctx.plugin(StorageDomain, { backend: backendName })
  const registry = ctx.plugin(WorkspaceRegistry, sessionMetadataDomain === undefined ? {} : { sessionMetadataDomain })
  await Promise.resolve(registry)
  await registry.await()
  return { ctx, registry: ctx.workspaceRegistry }
}

async function seedLegacy(path: string) {
  const first = await boot(path)
  const cwd = join(path, 'project')
  const workspace = await first.registry.create(cwd, 'Shared Project')
  for (const value of ['same-archive-id', 'same-pin-id']) {
    const id = SessionId(value)
    first.ctx.sessions.create(id, { meta: { cwd } })
    await workspace.attachSession(id)
  }
  await first.registry.archiveSession(SessionId('same-archive-id'))
  await first.registry.pinSession(SessionId('same-pin-id'))
  await first.ctx.fiber.dispose()
  return { id: workspace.id, cwd, shared: await readFile(join(path, 'storage', 'workspace.json'), 'utf8') }
}

it('quarantines archive and pin state for same-ID new Sessions without rewriting the shared Project medium', async () => {
  const path = await directory()
  const old = await seedLegacy(path)
  const active = await boot(path, ACTIVE)
  expect(active.registry.sessionMetadataDomainVersion).toBe(1)
  expect(active.registry.sessionMetadataDomain).toBe(ACTIVE)
  expect(active.registry.archivedSessionIds).toEqual([])
  expect(active.registry.pinnedSessionIds).toEqual([])
  expect(active.registry.get(old.id)).toMatchObject({ title: 'Shared Project', path: expect.any(String) })
  expect(await readFile(join(path, 'storage', 'workspace.json'), 'utf8')).toBe(old.shared)

  for (const value of ['same-archive-id', 'same-pin-id']) active.ctx.sessions.create(SessionId(value), { meta: { cwd: old.cwd } })
  await active.registry.pinSession(SessionId('same-archive-id'))
  await active.registry.archiveSession(SessionId('same-pin-id'))
  expect(active.registry.pinnedSessionIds).toEqual([SessionId('same-archive-id')])
  expect(active.registry.archivedSessionIds).toEqual([SessionId('same-pin-id')])
  expect(await readFile(join(path, 'storage', 'workspace.json'), 'utf8')).toBe(old.shared)
})

it('keeps independent Project mutations out of the Session sidecar', async () => {
  const path = await directory()
  const old = await seedLegacy(path)
  const active = await boot(path, ACTIVE)
  active.ctx.sessions.create(SessionId('new-pin'), { meta: { cwd: old.cwd } })
  await active.registry.pinSession(SessionId('new-pin'))
  const sidecarPath = join(path, 'storage', `${ACTIVE}.json`)
  const sidecar = await readFile(sidecarPath, 'utf8')
  const project = active.registry.get(old.id)
  if (project === undefined) throw new Error('Missing shared Project')
  await project.setTitle('Renamed Project')
  const secondPath = join(path, 'second-project')
  await mkdir(secondPath)
  await active.registry.create(secondPath, 'Second Project')
  expect(await readFile(sidecarPath, 'utf8')).toBe(sidecar)
  expect(active.registry.get(old.id)?.title).toBe('Renamed Project')
  expect(active.registry.pinnedSessionIds).toEqual([SessionId('new-pin')])
})

it('restores each metadata scope independently across restart while retaining the shared Project identity', async () => {
  const path = await directory()
  const old = await seedLegacy(path)
  const active = await boot(path, ACTIVE)
  active.ctx.sessions.create(SessionId('same-archive-id'), { meta: { cwd: old.cwd } })
  await active.registry.pinSession(SessionId('same-archive-id'))
  await active.ctx.fiber.dispose()
  const restarted = await boot(path, ACTIVE)
  expect(restarted.registry.pinnedSessionIds).toEqual([SessionId('same-archive-id')])
  expect(restarted.registry.archivedSessionIds).toEqual([])
  expect(restarted.registry.get(old.id)?.title).toBe('Shared Project')
  await restarted.ctx.fiber.dispose()
  const legacy = await boot(path)
  expect(legacy.registry.archivedSessionIds).toEqual([SessionId('same-archive-id')])
  expect(legacy.registry.pinnedSessionIds).toEqual([SessionId('same-pin-id')])
  expect(legacy.registry.get(old.id)?.id).toBe(old.id)
  expect(await readFile(join(path, 'storage', 'workspace.json'), 'utf8')).toBe(old.shared)
})

it('isolates multiple named metadata scopes over the same shared Project registry', async () => {
  const path = await directory()
  const old = await seedLegacy(path)
  const first = await boot(path, ACTIVE)
  first.ctx.sessions.create(SessionId('same-pin-id'), { meta: { cwd: old.cwd } })
  await first.registry.archiveSession(SessionId('same-pin-id'))
  await first.ctx.fiber.dispose()
  const other = await boot(path, 'workspace_other_metadata_test')
  expect(other.registry.archivedSessionIds).toEqual([])
  expect(other.registry.pinnedSessionIds).toEqual([])
  expect(other.registry.get(WorkspaceId(String(old.id)))?.title).toBe('Shared Project')
})

it('recovers a committed deletion notification after its shared binding write fails without changing legacy archive or pin state', async () => {
  const path = await directory()
  const old = await seedLegacy(path)
  const gate = { armed: false }
  const active = await boot(path, ACTIVE, gate)
  const id = SessionId('same-pin-id')
  const session = active.ctx.sessions.create(id, { meta: { cwd: old.cwd } })
  await active.registry.pinSession(id)
  gate.armed = true
  await expect(active.ctx.serial('session-persistence/deleted', session.header, SessionLogOffset(0)))
    .rejects.toThrow('Selected shared binding write failure')
  expect(await readFile(join(path, 'storage', 'workspace.json'), 'utf8')).toBe(old.shared)
  expect(JSON.parse(await readFile(join(path, 'storage', `${ACTIVE}.json`), 'utf8')))
    .toMatchObject({ global: { pendingMutation: { operation: 'remove-session', sessionId: id }, pinnedSessionIds: [id] } })
  await active.ctx.fiber.dispose()

  const restored = await boot(path, ACTIVE)
  expect(restored.registry.pinnedSessionIds).toEqual([])
  expect(restored.registry.archivedSessionIds).toEqual([])
  expect(restored.registry.get(old.id)?.title).toBe('Shared Project')
  const raw = restored.ctx.storageDomain.get('workspace')?.table('workspaces').get(old.id)
  expect(raw).toMatchObject({ sessionIds: [SessionId('same-archive-id')] })
  expect(JSON.parse(await readFile(join(path, 'storage', 'workspace.json'), 'utf8')))
    .toMatchObject({ global: { archivedSessionIds: [SessionId('same-archive-id')], pinnedSessionIds: [id] } })
  expect(JSON.parse(await readFile(join(path, 'storage', `${ACTIVE}.json`), 'utf8')).global).not.toHaveProperty('pendingMutation')
})

it.each(['workspace', '../foreign', 'unsafe-dash'])('rejects metadata domain %s without writing the shared Workspace medium', async (name) => {
  const path = await directory()
  await expect(boot(path, name)).rejects.toThrow()
  await expect(readFile(join(path, 'storage', 'workspace.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
