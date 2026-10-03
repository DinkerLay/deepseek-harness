import { Context } from '@deepseek-ai/cordis'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebhookDeliveryId, WebhookRuleId, WebhookSourceId } from '../src/index.ts'
import { createWebhookSession } from '../src/session.ts'

describe('webhook controlled input receipts', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    vi.restoreAllMocks()
  })

  async function boot(denied = false) {
    const owner = ctx = new Context()
    await mountAgentLoopTestDependencies(owner)
    await mountAgentLoopTestHarness(owner)
    await owner.plugin(AgentDefaultModel, { provider: 'fixture', model: 'fixture' })
    const controller = owner.agents.registerInputController(InputControllerId('webhook-receipt'), {
      admit: () => denied ? { kind: 'reject', reason: 'webhook custody denied' } : { kind: 'accept' },
      canStart: () => false, canClaim: () => false,
      initialize: (session) => { controller.bind(session) },
    })
    owner.on('session/flush', () => {})
    const attached = new Set<SessionId>()
    const detach = vi.fn(async (id: SessionId) => { attached.delete(id) })
    owner.provide('workspaceRegistry', { list: () => [{ path: process.cwd(), sessionIds: [...attached] }],
      create: async () => ({ path: process.cwd(),
        attachSession: async (id: SessionId) => { attached.add(id) }, detachSession: detach,
      }) } as never)
    owner.provide('agentPresets', {
      resolve: async () => ({ id: 'fixture-preset' }),
      acquireScope: async () => ({ [Symbol.asyncDispose]: async () => {} }),
      mount: async () => {},
    } as never)
    owner.provide('permissionPresets', { resolve: () => ({}), set: () => {} } as never)
    owner.provide('sessionTitle', { rename: () => {} } as never)
    const create = () => createWebhookSession(owner, {
      kind: 'fixture', source: WebhookSourceId('source'), deliveryId: WebhookDeliveryId('delivery'),
      event: {}, receivedAt: 1,
    }, WebhookRuleId('receipt-rule'), {
      workspacePath: process.cwd(), title: 'Webhook custody', prompt: 'Handle verified delivery',
      agentPreset: 'fixture-preset', permissionPreset: 'fixture-permission',
    }, new AbortController().signal)
    return { owner, controller, attached, detach, create }
  }

  it('retains Workspace ownership and waits for durable custody before completing creation', async () => {
    const test = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = test.owner.sessions.flush.bind(test.owner.sessions)
    vi.spyOn(test.owner.sessions, 'flush').mockImplementationOnce(async (session) => {
      expect(test.attached.has(session.id)).toBe(true)
      entered.resolve(undefined)
      await release.promise
      return flush(session)
    })
    let settled = false
    const creation = test.create().finally(() => { settled = true })
    try {
      await entered.promise
      expect(settled).toBe(false)
      const agent = test.owner.agents.list()[0]!
      const input = test.owner.agents.inputControlState(agent.session).records[0]!.input
      expect(input).toMatchObject({ target: 'next-turn', wakeup: true, message: { source: {
        kind: 'webhook', provider: 'fixture', source: 'source', deliveryId: 'delivery', ruleId: 'receipt-rule',
      } } })
      expect(agent.inbox.nextTurn).toEqual([input.message])
      release.resolve(undefined)
      await creation
      expect(test.attached).toEqual(new Set([agent.session.id]))
      expect(test.detach).not.toHaveBeenCalled()
      expect(test.owner.agents.get(agent.id)).toBe(agent)
      expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    } finally {
      release.resolve(undefined)
      await creation.catch(() => undefined)
    }
  })

  it('rolls back Workspace attachment and the real Agent after custody rejection', async () => {
    const test = await boot(true)
    await expect(test.create()).rejects.toThrow('webhook custody denied')
    expect(test.detach).toHaveBeenCalledTimes(1)
    expect(test.attached.size).toBe(0)
    expect(test.owner.agents.list()).toEqual([])
    expect(test.owner.sessions.get(test.detach.mock.calls[0]![0])).toBeUndefined()
  })

  it.each(['false', 'throw'] as const)('rolls back the new Workspace Session on uncertain persistence %s', async (failure) => {
    const test = await boot()
    const flush = vi.spyOn(test.owner.sessions, 'flush')
    if (failure === 'false') flush.mockResolvedValueOnce(false)
    else flush.mockRejectedValueOnce(new Error('custody storage failed'))
    await expect(test.create()).rejects.toThrow(failure === 'false' ? /not confirmed/ : 'custody storage failed')
    expect(test.detach).toHaveBeenCalledTimes(1)
    expect(test.attached.size).toBe(0)
    expect(test.owner.agents.list()).toEqual([])
  })

  it('rolls back a pending creation when its custody controller closes', async () => {
    const test = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = test.owner.sessions.flush.bind(test.owner.sessions)
    vi.spyOn(test.owner.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return flush(session)
    })
    const creation = test.create()
    const rejection = expect(creation).rejects.toThrow('closed')
    try {
      await entered.promise
      const disposal = test.controller.dispose()
      release.resolve(undefined)
      await Promise.all([disposal, rejection])
      expect(test.detach).toHaveBeenCalledTimes(1)
      expect(test.attached.size).toBe(0)
      expect(test.owner.agents.list()).toEqual([])
    } finally {
      release.resolve(undefined)
      await creation.catch(() => undefined)
    }
  })
})
