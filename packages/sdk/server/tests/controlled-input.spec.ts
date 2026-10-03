import { Context } from '@deepseek-ai/cordis'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessSdkJsonRpcServer } from '../src/index.ts'

class ReceiptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const transport: JsonRpcTransportPeer = {
  request: () => Promise.reject(new Error('unexpected host request')),
  notify: () => {},
}

describe('SDK controlled prompt receipts', () => {
  let ctx: Context | undefined
  let server: HarnessSdkJsonRpcServer | undefined

  afterEach(async () => {
    await server?.shutdown()
    await ctx?.fiber.dispose()
    server = undefined
    ctx = undefined
    vi.restoreAllMocks()
  })

  async function boot(admission: 'accept' | 'hold' | 'reject' = 'accept') {
    const owner = ctx = new Context()
    await mountAgentLoopTestDependencies(owner)
    await mountAgentLoopTestHarness(owner)
    const adapter = new ReceiptAdapter()
    owner.llm.registerAdapter(['receipt'], adapter)
    owner.on('session/flush', () => {})
    const controller = owner.agents.registerInputController(InputControllerId('sdk-receipt'), {
      admit: () => admission === 'reject' ? { kind: 'reject', reason: 'SDK custody denied' } : { kind: admission },
      canStart: () => true, canClaim: () => true,
      initialize: (session) => { controller.bind(session) },
    })
    const sdk = server = new HarnessSdkJsonRpcServer(owner, transport)
    await sdk.initialize({ cwd: process.cwd(), provider: 'receipt', model: 'receipt' })
    return { owner, adapter, controller, sdk }
  }

  it('returns the identified message only after persistence acknowledges controlled custody', async () => {
    const test = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = test.owner.sessions.flush.bind(test.owner.sessions)
    vi.spyOn(test.owner.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return flush(session)
    })
    let settled = false
    const prompt = test.sdk.prompt({ sessionId: 'controlled', contentBlocks: [{ type: 'text', text: 'SDK prompt' }] })
      .finally(() => { settled = true })
    try {
      await entered.promise
      expect(settled).toBe(false)
      expect(test.adapter.requests).toEqual([])
      const agent = test.owner.agents.get(SessionId('controlled'))!
      const queued = agent.inbox.nextTurn[0]!
      release.resolve(undefined)
      await expect(prompt).resolves.toEqual({ messageId: queued.id })
      await agent.whenIdle()
      expect(test.adapter.requests).toHaveLength(1)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message'))
        .toEqual([expect.objectContaining({ data: queued })])
    } finally {
      release.resolve(undefined)
      await prompt.catch(() => undefined)
    }
  })

  it('acknowledges held custody without treating it as model completion', async () => {
    const test = await boot('hold')
    const result = await test.sdk.prompt({ sessionId: 'held', contentBlocks: [{ type: 'text', text: 'hold prompt' }] })
    const agent = test.owner.agents.get(SessionId('held'))!
    expect(test.owner.agents.inputControlState(agent.session).records[0]).toMatchObject({
      location: 'held', input: { message: { id: result.messageId }, target: 'next-turn', wakeup: true },
    })
    expect(agent.inbox.nextTurn).toEqual([])
    expect(test.adapter.requests).toEqual([])
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })

  it('propagates custody rejection without returning a message receipt', async () => {
    const test = await boot('reject')
    await expect(test.sdk.prompt({ sessionId: 'denied', contentBlocks: [{ type: 'text', text: 'denied prompt' }] }))
      .rejects.toThrow('SDK custody denied')
    expect(test.owner.agents.get(SessionId('denied'))?.inbox.nextTurn).toEqual([])
    expect(test.adapter.requests).toEqual([])
  })

  it.each(['false', 'throw'] as const)('returns no receipt on uncertain persistence %s and retains pending custody', async (failure) => {
    const test = await boot()
    const flush = vi.spyOn(test.owner.sessions, 'flush')
    if (failure === 'false') flush.mockResolvedValueOnce(false)
    else flush.mockRejectedValueOnce(new Error('custody storage failed'))
    await expect(test.sdk.prompt({ sessionId: 'uncertain', contentBlocks: [{ type: 'text', text: 'uncertain prompt' }] }))
      .rejects.toThrow(failure === 'false' ? /not confirmed/ : 'custody storage failed')
    const agent = test.owner.agents.get(SessionId('uncertain'))!
    expect(test.adapter.requests).toEqual([])
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(test.owner.agents.canStartInput(agent)).toBe(false)
  })

  it('drains and rejects a pending receipt when shutdown disposes its Agent', async () => {
    const test = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = test.owner.sessions.flush.bind(test.owner.sessions)
    vi.spyOn(test.owner.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return flush(session)
    })
    const prompt = test.sdk.prompt({ sessionId: 'closing', contentBlocks: [{ type: 'text', text: 'shutdown prompt' }] })
    const rejected = expect(prompt).rejects.toThrow(/closed|unavailable/)
    try {
      await entered.promise
      const shutdown = test.sdk.shutdown()
      await vi.waitFor(() => { expect(test.owner.agents.canStartInput(test.owner.agents.list()[0]!)).toBe(false) })
      release.resolve(undefined)
      await Promise.all([shutdown, rejected])
      expect(test.owner.agents.get(SessionId('closing'))).toBeUndefined()
      expect(test.adapter.requests).toEqual([])
    } finally {
      release.resolve(undefined)
      await prompt.catch(() => undefined)
    }
  })
})
