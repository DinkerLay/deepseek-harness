/** Explicit ordinary history references over the real Client Gateway assembly. */
import { Context } from '@deepseek-ai/cordis'
import { expect, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ClientSessions } from '../src/client/sessions/service.ts'
import { FOLLOW, followScript, sessionWorld } from './remote/session.client.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { historyTest: unknown }
}

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-gateway']) })
const ID = SessionId('ordinary-readonly-history')

it('opens an explicit unlisted ordinary identity read-only without fabricating a subagent address', async ({ mock, start }) => {
  mock.load(sessionWorld)
  const client = await start()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const sessions = new ClientSessions(ctx, client.ctx.remote)
  mock.stream(FOLLOW, followScript(ok({ records: [], hasMore: false })))
  using reference = sessions.retain({ sessionId: ID, mode: 'read-only' }, { source: 'historyTest' })
  await reference.ready
  const session = reference.binding.session
  expect(session.getSnapshot()).toMatchObject({ openState: 'open', readOnly: true })
  expect(mock.log.requests(FOLLOW)).toMatchObject([{ address: { kind: 'session', sessionId: ID }, readOnly: true }])
  expect(sessions.retainInfo(ID).getSnapshot()).toEqual({ referenceCount: 1, retainedBy: { historyTest: 1 } })
  expect(() => session.beginSubmission({ text: 'must not echo', attachments: [], mode: 'queue' })).toThrow('read-only')
  expect(await session.prompt([{ type: 'text', text: 'must not send' }], 'queue')).toMatchObject({ ok: false })
  expect(await session.cancel()).toMatchObject({ ok: false })
  expect(await session.rename('must not rename')).toMatchObject({ ok: false })
  expect(await session.command('/must-not-run')).toMatchObject({ ok: false })
  expect(await session.updateQueue(MessageId('pending-item'), { kind: 'remove' })).toMatchObject({ ok: false })
  expect(session.getSnapshot().pendingSubmissions).toEqual([])
  for (const endpoint of ['session/prompt', 'session/cancel', 'session/rename', 'session/updateQueue', 'commands/execute']) {
    expect(mock.log.requests(endpoint)).toHaveLength(0)
  }
  reference.release()
  expect(sessions.binding(ID)).toBeUndefined()
  expect(sessions.retainInfo(ID).getSnapshot().referenceCount).toBe(0)
})

it('downgrades a shared generation until all owners release, without changing the next ordinary generation', async ({ mock, start }) => {
  mock.load(sessionWorld)
  const client = await start()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const sessions = new ClientSessions(ctx, client.ctx.remote)
  mock.remote.session.list.mockResolvedValue(ok({ items: [
    { sessionId: ID, updatedAt: 1, running: false, blank: false, agentAvailable: true },
  ] }))
  await sessions.refresh()
  mock.stream(FOLLOW, followScript(ok({ records: [], hasMore: false })))
  using ordinary = sessions.retain(ID, { source: 'historyTest' })
  await ordinary.ready
  expect(ordinary.binding.session.getSnapshot().readOnly).toBeUndefined()
  expect(mock.log.requests(FOLLOW)[0]).not.toHaveProperty('readOnly')
  using history = sessions.retain({ sessionId: ID, mode: 'read-only' }, { source: 'historyTest' })
  await history.ready
  expect(history.binding).toBe(ordinary.binding)
  expect(ordinary.binding.session.getSnapshot().readOnly).toBe(true)
  expect(mock.log.requests(FOLLOW).slice(1)).toMatchObject([{ readOnly: true }])
  history.release()
  expect(ordinary.binding.session.getSnapshot().readOnly).toBe(true)
  expect(await ordinary.binding.session.prompt([{ type: 'text', text: 'still read-only' }], 'queue')).toMatchObject({ ok: false })
  ordinary.release()
  expect(sessions.binding(ID)).toBeUndefined()
  using replacement = sessions.retain(ID, { source: 'historyTest' })
  await replacement.ready
  expect(replacement.binding.session.getSnapshot().readOnly).toBeUndefined()
  expect(mock.log.requests(FOLLOW).at(-1)).not.toHaveProperty('readOnly')
  expect(await replacement.binding.session.prompt([{ type: 'text', text: 'ordinary default' }], 'queue')).toMatchObject({ ok: true })
  expect(mock.log.requests('session/prompt')).toHaveLength(1)
})
