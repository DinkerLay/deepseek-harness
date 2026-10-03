import { Context } from '@deepseek-ai/cordis'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createSessionTestController, createSessionTestRemote } from './test-remote.ts'
import type { SessionRequestId } from '../src/types.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const defaults = {
    cwd: '/workspace', defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
  }
  const controller = createSessionTestController(ctx, defaults)
  const handle = await ctx.agents.create({ sessionId: SessionId('controlled-rpc'),
    meta: { cwd: '/workspace' }, agentOptions: { provider: 'mock', model: 'mock' } })
  const admission = { hold: false, start: false }
  const cap = ctx.agents.registerInputController(InputControllerId('rpc-receipts'), {
    admit: () => ({ kind: admission.hold ? 'hold' : 'accept' }),
    canStart: () => admission.start, canClaim: () => admission.start,
  })
  cap.bind(handle.agent.session)
  ctx.on('session/flush', async () => {})
  return { ctx, controller, remote: createSessionTestRemote(ctx, defaults), agent: handle.agent, adapter, admission, cap }
}

function prompt(requestId = 'controlled-request') {
  return { sessionId: SessionId('controlled-rpc'), requestId: requestId as SessionRequestId,
    mode: 'queue' as const, content: [{ type: 'text' as const, text: 'queued RPC input' }] }
}

