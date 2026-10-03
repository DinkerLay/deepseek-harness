import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalRequestId } from '../src/index.ts'
import type { ApprovalOutcome } from '../src/index.ts'
import { rejectionHarness } from './rejection-harness.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

describe('Host pending approval rejection', () => {
  it('queries detached scoped identities and rejects only the exact originating routed request', async () => {
    const test = await rejectionHarness()
    test.open()
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    let presentation: AbortSignal | undefined
    test.ctx.on('approval/request', async (request) => {
      presentation = request.signal
      entered.resolve(undefined)
      return answer.promise
    })
    const waiting = test.ctx.approval.request({ agent: test.source.agent, toolName: 'sensitive_operation', callId: test.callId })
    await entered.promise
    const captured = test.ctx.approval.pendingRequests()[0]
    if (captured === undefined) throw new Error('routed question did not enter the pending view')
    expect(captured).toMatchObject({ originSessionId: test.source.agent.id, answererSessionId: test.answerer.agent.id,
      routeId: test.route, toolName: 'sensitive_operation', callId: test.callId })
    expect(test.source.agent.session.eventAt(captured.askedSeq)?.type).toBe('approval/asked')
    Object.assign(captured, { toolName: 'mutated detached view' })
    expect(test.ctx.approval.pendingRequests({ originSessionId: test.source.agent.id })[0]?.toolName).toBe('sensitive_operation')
    expect(test.ctx.approval.pendingRequests({ originSessionId: test.answerer.agent.id })).toEqual([])
    expect(test.ctx.approval.pendingRequests({ answererSessionId: test.answerer.agent.id, routeId: test.route })).toHaveLength(1)
    expect(test.ctx.approval.pendingRequests({ answererSessionId: test.source.agent.id })).toEqual([])
    expect(test.ctx.approval.pendingRequests({ routeId: test.route })).toHaveLength(1)
    expect(await test.ctx.approval.rejectPending(test.answerer.agent, captured.id)).toBe(false)
    expect(await test.ctx.approval.rejectPending(test.source.agent, ApprovalRequestId('unknown'))).toBe(false)
    expect(await test.ctx.approval.rejectPending(test.source.agent, captured.id)).toBe(true)
    expect(presentation?.aborted).toBe(true)
    expect(await waiting).toBe('rejected')
    answer.resolve('allowed-once')
    expect(test.ctx.approval.pendingRequests()).toEqual([])
    expect(test.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome))
      .toEqual(['rejected'])
    expect(test.answerer.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toEqual([])
    test.close()
    await test.ctx.sessions.flush(test.source.agent.session)
  })

  it.each(['false', 'throw'] as const)('does not report a %s flush as successful rejection and reconfirms without another audit', async (failure) => {
    const test = await rejectionHarness()
    test.open()
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    test.ctx.on('approval/request', async () => { entered.resolve(undefined); return answer.promise })
    const waiting = test.ctx.approval.request({ agent: test.source.agent, toolName: 'sensitive_operation', callId: test.callId })
    const failedRequest = expect(waiting).rejects.toThrow()
    await entered.promise
    const captured = test.ctx.approval.pendingRequests()[0]
    if (captured === undefined) throw new Error('routed question is absent')
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush')
    if (failure === 'false') checkpoint.mockResolvedValueOnce(false)
    else checkpoint.mockRejectedValueOnce(new Error('rejection checkpoint observer failed'))
    await expect(test.ctx.approval.rejectPending(test.source.agent, captured.id)).rejects.toThrow()
    await failedRequest
    answer.resolve('allowed-once')
    expect(await test.ctx.approval.rejectPending(test.source.agent, captured.id)).toBe(true)
    expect(test.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toHaveLength(1)
    expect(test.ctx.approval.pendingRequests()).toEqual([])
    checkpoint.mockRestore()
    test.close()
  })

  it('shares concurrent rejection confirmation while the original durable checkpoint is blocked', async () => {
    const test = await rejectionHarness()
    test.open()
    const asked = Promise.withResolvers<undefined>()
    test.ctx.on('approval/request', async () => { asked.resolve(undefined); return await new Promise<ApprovalOutcome>(() => {}) })
    const waiting = test.ctx.approval.request({ agent: test.source.agent, toolName: 'sensitive_operation', callId: test.callId })
    await asked.promise
    const captured = test.ctx.approval.pendingRequests()[0]
    if (captured === undefined) throw new Error('routed question is absent')
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const flush = test.ctx.sessions.flush.bind(test.ctx.sessions)
    let checkpoints = 0
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      checkpoints += 1
      entered.resolve(undefined)
      await finish.promise
      return await flush(session)
    })
    const first = test.ctx.approval.rejectPending(test.source.agent, captured.id)
    await entered.promise
    const second = test.ctx.approval.rejectPending(test.source.agent, captured.id)
    expect(test.ctx.approval.pendingRequests()).toEqual([])
    finish.resolve(undefined)
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(await waiting).toBe('rejected')
    expect(checkpoints).toBe(1)
    checkpoint.mockRestore()
    test.close()
  })

  it.each(['cancelled', 'unavailable', 'allowed-once'] as const)('turns a frozen captured route with underlying %s into explicit rejection', async (outcome) => {
    const test = await rejectionHarness()
    test.open()
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    const origin = new AbortController()
    test.ctx.on('approval/request', async () => { entered.resolve(undefined); return answer.promise })
    const waiting = test.ctx.approval.request({ agent: test.source.agent, toolName: 'sensitive_operation',
      callId: test.callId, signal: origin.signal })
    await entered.promise
    test.status.valid = false
    if (outcome === 'cancelled') origin.abort(new Error('original operation closed after freeze'))
    else answer.resolve(outcome)
    expect(await waiting).toBe('rejected')
    answer.resolve('allowed-once')
    expect(test.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome))
      .toEqual(['rejected'])
    test.close()
  })

  it('keeps a valid routed origin abort cancelled and refuses to overwrite its terminal decision', async () => {
    const test = await rejectionHarness()
    test.open()
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    const origin = new AbortController()
    test.ctx.on('approval/request', async () => { entered.resolve(undefined); return answer.promise })
    const waiting = test.ctx.approval.request({ agent: test.source.agent, toolName: 'sensitive_operation',
      callId: test.callId, signal: origin.signal })
    await entered.promise
    const captured = test.ctx.approval.pendingRequests()[0]
    if (captured === undefined) throw new Error('routed question is absent')
    origin.abort()
    expect(await waiting).toBe('cancelled')
    expect(await test.ctx.approval.rejectPending(test.source.agent, captured.id)).toBe(false)
    answer.resolve('allowed-once')
    test.close()
    expect(await test.ctx.approval.rejectInterrupted(test.source.agent.session, captured)).toBe(false)
    expect(test.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome))
      .toEqual(['cancelled'])
  })

  it('does not change an unrouted borrowed question or make it Host-rejectable', async () => {
    const test = await rejectionHarness()
    const agent = await test.ctx.agents.create({ sessionId: SessionId('ordinary-approval'), agentOptions: { provider: 'mock', model: 'mock' } })
    agent.agent.session.append('turn/start', { turn: 1 })
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    const signal = new AbortController().signal
    const request = { agent: agent.agent, toolName: 'ordinary', signal }
    test.ctx.on('approval/request', async (forwarded) => { expect(forwarded).toBe(request); entered.resolve(undefined); return answer.promise })
    const waiting = test.ctx.approval.request(request)
    await entered.promise
    const captured = test.ctx.approval.pendingRequests()[0]
    if (captured === undefined) throw new Error('ordinary question is absent')
    expect(captured.routeId).toBeUndefined()
    expect(await test.ctx.approval.rejectPending(agent.agent, captured.id)).toBe(false)
    answer.resolve('allowed-once')
    expect(await waiting).toBe('allowed-once')
    agent.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await agent.dispose()
  })

  it('rejects before a queued presentation starts when its captured route froze in that dispatch gap', async () => {
    const test = await rejectionHarness()
    test.open()
    const answerer = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once')
    test.ctx.on('approval/request', answerer)
    const waiting = test.ctx.approval.request({ agent: test.source.agent, toolName: 'sensitive_operation', callId: test.callId })
    test.status.valid = false
    expect(await waiting).toBe('rejected')
    expect(answerer).not.toHaveBeenCalled()
    test.close()
  })

  it('runs a real Loader/tool/model turn with a rejected audit before UI withdrawal and no permitted side effect', async () => {
    const test = await rejectionHarness({ script: [toolCallResponse('actual-approval-call', 'sensitive_operation', {}), textResponse('operation denied')] })
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    let effects = 0
    test.ctx.tools.register(defineTool({ name: 'sensitive_operation', description: 'fixture approval-gated action',
      parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, exec) {
        if (exec.agent === undefined) throw new Error('fixture tool requires its real Agent')
        const outcome = await test.ctx.approval.request({ agent: exec.agent, toolName: 'sensitive_operation', callId: exec.callId, signal: exec.signal })
        if (outcome === 'allowed-once') effects += 1
        return outcome
      } }))
    test.ctx.on('approval/request', async (request) => {
      request.signal?.addEventListener('abort', () => {
        expect(test.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').at(-1)?.data.outcome)
          .toBe('rejected')
      }, { once: true })
      entered.resolve(undefined)
      return answer.promise
    })
    await test.ctx.agents.sendInput(test.source.agent, { message: createUserMessage({ content: [{ type: 'text', text: 'attempt the gated action' }],
      source: { kind: 'user' } }), target: 'next-turn', wakeup: true })
    await entered.promise
    const captured = test.ctx.approval.pendingRequests()[0]
    if (captured === undefined) throw new Error('real tool question is absent')
    expect(test.source.agent.status).toBe('running')
    expect(await test.ctx.approval.rejectPending(test.source.agent, captured.id)).toBe(true)
    await test.source.agent.whenIdle()
    answer.resolve('allowed-once')
    expect(effects).toBe(0)
    expect(test.adapter.requests).toHaveLength(2)
    expect(test.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome)).toEqual(['rejected'])
    expect(test.ctx.approval.pendingRequests()).toEqual([])
  })

  it.each(['success', 'false'] as const)('settles a still-present routed question after actual turn cancellation with %s durability', async (failure) => {
    const test = await rejectionHarness({ script: ['hang'] })
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    const completion = Promise.withResolvers<unknown>()
    let effects = 0
    let presentation: AbortSignal | undefined
    test.ctx.on('agent/request', ({ agent }, next) => {
      // An external hook owns this question independently of the model's
      // cancellation. It performs no action until its separate question settles.
      const waiting = test.ctx.approval.request({ agent, toolName: 'external-hook-operation' })
      void waiting.then((outcome) => {
        if (outcome === 'allowed-once') effects += 1
        completion.resolve(outcome)
      }, (error: unknown) => { completion.resolve(error) })
      return next()
    })
    test.ctx.on('approval/request', async (request) => { presentation = request.signal; entered.resolve(undefined); return answer.promise })
    await test.ctx.agents.sendInput(test.source.agent, { message: createUserMessage({ content: [{ type: 'text', text: 'start the legacy gated action' }],
      source: { kind: 'user' } }), target: 'next-turn', wakeup: true })
    await entered.promise
    await expect.poll(() => test.adapter.requests.length).toBe(1)
    const captured = test.ctx.approval.pendingRequests()[0]
    if (captured === undefined) throw new Error('legacy consumer did not expose its pending question')
    test.source.agent.cancel({ kind: 'user' })
    await test.source.agent.whenIdle()
    expect(presentation?.aborted).toBe(false)
    expect(test.ctx.approval.pendingRequests()).toHaveLength(1)
    expect(await test.ctx.approval.rejectInterrupted(test.source.agent.session, captured)).toBe(false)
    expect(test.source.agent.session.snapshotEvents().at(-1)?.type).toBe('turn/end')
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush')
    if (failure === 'false') {
      checkpoint.mockResolvedValueOnce(false)
      await expect(test.ctx.approval.rejectPending(test.source.agent, captured.id)).rejects.toThrow(/durability/)
      expect(await completion.promise).toBeInstanceOf(Error)
    }
    expect(await test.ctx.approval.rejectPending(test.source.agent, captured.id)).toBe(true)
    if (failure === 'success') expect(await completion.promise).toBe('rejected')
    answer.resolve('allowed-once')
    expect(presentation?.aborted).toBe(true)
    expect(effects).toBe(0)
    expect(test.adapter.requests).toHaveLength(1)
    expect(test.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toEqual([])
    expect(test.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/interrupted-rejected').map(event => event.data.id))
      .toEqual([captured.id])
    checkpoint.mockRestore()
  })

  it('refuses an old pending question while another turn is open before taking its terminal or withdrawing its card', async () => {
    const test = await rejectionHarness()
    test.open()
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    let presentation: AbortSignal | undefined
    test.ctx.on('approval/request', async (request) => { presentation = request.signal; entered.resolve(undefined); return answer.promise })
    const waiting = test.ctx.approval.request({ agent: test.source.agent, toolName: 'sensitive_operation', callId: test.callId })
    await entered.promise
    const captured = test.ctx.approval.pendingRequests()[0]
    if (captured === undefined) throw new Error('original question is not pending')
    test.close()
    test.source.agent.session.append('turn/start', { turn: 2 })
    await expect(test.ctx.approval.rejectPending(test.source.agent, captured.id)).rejects.toThrow(/another turn.*not claimed/)
    expect(presentation?.aborted).toBe(false)
    expect(test.ctx.approval.pendingRequests()).toHaveLength(1)
    expect(test.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/interrupted-rejected')).toEqual([])
    test.source.agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(await test.ctx.approval.rejectPending(test.source.agent, captured.id)).toBe(true)
    expect(await waiting).toBe('rejected')
    answer.resolve('allowed-once')
  })

  it('does not replace a normal terminal during its post-commit publication window', async () => {
    const test = await rejectionHarness()
    test.open()
    let observed: Promise<boolean> | undefined
    test.ctx.on('session/event', (session, event) => {
      if (session === test.source.agent.session && event.type === 'approval/decided') {
        observed = test.ctx.approval.rejectPending(test.source.agent, event.data.id)
      }
    })
    test.ctx.on('approval/request', async () => 'rejected')
    expect(await test.ctx.approval.request({ agent: test.source.agent, toolName: 'sensitive_operation' })).toBe('rejected')
    expect(await observed).toBe(false)
    expect(test.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toHaveLength(1)
    test.close()
  })

  it('does not overwrite an independently committed terminal while the UI request still waits', async () => {
    const test = await rejectionHarness()
    test.open()
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    test.ctx.on('approval/request', async () => { entered.resolve(undefined); return answer.promise })
    const waiting = test.ctx.approval.request({ agent: test.source.agent, toolName: 'sensitive_operation' })
    const failed = expect(waiting).rejects.toThrow(/no matching approval\/asked/)
    await entered.promise
    const captured = test.ctx.approval.pendingRequests()[0]
    if (captured === undefined) throw new Error('original question is absent')
    test.source.agent.session.append('approval/decided', { id: captured.id, outcome: 'rejected' })
    expect(await test.ctx.approval.rejectPending(test.source.agent, captured.id)).toBe(false)
    answer.resolve('rejected')
    await failed
    expect(test.source.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toHaveLength(1)
    test.close()
  })

  it('retains an unanswered request after a pre-commit audit veto and retries before withdrawing its card', async () => {
    const test = await rejectionHarness()
    test.open()
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    let presentation: AbortSignal | undefined
    test.ctx.on('approval/request', async (request) => { presentation = request.signal; entered.resolve(undefined); return answer.promise })
    const waiting = test.ctx.approval.request({ agent: test.source.agent, toolName: 'sensitive_operation' })
    await entered.promise
    const captured = test.ctx.approval.pendingRequests()[0]
    if (captured === undefined) throw new Error('original question is absent')
    const veto = test.ctx.on('internal/dispatch', (_mode, name, args) => {
      const event: unknown = args[1]
      if (name === 'session/event' && args[0] === test.source.agent.session && typeof event === 'object' && event !== null
        && Reflect.get(event, 'type') === 'approval/decided') throw new Error('rejection audit veto')
    })
    await expect(test.ctx.approval.rejectPending(test.source.agent, captured.id)).rejects.toThrow('rejection audit veto')
    expect(presentation?.aborted).toBe(false)
    expect(test.ctx.approval.pendingRequests()).toHaveLength(1)
    veto()
    expect(await test.ctx.approval.rejectPending(test.source.agent, captured.id)).toBe(true)
    expect(await waiting).toBe('rejected')
    answer.resolve('allowed-once')
    test.close()
  })

  it('refuses a retained originating Agent that has already left the registry', async () => {
    const test = await rejectionHarness()
    test.open()
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    test.ctx.on('approval/request', async () => { entered.resolve(undefined); return answer.promise })
    const waiting = test.ctx.approval.request({ agent: test.source.agent, toolName: 'sensitive_operation' })
    await entered.promise
    const captured = test.ctx.approval.pendingRequests()[0]
    if (captured === undefined) throw new Error('original question is absent')
    await test.source.dispose()
    expect(await test.ctx.approval.rejectPending(test.source.agent, captured.id)).toBe(false)
    test.status.valid = false
    answer.resolve('allowed-once')
    expect(await waiting).toBe('rejected')
  })
})
