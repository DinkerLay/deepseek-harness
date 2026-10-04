import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { initializationHarness } from './model-initialization-harness.ts'

it('follows a cold ordinary Session without Agent promotion only when explicitly read-only', async () => {
  const initial = await initializationHarness()
  const id = SessionId('ordinary-history')
  const handle = await initial.ctx.agents.create({ sessionId: id, meta: { cwd: initial.root },
    agentOptions: { provider: 'initialization', model: 'default' } })
  await initial.controller.rename({ sessionId: id, title: 'Retained ordinary history' })
  await initial.ctx.sessions.flush(handle.agent.session)
  await initial.ctx.fiber.dispose()
  const cold = await initializationHarness(initial.root)
  const resumes = vi.spyOn(cold.ctx.agents, 'resume')
  const abort = new AbortController()
  onTestFinished(() => { abort.abort() })
  const iterator = cold.controller.follow({ address: { kind: 'session', sessionId: id },
    readOnly: true }, abort.signal)[Symbol.asyncIterator]()
  expect(await iterator.next()).toMatchObject({ done: false, value: { type: 'snapshot', header: { id } } })
  const waiting = iterator.next()
  await Promise.resolve()
  expect(resumes).not.toHaveBeenCalled()
  expect(cold.ctx.agents.list()).toEqual([])
  abort.abort()
  expect(await waiting).toMatchObject({ done: true })

  const ordinaryAbort = new AbortController()
  onTestFinished(() => { ordinaryAbort.abort() })
  const created = Promise.withResolvers<undefined>()
  cold.ctx.on('agent/created', ({ agent }) => { if (agent.id === id) created.resolve(undefined) })
  const ordinary = cold.controller.follow({ address: { kind: 'session', sessionId: id } },
    ordinaryAbort.signal)[Symbol.asyncIterator]()
  expect(await ordinary.next()).toMatchObject({ done: false, value: { type: 'snapshot' } })
  const ordinaryWait = ordinary.next()
  await created.promise
  expect(resumes).toHaveBeenCalledOnce()
  expect(cold.adapter.requests).toEqual([])
  ordinaryAbort.abort()
  // Agent promotion can publish its setup suffix before cancellation. Abort
  // stops future reads; it does not retract an already yielded durable event.
  await ordinaryWait
  expect(await ordinary.return?.()).toMatchObject({ done: true })
})
