import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { internals } from '../src/runner-internals.ts'

class ReceiptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'durable answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('headless controlled input receipts', () => {
  let ctx: Context | undefined
  let persistenceRoot: string | undefined
  const original = { ...internals }

  afterEach(async () => {
    await ctx?.fiber.dispose()
    if (persistenceRoot !== undefined) await rm(persistenceRoot, { recursive: true, force: true })
    ctx = undefined
    persistenceRoot = undefined
    Object.assign(internals, original)
    vi.restoreAllMocks()
  })

  async function boot(denied = false) {
    const owner = ctx = new Context()
    await mountAgentLoopTestDependencies(owner)
    persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-headless-custody-'))
    await owner.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
    await mountAgentLoopTestHarness(owner)
    await owner.plugin(AgentDefaultModel, { provider: 'receipt', model: 'receipt' })
    const adapter = new ReceiptAdapter()
    owner.llm.registerAdapter(['receipt'], adapter)
    const controller = owner.agents.registerInputController(InputControllerId('headless-receipt'), {
      admit: () => denied ? { kind: 'reject', reason: 'headless custody denied' } : { kind: 'accept' },
      canStart: () => true, canClaim: () => true,
      initialize: (session) => { controller.bind(session) },
    })
    let out = ''
    let err = ''
    internals.stdout = { write: (text) => { out += text } }
    internals.stderr = { write: (text) => { err += text } }
    const exited = Promise.withResolvers<number>()
    owner.provide('appExit', (code) => { exited.resolve(code) })
    return { owner, controller, adapter, exited: exited.promise, output: () => ({ out, err }) }
  }

  it('waits for custody before observing idle, output, and process exit', async () => {
    const test = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = test.owner.sessions.flush.bind(test.owner.sessions)
    vi.spyOn(test.owner.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return flush(session)
    })
    let exited = false
    void test.exited.then(() => { exited = true })
    apply(test.owner, { task: 'controlled task' })
    try {
      await entered.promise
      expect(exited).toBe(false)
      expect(test.output()).toEqual({ out: '', err: '' })
      expect(test.adapter.requests).toEqual([])
      const agent = test.owner.agents.list()[0]!
      expect(agent.inbox.nextTurn).toHaveLength(1)
      release.resolve(undefined)
      expect(await test.exited).toBe(0)
      expect(test.output()).toEqual({ out: 'durable answer\n', err: '' })
      expect(test.adapter.requests).toHaveLength(1)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
    } finally {
      release.resolve(undefined)
      await test.exited
    }
  })

  it('reports custody rejection as a failed run without producing a model turn', async () => {
    const test = await boot(true)
    apply(test.owner, { task: 'denied task' })
    expect(await test.exited).toBe(1)
    expect(test.output().err).toContain('headless custody denied')
    expect(test.output().out).toBe('')
    expect(test.adapter.requests).toEqual([])
    expect(test.owner.agents.list()[0]?.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })

  it.each(['false', 'throw'] as const)('fails the run on uncertain persistence %s without reporting an answer', async (failure) => {
    const test = await boot()
    const flush = vi.spyOn(test.owner.sessions, 'flush')
    if (failure === 'false') flush.mockResolvedValueOnce(false)
    else flush.mockRejectedValueOnce(new Error('custody storage failed'))
    apply(test.owner, { task: 'uncertain task' })
    expect(await test.exited).toBe(1)
    expect(test.output().err).toMatch(failure === 'false' ? /not confirmed/ : /custody storage failed/)
    expect(test.output().out).toBe('')
    expect(test.adapter.requests).toEqual([])
    const agent = test.owner.agents.list()[0]!
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(test.owner.agents.canStartInput(agent)).toBe(false)
  })

  it('fails a run whose custody controller closes during persistence', async () => {
    const test = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = test.owner.sessions.flush.bind(test.owner.sessions)
    vi.spyOn(test.owner.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return flush(session)
    })
    apply(test.owner, { task: 'controller closes' })
    try {
      await entered.promise
      const disposal = test.controller.dispose()
      release.resolve(undefined)
      expect(await test.exited).toBe(1)
      await disposal
      expect(test.output().err).toContain('closed')
      expect(test.output().out).toBe('')
      expect(test.adapter.requests).toEqual([])
    } finally {
      release.resolve(undefined)
      await test.exited
    }
  })
})
