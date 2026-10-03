import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

describe('ACP controlled prompt receipts', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
    vi.restoreAllMocks()
  })

  async function session() {
    harness = await makeBridgeHarness({ script: [textResponse('acknowledged')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    return { bridge: harness, agent, sessionId }
  }

  it('waits for durable custody before running the prompt and returning its stop reason', async () => {
    const { bridge, agent, sessionId } = await session()
    const controller = bridge.ctx.agents.registerInputController(InputControllerId('acp-receipt'), {
      admit: () => ({ kind: 'accept' }), canStart: () => true, canClaim: () => true,
    })
    controller.bind(agent.session)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = bridge.ctx.sessions.flush.bind(bridge.ctx.sessions)
    vi.spyOn(bridge.ctx.sessions, 'flush').mockImplementationOnce(async (owner) => {
      expect(owner).toBe(agent.session)
      entered.resolve(undefined)
      await release.promise
      return flush(owner)
    })
    let settled = false
    const prompt = bridge.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'controlled prompt' }] })
      .finally(() => { settled = true })
    try {
      await entered.promise
      expect(settled).toBe(false)
      expect(bridge.adapter.requests).toEqual([])
      expect(agent.inbox.nextTurn).toHaveLength(1)
      expect(bridge.ctx.agents.inputControlState(agent.session).records[0]?.input).toMatchObject({
        target: 'next-turn', wakeup: true, message: { source: { kind: 'user' } },
      })
      release.resolve(undefined)
      await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' })
      expect(bridge.adapter.requests).toHaveLength(1)
      const users = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
      expect(users).toHaveLength(1)
      expect(users[0]?.data).toMatchObject({ content: [{ type: 'text', text: 'controlled prompt' }] })
    } finally {
      release.resolve(undefined)
      await prompt.catch(() => undefined)
    }
  })

  it('rejects denied custody and admits a later prompt without retaining the failed route', async () => {
    const { bridge, agent, sessionId } = await session()
    let denied = true
    const controller = bridge.ctx.agents.registerInputController(InputControllerId('acp-denial'), {
      admit: () => denied ? { kind: 'reject', reason: 'prompt custody denied' } : { kind: 'accept' },
      canStart: () => true, canClaim: () => true,
    })
    controller.bind(agent.session)
    await expect(bridge.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'denied prompt' }] }))
      .rejects.toThrow('prompt custody denied')
    expect(agent.inbox.nextTurn).toEqual([])
    expect(bridge.adapter.requests).toEqual([])
    expect(bridge.ctx.agents.inputControlState(agent.session).records).toEqual([])
    denied = false
    await expect(bridge.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'later prompt' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
  })

  it.each(['false', 'throw'] as const)('rejects uncertain custody when persistence returns %s without starting a turn', async (failure) => {
    const { bridge, agent, sessionId } = await session()
    const controller = bridge.ctx.agents.registerInputController(InputControllerId('acp-uncertain'), {
      admit: () => ({ kind: 'accept' }), canStart: () => true, canClaim: () => true,
    })
    controller.bind(agent.session)
    const flush = vi.spyOn(bridge.ctx.sessions, 'flush')
    if (failure === 'false') flush.mockResolvedValueOnce(false)
    else flush.mockRejectedValueOnce(new Error('custody storage failed'))
    await expect(bridge.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'uncertain prompt' }] }))
      .rejects.toThrow(failure === 'false' ? /not confirmed/ : 'custody storage failed')
    expect(bridge.adapter.requests).toEqual([])
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(bridge.ctx.agents.canStartInput(agent)).toBe(false)
    expect(bridge.ctx.agents.inputControlState(agent.session).records).toHaveLength(1)
  })

  it('rejects a pending receipt when its controller closes without waking the Agent', async () => {
    const { bridge, agent, sessionId } = await session()
    const controller = bridge.ctx.agents.registerInputController(InputControllerId('acp-closing'), {
      admit: () => ({ kind: 'accept' }), canStart: () => true, canClaim: () => true,
    })
    controller.bind(agent.session)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = bridge.ctx.sessions.flush.bind(bridge.ctx.sessions)
    vi.spyOn(bridge.ctx.sessions, 'flush').mockImplementationOnce(async (owner) => {
      entered.resolve(undefined)
      await release.promise
      return flush(owner)
    })
    const prompt = bridge.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'owner closes' }] })
    const rejection = expect(prompt).rejects.toThrow('closed')
    try {
      await entered.promise
      const disposal = controller.dispose()
      release.resolve(undefined)
      await Promise.all([disposal, rejection])
      expect(bridge.adapter.requests).toEqual([])
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
      expect(agent.inbox.nextTurn).toHaveLength(1)
    } finally {
      release.resolve(undefined)
      await prompt.catch(() => undefined)
    }
  })
})
