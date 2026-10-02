/** Deployment-owned meaningful records preserve empty-turn UI behavior and cache safety. */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { afterEach, expect, it } from 'vitest'
import { ApiSessionList } from '../src/list.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function setup(eventNames?: readonly string[]) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjections)
  const list = new ApiSessionList(ctx, eventNames)
  const session = ctx.sessions.create(SessionId('list-metadata-session'))
  return { ctx, list, session }
}

it('keeps official turn-only blank classification without configuration', async () => {
  const { list, session } = await setup()
  session.append('session/title', { title: 'Prepared', messageSeqs: [], source: { kind: 'fallback' } })
  expect(list.summaryFor(session).blank).toBe(true)
  session.append('turn/start', { turn: 1 })
  expect(list.summaryFor(session).blank).toBe(false)
})

it('shows a configured meaningful record without starting a model turn', async () => {
  const { list, session } = await setup(['session/title'])
  expect(list.summaryFor(session).blank).toBe(true)
  session.append('session/title', { title: 'Prepared', messageSeqs: [], source: { kind: 'fallback' } })
  expect(list.summaryFor(session).blank).toBe(false)
  expect(session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
})

it('rejects a stale turn-only cache after the meaningful-event policy changes', async () => {
  const first = await setup()
  first.session.append('session/title', { title: 'Prepared', messageSeqs: [], source: { kind: 'fallback' } })
  const cache = first.ctx.sessionProjections.checkpoint(first.session)
  expect(cache.sessionListMetadata?.val).toMatchObject({ blank: true })
  const next = await setup(['session/title'])
  const restored = next.ctx.sessionProjections.restore(cache, first.session.snapshotEvents(),
    SessionLogOffset(0), first.session.header, SessionLogOffset(0))
  expect(restored.snapshot.values.sessionListMetadata).toMatchObject({ blank: false })
  expect(restored.checkpoint.sessionListMetadata?.ver).not.toBe(cache.sessionListMetadata?.ver)
})

it('uses the same cache identity for reordered and repeated event names', async () => {
  const first = await setup(['session/title', 'approval/policy'])
  const next = await setup(['approval/policy', 'session/title', 'session/title'])
  expect(next.ctx.sessionProjections.checkpoint(next.session).sessionListMetadata?.ver)
    .toBe(first.ctx.sessionProjections.checkpoint(first.session).sessionListMetadata?.ver)
})
