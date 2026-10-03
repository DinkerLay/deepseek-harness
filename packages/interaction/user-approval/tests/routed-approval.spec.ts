import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ApprovalService, { ApprovalAnswererRouteId, setApprovalPolicy } from '../src/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function setup(validity?: () => (() => boolean)) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService)
  const parent = await ctx.agentLoop.create(SessionId('approval-parent'), { provider: 'mock', model: 'mock' })
  const child = await ctx.agentLoop.create(SessionId('approval-child'), { provider: 'mock', model: 'mock' })
  setApprovalPolicy(child.session, 'never')
  const route = ApprovalAnswererRouteId('test-controlled')
  const remove = ctx.approval.registerAnswererRoute(route, (origin, question) => {
    const call = question?.callId === undefined ? undefined : origin.session.snapshotEvents().findLast(event =>
      event.type === 'tool/call' && event.data.callId === question.callId)
    return { agent: parent, displaySubject: 'worker', taskId: 'task-1',
      ...validity === undefined ? {} : { isValid: validity() },
      ...call?.type !== 'tool/call' ? {} : { operation: { name: call.data.name, arguments: call.data.arguments } } }
  })
  ctx.approval.bindAnswererRoute(child, route)
  const callId = ToolCallId('operation')
  child.session.append('turn/start', { turn: 1 })
  child.session.append('step/start', { turn: 1, step: 1 })
  child.session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"echo test"}' })
  return { ctx, parent, child, route, remove, callId }
}

