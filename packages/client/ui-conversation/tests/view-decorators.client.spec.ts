import { Context } from '@deepseek-ai/cordis'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { ConversationTimelineSnapshot, ConversationViewBuilder, ConversationViewNode } from '../src/client/contract/conversation.ts'
import type { ConversationGroupDefinition, ConversationGroupInput } from '../src/client/contract/groups.ts'
import { ConversationNodeAssembler } from '../src/client/conversation/assembler.ts'
import { ConversationViewRegistry } from '../src/client/conversation/view-registry.ts'

it('decorates late targets per builder and withdraws only the caller-owned wrapper', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const views = new ConversationViewRegistry(ctx)
  const changed = vi.fn()
  views.subscribe(changed)
  const native = (): ConversationViewBuilder => ({ empty: 0, replace: () => 1, apply: () => 2 })
  const wrap = vi.fn((base: ConversationViewBuilder) => ({ ...base, empty: 10 }))
  const consumer = ctx.plugin((owner) => { owner.effect(() => views.decorate('chat', 'extension', wrap)) })
  await consumer.await()
  const remove = views.register({ target: 'chat', toolCallFocus: id => `call:${id}`, create: native })
  const decorated = views.entries()
  expect(views.builderDecoratorsVersion).toBe(1)
  expect(views.entries()).toBe(decorated)
  expect(decorated[0]?.toolCallFocus?.('one')).toBe('call:one')
  expect(decorated[0]?.create().empty).toBe(10)
  expect(decorated[0]?.create()).not.toBe(decorated[0]?.create())
  expect(wrap).toHaveBeenCalledTimes(3)
  expect(() => views.decorate('chat', 'extension', wrap)).toThrow('already registered')
  await consumer.dispose()
  expect(views.entries()[0]?.create().empty).toBe(0)
  expect(changed).toHaveBeenCalledTimes(3)
  remove()
  expect(views.entries()).toEqual([])
})

it('preserves group input, changed Turns and notification ordering through multiple decorators', () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const views = new ConversationViewRegistry(ctx)
  const order: string[] = []
  let changedTurns: readonly number[] = []
  let timeline: ConversationTimelineSnapshot = { turnOrder: [], turns: new Map() }
  const native: ConversationViewBuilder = {
    empty: null,
    replace: (input) => { timeline = input.timeline; return null },
    apply: (input) => { timeline = input.timeline; changedTurns = input.changedTurns ?? []; return null },
    groupInput: (): ConversationGroupInput<ConversationViewNode> => ({
      kind: 'replace', order: [], timeline,
      readNode: () => undefined, readTurn: () => [], readPosition: () => undefined,
    }),
    publish: () => { order.push('publish') },
  }
  views.register({ target: 'chat', create: () => native })
  for (const id of ['first', 'second']) views.decorate('chat', id, original => ({
    empty: original.empty,
    replace: input => original.replace(input),
    apply: input => original.apply(input),
    groupInput: () => original.groupInput!(),
    publish: () => { original.publish!() },
  }))
  const group: ConversationGroupDefinition = {
    kind: 'empty-group', target: 'chat', create: () => null,
    update: () => { order.push('group'); return null },
    buildGroups: () => ({ entries: [], groups: { kind: 'replace', snapshots: [] } }),
  }
  const assembler = new ConversationNodeAssembler(
    { entries: () => [], fallbackEntry: () => undefined }, views,
    { entries: () => [group], forTarget: () => group },
  )
  const start: SessionEvent<'turn/start'> = { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } }
  assembler.replaceWindow([{ type: 'event', event: start }], false)
  assembler.activateTarget('chat')
  expect(order).toEqual(['group', 'publish'])
  order.length = 0
  const end: SessionEvent<'turn/end'> = { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } }
  assembler.append({ type: 'event', event: end })
  assembler.flush()
  expect(changedTurns).toEqual([1])
  expect(order).toEqual(['group', 'publish'])
})