describe('controlled Session commands', () => {
  it.each(['false', 'throw'] as const)('retries a queue removal after flush %s and retires its RPC only after confirmation', async (failure) => {
    const test = await harness()
    await test.remote.prompt(prompt())
    const queued = test.agent.inbox.nextTurn[0]
    if (queued === undefined) throw new Error('RPC was not queued')
    const retire = vi.spyOn(test.ctx.fileUploads, 'retirePrompt')
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async () => {
      if (failure === 'throw') throw new Error('queue removal checkpoint unavailable')
      return false
    })
    const request = { sessionId: test.agent.id, itemId: queued.id, action: { kind: 'remove' as const } }
    try {
      expect(await test.remote.updateQueue(request)).toMatchObject({ ok: false })
      expect(test.agent.inbox.nextTurn).toEqual([])
      expect(retire).not.toHaveBeenCalled()
      flush.mockResolvedValueOnce(false)
      expect(await test.remote.updateQueue(request)).toMatchObject({ ok: false })
      expect(retire).not.toHaveBeenCalled()
      expect(await test.remote.updateQueue(request)).toMatchObject({ ok: true, value: { accepted: true } })
      expect(retire).toHaveBeenCalledOnce()
      expect(retire).toHaveBeenCalledWith(test.agent, prompt().requestId)
      expect(test.ctx.agents.canStartInput(test.agent)).toBe(false)
      test.admission.start = true
      expect(test.ctx.agents.canStartInput(test.agent)).toBe(true)
      expect(await test.remote.updateQueue(request)).toMatchObject({ ok: false, error: { code: 'session/queue-item-not-found' } })
      expect(test.agent.inbox.nextTurn).toEqual([])
      expect(test.adapter.requests).toHaveLength(0)
    } finally { flush.mockRestore(); retire.mockRestore() }
  })

  it.each(['user', 'runtime-context'] as const)('confirms removal of %s input without retiring an unrelated RPC', async (kind) => {
    const test = await harness()
    const message = createUserMessage({ content: [{ type: 'text', text: 'non-RPC pending input' }],
      source: kind === 'user' ? { kind: 'user' } : { kind: 'runtime-context' } })
    await test.ctx.agents.receiveInput(test.agent, { message, target: 'next-step', wakeup: false })
    const retire = vi.spyOn(test.ctx.fileUploads, 'retirePrompt')
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    const request = { sessionId: test.agent.id, itemId: message.id, action: { kind: 'remove' as const } }
    try {
      expect(await test.remote.updateQueue(request)).toMatchObject({ ok: false })
      expect(await test.remote.updateQueue(request)).toMatchObject({ ok: true })
      expect(retire).not.toHaveBeenCalled()
      expect(await test.remote.updateQueue({ ...request, itemId: createUserMessage({
        content: [{ type: 'text', text: 'never queued' }], source: { kind: 'user' },
      }).id })).toMatchObject({ ok: false, error: { code: 'session/queue-item-not-found' } })
    } finally { flush.mockRestore(); retire.mockRestore() }
  })

  it('owns cold activation preparer registration through the Session facade', async () => {
    const test = await harness()
    const dispose = test.controller.registerActivationPreparation('facade-preparation', () => undefined)
    expect(() => test.controller.registerActivationPreparation('facade-preparation', () => undefined))
      .toThrow(/already registered/)
    await dispose()
    const replacement = test.controller.registerActivationPreparation('facade-preparation', () => undefined)
    await replacement()
  })

  it('awaits durable custody and retries the same RPC without creating another input', async () => {
    const test = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return original(session)
    })
    let acknowledged = false
    const sending = test.remote.prompt(prompt()).then((value) => { acknowledged = true; return value })
    try {
      await entered.promise
      expect(acknowledged).toBe(false)
      expect(test.adapter.requests).toHaveLength(0)
      release.resolve(undefined)
      expect(await sending).toMatchObject({ ok: true, value: { accepted: true } })
      expect(await test.remote.prompt(prompt())).toMatchObject({ ok: true })
      expect(test.ctx.agents.inputControlState(test.agent.session).records).toHaveLength(1)
      expect(test.agent.inbox.nextTurn).toHaveLength(1)
    } finally { release.resolve(undefined); await sending; flush.mockRestore() }
  })

  it('retries a captured RPC with its original identity after an edit', async () => {
    const test = await harness()
    const pluginInput = createUserMessage({ content: [{ type: 'text', text: 'context' }], source: { kind: 'runtime-context' } })
    await test.ctx.agents.receiveInput(test.agent, { message: pluginInput, target: 'next-step', wakeup: false })
    await test.remote.prompt(prompt())
    const queued = test.agent.inbox.nextTurn[0]
    if (queued === undefined) throw new Error('RPC was not queued')
    await test.remote.updateQueue({ sessionId: test.agent.id, itemId: queued.id,
      action: { kind: 'edit', content: [{ type: 'text', text: 'edited RPC' }] } })
    await test.cap.holdPending(test.agent)
    expect(await test.remote.prompt(prompt())).toMatchObject({ ok: true })
    expect(test.ctx.agents.inputControlState(test.agent.session).records).toHaveLength(2)
    expect(test.ctx.agents.inputControlState(test.agent.session).records[1]?.input.message.content)
      .toEqual([{ type: 'text', text: 'edited RPC' }])
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('mutates controlled queue entries and retires only user RPC receipts on removal', async () => {
    const test = await harness()
    await test.remote.prompt(prompt())
    const queued = test.agent.inbox.nextTurn[0]
    if (queued === undefined) throw new Error('RPC was not queued')
    const retire = vi.spyOn(test.ctx.fileUploads, 'retirePrompt')
    expect(await test.remote.updateQueue({ sessionId: test.agent.id, itemId: queued.id, action: { kind: 'remove' } }))
      .toMatchObject({ ok: true })
    expect(retire).toHaveBeenCalledWith(test.agent, prompt().requestId)
    const plain = createUserMessage({ content: [{ type: 'text', text: 'ordinary input' }], source: { kind: 'user' } })
    await test.ctx.agents.receiveInput(test.agent, { message: plain, target: 'next-turn', wakeup: false })
    const plugin = createUserMessage({ content: [{ type: 'text', text: 'context' }], source: { kind: 'runtime-context' } })
    await test.ctx.agents.receiveInput(test.agent, { message: plugin, target: 'next-step', wakeup: false })
    for (const message of [plain, plugin]) {
      expect(await test.remote.updateQueue({ sessionId: test.agent.id, itemId: message.id, action: { kind: 'remove' } }))
        .toMatchObject({ ok: true })
    }
    expect(retire).toHaveBeenCalledOnce()
    expect(test.agent.inbox.nextTurn).toEqual([])
    expect(test.agent.inbox.nextStep).toEqual([])
    retire.mockRestore()
  })

  it('steers controlled queued input only while a current turn can accept it', async () => {
    const test = await harness()
    const held = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    test.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent === test.agent) { entered.resolve(undefined); await held.promise }
      return next()
    })
    test.admission.start = true
    try {
      await test.remote.prompt(prompt('running-request'))
      await entered.promise
      await test.remote.prompt(prompt('steered-request'))
      const queued = test.agent.inbox.nextTurn[0]
      if (queued === undefined) throw new Error('second RPC was not queued')
      expect(await test.remote.updateQueue({ sessionId: test.agent.id, itemId: queued.id, action: { kind: 'steer' } }))
        .toMatchObject({ ok: true })
      expect(test.agent.inbox.nextTurn).toEqual([])
      expect(test.agent.inbox.nextStep[0]?.id).toBe(queued.id)
    } finally { held.resolve(undefined); await test.agent.whenIdle() }
  })
})