function close(agent: Agent): void {
  agent.session.append('step/end', { turn: 1, step: 1 })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

describe('routed approval', () => {
  it.each(['false', 'throws'] as const)('rejects new requests and policy lookup when captured route validity is %s', async (kind) => {
    const { ctx, child, callId } = await setup(() => () => {
      if (kind === 'throws') throw new Error('route validity lookup failed')
      return false
    })
    let asked = 0
    ctx.on('approval/request', async () => { asked += 1; return 'allowed-once' })
    expect(ctx.approval.effectivePolicy(child)).toBe('never')
    expect(ctx.approval.answererOf(child)).toBeUndefined()
    expect(await ctx.approval.request({ agent: child, toolName: 'bash', callId })).toBe('rejected')
    expect(asked).toBe(0)
    expect(child.session.snapshotEvents().filter(event => event.type === 'approval/decided')
      .map(event => event.data.outcome)).toEqual(['rejected'])
    close(child)
  })

  it.each(['term', 'frozen', 'throws'] as const)('rejects a late grant when the captured route becomes %s', async (change) => {
    const state = { term: 1, ready: true, failed: false }
    const { ctx, parent, child, callId } = await setup(() => {
      const term = state.term
      return () => {
        if (state.failed) throw new Error('route validity lookup failed')
        return state.ready && state.term === term
      }
    })
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<'allowed-once'>()
    let requests = 0
    ctx.on('approval/request', async (req) => {
      requests += 1
      expect(req.agent).toBe(parent)
      entered.resolve(undefined)
      return requests === 1 ? answer.promise : 'allowed-once'
    })
    const waiting = ctx.approval.request({ agent: child, toolName: 'bash', callId })
    try {
      await entered.promise
      if (change === 'term') state.term += 1
      else if (change === 'frozen') state.ready = false
      else state.failed = true
      answer.resolve('allowed-once')
      expect(await waiting).toBe('rejected')
      expect(child.session.snapshotEvents().filter(event => event.type === 'approval/decided')
        .map(event => event.data.outcome)).toEqual(['rejected'])
      state.ready = true
      state.failed = false
      expect(await ctx.approval.request({ agent: child, toolName: 'bash', callId })).toBe('allowed-once')
      expect(requests).toBe(2)
    } finally {
      answer.resolve('allowed-once')
      await waiting
      close(child)
    }
  })

  it('does not invalidate an already-presented question solely because the answerer changes permission policy', async () => {
    const state = { term: 1, ready: true }
    const { ctx, parent, child, callId } = await setup(() => {
      const term = state.term
      return () => state.ready && state.term === term
    })
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<'allowed-once'>()
    ctx.on('approval/request', async () => { entered.resolve(undefined); return answer.promise })
    const waiting = ctx.approval.request({ agent: child, toolName: 'bash', callId })
    try {
      await entered.promise
      setApprovalPolicy(parent.session, 'never')
      expect(ctx.approval.answererOf(child)).toBe(parent)
      expect(ctx.approval.effectivePolicy(child)).toBe('never')
      answer.resolve('allowed-once')
      expect(await waiting).toBe('allowed-once')
      expect(await ctx.approval.request({ agent: child, toolName: 'bash', callId })).toBe('rejected')
    } finally {
      answer.resolve('allowed-once')
      await waiting
      close(child)
    }
  })

  it('retains a late explicit rejection when route ownership was invalidated', async () => {
    let valid = true
    const { ctx, child, callId } = await setup(() => () => valid)
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<'rejected'>()
    ctx.on('approval/request', async () => { entered.resolve(undefined); return answer.promise })
    const waiting = ctx.approval.request({ agent: child, toolName: 'bash', callId })
    await entered.promise
    valid = false
    answer.resolve('rejected')
    expect(await waiting).toBe('rejected')
    close(child)
  })

  it('rejects duplicate or unavailable route registrations and preserves the original binding', async () => {
    const { ctx, parent, child, route } = await setup()
    expect(() => ctx.approval.registerAnswererRoute(route, () => ({ agent: parent, displaySubject: 'duplicate' })))
      .toThrow(/already registered/)
    expect(() => { ctx.approval.bindAnswererRoute(child, ApprovalAnswererRouteId('missing')) }).toThrow(/unavailable/)
    const second = ApprovalAnswererRouteId('another-route')
    ctx.approval.registerAnswererRoute(second, () => ({ agent: parent, displaySubject: 'another' }))
    expect(() => { ctx.approval.bindAnswererRoute(child, second) }).toThrow(/already bound/)
    expect(ctx.approval.routeOf(child)).toBe(route)
    expect(ctx.approval.answererOf(child)).toBe(parent)
    expect(ctx.approval.answererOf(parent)).toBeUndefined()
    expect(ctx.approval.effectivePolicy(parent)).toBe('ask')
    close(child)
  })

  it.each(['missing', 'self', 'stale', 'throws', 'unregistered'] as const)
  ('rejects an operation when its answerer is %s', async (kind) => {
    const { ctx, child, route, remove, callId } = await setup()
    await remove()
    if (kind === 'stale') {
      const held = await ctx.agents.create({ sessionId: SessionId('retired-answerer'),
        agentOptions: { provider: 'mock', model: 'mock' } })
      const stale = held.agent
      await held.dispose()
      ctx.approval.registerAnswererRoute(route, () => ({ agent: stale, displaySubject: 'stale' }))
    } else if (kind !== 'unregistered') {
      ctx.approval.registerAnswererRoute(route, () => {
        if (kind === 'throws') throw new Error('answerer lookup failed')
        return kind === 'missing' ? undefined : { agent: child, displaySubject: 'self' }
      })
    }
    let questions = 0
    ctx.on('approval/request', async () => { questions += 1; return 'allowed-once' })
    expect(ctx.approval.answererOf(child)).toBeUndefined()
    expect(ctx.approval.effectivePolicy(child)).toBe('never')
    expect(await ctx.approval.request({ agent: child, toolName: 'bash', callId })).toBe('rejected')
    expect(questions).toBe(0)
    close(child)
  })

  it('forwards an operation without inventing a Task or call identity', async () => {
    const { ctx, parent, child, route, remove } = await setup()
    await remove()
    ctx.approval.registerAnswererRoute(route, () => ({ agent: parent, displaySubject: 'worker' }))
    ctx.on('approval/request', async (req) => {
      expect(req.originSessionId).toBe(child.id)
      expect(req.originCallId).toBeUndefined()
      expect(req.taskId).toBeUndefined()
      expect(req.signal).toBeInstanceOf(AbortSignal)
      return 'rejected'
    })
    expect(await ctx.approval.request({ agent: child, toolName: 'unrecorded' })).toBe('rejected')
    close(child)
  })

  it('does not present an already-cancelled routed question', async () => {
    const { ctx, child, callId } = await setup()
    let questions = 0
    ctx.on('approval/request', async () => { questions += 1; return 'allowed-once' })
    expect(await ctx.approval.request({ agent: child, toolName: 'bash', callId,
      signal: AbortSignal.abort(new Error('operation cancelled before question')) })).toBe('cancelled')
    expect(questions).toBe(0)
    close(child)
  })

  it('keeps an already-presented question pending when the answerer changes to never', async () => {
    const { ctx, parent, child, callId } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<'allowed-once'>()
    ctx.on('approval/request', async () => { entered.resolve(undefined); return answer.promise })
    const waiting = ctx.approval.request({ agent: child, toolName: 'bash', callId })
    await entered.promise
    setApprovalPolicy(parent.session, 'never')
    expect(ctx.approval.effectivePolicy(child)).toBe('never')
    answer.resolve('allowed-once')
    expect(await waiting).toBe('allowed-once')
    expect(await ctx.approval.request({ agent: child, toolName: 'bash', callId })).toBe('rejected')
    close(child)
  })

  it('cancels the originating question without accepting a late human response', async () => {
    const { ctx, child, callId } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<'allowed-once'>()
    const controller = new AbortController()
    ctx.on('approval/request', async () => { entered.resolve(undefined); return answer.promise })
    const waiting = ctx.approval.request({ agent: child, toolName: 'bash', callId, signal: controller.signal })
    await entered.promise
    controller.abort()
    expect(await waiting).toBe('cancelled')
    answer.resolve('allowed-once')
    expect(child.session.snapshotEvents().filter(event => event.type === 'approval/decided')
      .map(event => event.data.outcome)).toEqual(['cancelled'])
    close(child)
  })

  it('uses the current answerer policy and audits only the originating operation', async () => {
    const { ctx, parent, child, route, callId } = await setup()
    let requests = 0
    ctx.on('approval/request', async (req) => {
      requests += 1
      expect(req.agent).toBe(parent)
      expect(req.originSessionId).toBe(child.id)
      expect(req.displaySubject).toBe('worker')
      expect(req.taskId).toBe('task-1')
      expect(req.originOperation).toEqual({ name: 'bash', arguments: '{"command":"echo test"}' })
      return 'allowed-once'
    })
    expect(ctx.approval.effectivePolicy(child)).toBe('ask')
    expect(ctx.approval.overrideOf(child.session)).toBe('never')
    expect(await ctx.approval.request({ agent: child, toolName: 'bash', callId })).toBe('allowed-once')
    setApprovalPolicy(parent.session, 'never')
    expect(ctx.approval.effectivePolicy(child)).toBe('never')
    expect(await ctx.approval.request({ agent: child, toolName: 'bash', callId })).toBe('rejected')
    expect(requests).toBe(1)
    ctx.approval.bindAnswererRoute(child, route)
    expect(child.session.snapshotEvents().filter(event => event.type === 'approval/answerer-route')).toHaveLength(1)
    expect(parent.session.snapshotEvents().filter(event => event.type === 'approval/asked' || event.type === 'approval/decided')).toEqual([])
    expect(child.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome))
      .toEqual(['allowed-once', 'rejected'])
    close(child)
  })

  it('withdraws a pending question on route disposal and ignores a late grant', async () => {
    const { ctx, child, remove, callId } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<'allowed-once'>()
    ctx.on('approval/request', async () => { entered.resolve(undefined); return answer.promise })
    const waiting = ctx.approval.request({ agent: child, toolName: 'bash', callId })
    await entered.promise
    await remove()
    expect(await waiting).toBe('cancelled')
    answer.resolve('allowed-once')
    expect(ctx.approval.effectivePolicy(child)).toBe('never')
    close(child)
  })

  it('does not grant a routed operation missing its original call details', async () => {
    const { ctx, child } = await setup()
    ctx.on('approval/request', async (req) => {
      expect(req.originOperation).toBeUndefined()
      return 'allowed-once'
    })
    expect(await ctx.approval.request({ agent: child, toolName: 'unrecorded' })).toBe('rejected')
    close(child)
  })
})
