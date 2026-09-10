import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { ConversationViewRegistry } from '../src/client/conversation/view-registry.ts'
import type { ConversationViewBuilder } from '../src/client/contract/conversation.ts'

it('decorates late targets per builder and withdraws the wrapper with its caller', async () => {
  const ctx = new Context()
  const views = new ConversationViewRegistry(ctx)
  const changed = vi.fn()
  views.subscribe(changed)
  const native = (): ConversationViewBuilder => ({ empty: 0, replace: () => 1, apply: () => 2 })
  const first = views.entries()
  const wrap = vi.fn((base: ConversationViewBuilder) => ({ ...base, empty: 10 }))
  const consumer = ctx.plugin((owner) => {
    owner.effect(() => views.decorate('chat', 'extension', wrap))
  })
  await consumer.await()
  const remove = views.register({ target: 'chat', create: native })
  const decorated = views.entries()
  expect(decorated).not.toBe(first)
  expect(views.entries()).toBe(decorated)
  expect(decorated[0]?.create().empty).toBe(10)
  expect(decorated[0]?.create()).not.toBe(decorated[0]?.create())
  expect(wrap).toHaveBeenCalledTimes(3)
  expect(() => views.decorate('chat', 'extension', wrap)).toThrow('already registered')
  await consumer.dispose()
  expect(views.entries()[0]?.create().empty).toBe(0)
  expect(changed).toHaveBeenCalledTimes(3)
  remove()
  expect(views.entries()).toEqual([])
  await ctx.fiber.dispose()
})
