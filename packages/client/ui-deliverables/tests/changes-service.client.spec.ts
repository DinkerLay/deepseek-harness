import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ChangesSummaryStore } from '../src/client/changes-summary.ts'
import { changesSummaryService } from '../src/client/changes-service.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('shares one native cache across public consumers, native reads and reset recovery', async () => {
  const value = { turn: 1, files: [{ path: '/workspace/a.ts', display: 'a.ts', added: 2, deleted: 1 }], total: 1, added: 2, deleted: 1 }
  const fetch = vi.fn(async () => new Response(JSON.stringify(value), { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  const store = new ChangesSummaryStore()
  const service = changesSummaryService(store)
  const id = SessionId('service-session')
  const first = service.source(id, 5), second = service.source(id, 5)
  const changed = vi.fn()
  const stop = first.subscribe(changed)
  expect(service.version).toBe(1)
  expect(first.getSnapshot()).toBeUndefined()
  await Promise.all([service.load(id, 5), store.load(id, 5)])
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(first.getSnapshot()).toEqual(value)
  expect(second.getSnapshot()).toBe(first.getSnapshot())
  expect(service.reviewAddress(id, 5, 1)).toContain('changes-review/session/')
  store.reset()
  expect(first.getSnapshot()).toBeUndefined()
  await service.load(id, 5)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(changed).toHaveBeenCalled()
  stop()
  await store.dispose()
})

it('exposes the native missing state after a failed read so consumers can use historical fallback', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
  const store = new ChangesSummaryStore()
  const service = changesSummaryService(store)
  const id = SessionId('restarted-session')
  await service.load(id, 9)
  expect(service.source(id, 9).getSnapshot()).toBe('missing')
  await store.dispose()
})
