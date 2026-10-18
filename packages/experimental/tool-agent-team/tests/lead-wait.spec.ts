import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { toolCallResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TeamId, TeamMessageId } from '../../agent-team/src/index.ts'
import { leadCoordinatorHarness } from '../../agent-team/tests/lead-coordinator-harness.ts'
import * as toolTeam from '../src/index.ts'

const signal = new AbortController().signal

async function setup(term: number, activePeer = false, waitEndsOnUserMessage = false, waitEndsOnPendingInput = false) {
  const test = await leadCoordinatorHarness({}, [
    ...activePeer ? ['hang' as const] : [],
    toolCallResponse('lead-wait-call', 'wait_agent', { timeout_ms: 600_000 }),
    ...waitEndsOnPendingInput ? [toolCallResponse('lead-wait-again', 'wait_agent', { timeout_ms: 600_000 })] : [],
    textResponse('Lead wait finished'),
    ...waitEndsOnUserMessage ? [textResponse('Answering the user')] : [],
  ])
  test.writer.dispose()
  test.ctx.agentTeams.installTaskExtension({ id: 'facade-writer',
    validateMemberGroup: (_caller, group) => { if (group !== 'waiters') throw new Error('Wait fixture requires its waiters group') },
    planLeadRelease: () => '{}',
    create: async () => { throw new Error('Wait fixture does not create Tasks') },
    update: async () => { throw new Error('Wait fixture does not update Tasks') },
  })
  test.ctx.loader.builtins['lead-wait-tools'] = toolTeam
  await test.ctx.loader.create({ name: 'cordis:lead-wait-tools', config: { controlledTasks: true, waitEndsOnUserMessage,
    waitEndsOnPendingInput } })
  await test.ctx.loader.await()
  const worker = await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'wait-worker', group: 'waiters', presetId: 'reviewer',
    provider: 'spawn', context: 'fresh', prompt: [], signal })
  let current = test.lead
  for (let nextTerm = 2; nextTerm <= term; nextTerm++) {
    const operationId = `wait-handoff-${nextTerm}`
    await test.freeze(operationId, nextTerm - 1)
    const candidate = await test.create(`wait-lead-${nextTerm}`, nextTerm)
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(operationId, nextTerm - 1), async (safe) => {
      await safe.record({ recordId: `${operationId}-prepared`, dataJson: '{}' }, true)
      await safe.commitLeadTransaction({ binding: test.binding(candidate.agent), releases: [],
        record: { recordId: `${operationId}-commit`, dataJson: '{}' } })
    })
    await test.stage('ready', operationId, nextTerm - 1)
    current = candidate.agent
  }
  expect(test.ctx.agentTeams.membership(current)).toMatchObject({ role: 'lead', name: 'lead', term })
  expect(current.id).not.toBe(test.lead.id)
  if (activePeer) {
    await test.ctx.agentTeams.sendMessage(current, { target: 'wait-worker', content: [{ type: 'text', text: 'Remain active' }], signal })
    await vi.waitFor(() => { expect(test.ctx.agents.get(worker.member.id)?.status).toBe('running') })
  } else {
    expect(test.ctx.agents.get(worker.member.id)).toBeUndefined()
    expect(test.ctx.agentTeams.listMembers(current).find(member => member.name === 'wait-worker')?.status).toBe('inactive')
  }
  const finished = Promise.withResolvers<undefined>()
  test.ctx.on('session/event', (session, event) => {
    if (session === current.session && event.type === 'tool/result' && event.data.message.source.callId === 'lead-wait-call') {
      finished.resolve(undefined)
    }
  }, { global: true })
  const begin = () => test.ctx.agents.receiveInput(current, { message: createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Wait for teammate progress' }] }), target: 'next-turn', wakeup: true })
  const result = (callId = 'lead-wait-call') => {
    const event = current.session.snapshotEvents().find(item => item.type === 'tool/result' && item.data.message.source.callId === callId)
    if (event?.type !== 'tool/result') throw new Error('Lead wait result was not recorded')
    const value: unknown = JSON.parse(event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    return value
  }
  return { ...test, current, worker, begin, result, finished }
}

describe('waiting from a replaced native Lead', () => {
  it.each([2, 3])('returns noProgress from the running term-%s Lead when every teammate is inactive', async (term) => {
    const test = await setup(term)
    const waiting = Promise.withResolvers<undefined>()
    const original = test.ctx.agentTeams.waitForChange.bind(test.ctx.agentTeams)
    const waiter = vi.spyOn(test.ctx.agentTeams, 'waitForChange').mockImplementation((caller, timeout, abort) => {
      const pending = original(caller, timeout, abort)
      waiting.resolve(undefined)
      return pending
    })
    try {
      await test.begin()
      expect(await Promise.race([test.finished.promise.then(() => 'finished'), waiting.promise.then(() => 'waiting-for-self')]))
        .toBe('finished')
      expect(waiter).not.toHaveBeenCalled()
      expect(test.result()).toMatchObject({ timedOut: false, noProgress: { reason: 'no-active-peer' } })
      await test.current.whenIdle()
      expect(test.adapter.requests.map(request => request.sessionId)).toEqual([test.current.id, test.current.id])
      expect(test.lead.session.snapshotEvents().some(event => event.type === 'request/header')).toBe(false)
    } finally {
      test.current.cancel({ kind: 'user' }, { keepInbox: true })
      await test.current.whenIdle()
      waiter.mockRestore()
    }
  })

  it.each([2, 3])('waits for a genuinely running teammate from the term-%s Lead', async (term) => {
    const test = await setup(term, true)
    const entered = Promise.withResolvers<undefined>()
    const original = test.ctx.agentTeams.waitForChange.bind(test.ctx.agentTeams)
    const waiter = vi.spyOn(test.ctx.agentTeams, 'waitForChange').mockImplementation((caller, timeout, abort) => {
      const pending = original(caller, timeout, abort)
      entered.resolve(undefined)
      return pending
    })
    try {
      await test.begin()
      await entered.promise
      expect(waiter).toHaveBeenCalledOnce()
      expect(test.current.status).toBe('running')
      expect(test.ctx.agentTeams.listMembers(test.current)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: test.lead.id, name: 'lead', status: 'running' }),
        expect.objectContaining({ name: 'wait-worker', status: 'running' }),
      ]))
      expect(test.current.session.snapshotEvents().some(event => event.type === 'tool/result')).toBe(false)
      test.ctx.agentTeams.interrupt(test.current, 'wait-worker')
      await test.finished.promise
      await test.current.whenIdle()
      expect(test.result()).toMatchObject({ timedOut: false })
      expect(test.result()).not.toHaveProperty('noProgress')
    } finally {
      test.current.cancel({ kind: 'user' }, { keepInbox: true })
      await test.current.whenIdle()
      waiter.mockRestore()
    }
  })
})

describe('a user message while the Lead waits', () => {
  it('ends the wait and tells the Lead to end its turn to read a queued message', async () => {
    const test = await setup(2, true, true)
    const declaration = test.ctx.tools.schemas(test.current).find(tool => tool.name === 'wait_agent')
    expect(declaration?.description).toContain('A user message also ends the wait.')
    const entered = Promise.withResolvers<undefined>()
    const original = test.ctx.agentTeams.waitForChange.bind(test.ctx.agentTeams)
    const waiter = vi.spyOn(test.ctx.agentTeams, 'waitForChange').mockImplementation((caller, timeout, abort, options) => {
      const pending = original(caller, timeout, abort, options)
      entered.resolve(undefined)
      return pending
    })
    try {
      await test.begin()
      await entered.promise
      expect(waiter).toHaveBeenCalledWith(test.current, 600_000, expect.any(AbortSignal), { userInput: true })
      await test.ctx.agents.receiveInput(test.current, { message: createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text: 'How far along are we?' }] }), target: 'next-turn', wakeup: true })
      await test.finished.promise
      const ended = test.result() as { readonly timedOut: boolean; readonly userMessage?: { readonly message: string } }
      expect(ended.timedOut).toBe(false)
      expect(ended.userMessage?.message).toContain('end your turn to read it')
      expect(Object.keys(ended).sort()).toEqual(['timedOut', 'userMessage'])
      // The Lead finishes this turn on the wait result, and the queued message starts its next turn.
      await vi.waitFor(() => {
        expect(test.current.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason))
          .toEqual([{ kind: 'completed' }, { kind: 'completed' }])
      })
      const asked = test.current.session.snapshotEvents().findLast(event => event.type === 'agent/inbox/spliced'
        && event.data.target === 'next-turn' && event.data.inserted.length === 1)
      expect(asked?.type === 'agent/inbox/spliced' ? asked.data.inserted[0]?.content : undefined)
        .toEqual([{ type: 'text', text: 'How far along are we?' }])
    } finally {
      test.current.cancel({ kind: 'user' }, { keepInbox: true })
      await test.current.whenIdle()
      waiter.mockRestore()
    }
  })

  it('keeps the official wait unchanged without the options', async () => {
    const test = await setup(2, true)
    const description = test.ctx.tools.schemas(test.current).find(tool => tool.name === 'wait_agent')?.description
    expect(description).not.toContain('user message')
    expect(description).not.toContain('notices')
    const output = JSON.stringify(test.ctx.tools.get('wait_agent', scopeOf(test.current.ctx))?.output.schema)
    expect(output).not.toContain('userMessage')
    expect(output).not.toContain('pendingInput')
    test.current.cancel({ kind: 'user' }, { keepInbox: true })
    await test.current.whenIdle()
  })
})

describe('Team mail while the Lead waits', () => {
  it('ends the wait for mail waiting for the next step, and the wait after that step reads it parks', async () => {
    const test = await setup(2, true, false, true)
    const description = test.ctx.tools.schemas(test.current).find(tool => tool.name === 'wait_agent')?.description
    expect(description).toContain('It also ends as soon as new messages or notices are waiting for you.')
    expect(description).not.toContain('user message')
    const worker = test.ctx.agents.get(test.worker.member.id)
    if (worker === undefined) throw new Error('the waiting fixture needs its running teammate')
    const entered = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()] as const
    const original = test.ctx.agentTeams.waitForChange.bind(test.ctx.agentTeams)
    const waiter = vi.spyOn(test.ctx.agentTeams, 'waitForChange').mockImplementation(async (caller, timeout, abort, options) => {
      const call = waiter.mock.calls.length - 1
      // The mail reaches the Lead after its step claimed the input and before its first wait registers.
      if (call === 0) {
        await test.ctx.agentTeams.sendMessage(worker, { target: 'lead', content: [{ type: 'text', text: 'Sealed result ready' }], signal })
        expect(test.current.inbox.nextStep).toHaveLength(1)
      }
      const pending = original(caller, timeout, abort, options)
      entered[call]?.resolve(undefined)
      return await pending
    })
    const again = Promise.withResolvers<undefined>()
    test.ctx.on('session/event', (session, event) => {
      if (session === test.current.session && event.type === 'tool/result'
        && event.data.message.source.callId === 'lead-wait-again') again.resolve(undefined)
    }, { global: true })
    try {
      await test.begin()
      await entered[0].promise
      expect(waiter).toHaveBeenCalledWith(test.current, 600_000, expect.any(AbortSignal), { pendingInput: true })
      await test.finished.promise
      expect(test.result()).toEqual({ timedOut: false,
        pendingInput: { message: 'New messages or notices arrived for you. They reach you right after this result.' } })
      // The next step claims the mail and waits again; with nothing left for it, that wait stays until the teammate changes.
      await entered[1].promise
      const read = test.adapter.requests.findLast(request => request.sessionId === test.current.id)
      expect(JSON.stringify(read)).toContain('Sealed result ready')
      expect(test.current.inbox.nextStep).toEqual([])
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(test.current.session.snapshotEvents().some(event => event.type === 'tool/result'
        && event.data.message.source.callId === 'lead-wait-again')).toBe(false)
      test.ctx.agentTeams.interrupt(test.current, 'wait-worker')
      await again.promise
      expect(test.result('lead-wait-again')).toMatchObject({ timedOut: false })
    } finally {
      test.current.cancel({ kind: 'user' }, { keepInbox: true })
      await test.current.whenIdle()
      waiter.mockRestore()
    }
  })

  it('declares both input fields when a user message and other waiting mail can end the wait', async () => {
    const test = await setup(2, true, true, true)
    expect(test.ctx.tools.schemas(test.current).find(tool => tool.name === 'wait_agent')?.description).toContain(
      'A user message also ends the wait. It also ends as soon as new messages or notices are waiting for you.')
    const output = JSON.stringify(test.ctx.tools.get('wait_agent', scopeOf(test.current.ctx))?.output.schema)
    expect(output).toContain('userMessage')
    expect(output).toContain('pendingInput')
    test.current.cancel({ kind: 'user' }, { keepInbox: true })
    await test.current.whenIdle()
  })

  it('ends a direct wait for mail waiting for the next step, while a wait nested in a program waits for a change', async () => {
    const test = await setup(2, true, false, true)
    test.current.inbox.append('next-step', teamNotice(test.lead, 'sealed-nested'))
    const parent = await directCallToken(test)
    expect(parent.result).toEqual({ timedOut: false, pendingInput: { message: PENDING_INPUT_MESSAGE } })
    const waiter = vi.spyOn(test.ctx.agentTeams, 'waitForChange')
    try {
      const nested = callWait(test, 'nested-wait', parent.token)
      let settled = false
      void nested.then(() => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(settled).toBe(false)
      expect(waiter).toHaveBeenCalledExactlyOnceWith(test.current, 10_000, expect.any(AbortSignal), {})
      test.ctx.agentTeams.interrupt(test.current, 'wait-worker')
      await expect(nested).resolves.toEqual({ timedOut: false })
      expect(test.current.inbox.nextStep).toHaveLength(1)
    } finally {
      waiter.mockRestore()
      test.current.cancel({ kind: 'user' }, { keepInbox: true })
      await test.current.whenIdle()
    }
  })

  it('adds waiting mail to a direct noProgress result when no teammate can change anything', async () => {
    const test = await setup(2, false, false, true)
    test.current.inbox.append('next-step', teamNotice(test.lead, 'sealed-idle'))
    const noProgress = { timedOut: false, noProgress: { reason: 'no-active-peer' } }
    const parent = await directCallToken(test)
    expect(parent.result).toMatchObject({ ...noProgress, pendingInput: { message: PENDING_INPUT_MESSAGE } })
    const nested = await callWait(test, 'nested-idle-wait', parent.token)
    expect(nested).toMatchObject(noProgress)
    expect(nested).not.toHaveProperty('pendingInput')
    test.current.inbox.clear()
    const afterRead = await callWait(test, 'idle-wait-after-read')
    expect(afterRead).toMatchObject(noProgress)
    expect(afterRead).not.toHaveProperty('pendingInput')
  })
})

const PENDING_INPUT_MESSAGE = 'New messages or notices arrived for you. They reach you right after this result.'

/** Team mail as the mailbox delivers it to the Lead. */
function teamNotice(anchor: Agent, id: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: `Notice ${id}` }], source: { kind: 'team-message',
    teamId: TeamId(anchor.id), messageId: TeamMessageId(id), senderId: anchor.id, senderName: 'lead' } })
}

/** Call wait_agent as the current Lead, directly or nested in the execution `parent` names, and parse its result. */
async function callWait(test: Awaited<ReturnType<typeof setup>>, callId: string, parent?: ToolExecutionToken): Promise<unknown> {
  const result = await test.ctx.tools.execute({ callId: ToolCallId(callId), name: 'wait_agent', arguments: { timeout_ms: 10_000 },
    agent: test.current, signal, ...parent === undefined ? {} : { parent } })
  const value: unknown = JSON.parse(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
  return value
}

/** Make one direct wait_agent call and keep its execution token for nested calls. */
async function directCallToken(test: Awaited<ReturnType<typeof setup>>) {
  const tokens: ToolExecutionToken[] = []
  const stop = test.ctx.on('tools/pre-execute', (exec, next) => {
    tokens.push(exec.token)
    return next()
  })
  const result = await callWait(test, 'direct-wait')
  stop()
  const [token] = tokens
  if (token === undefined) throw new Error('the direct wait_agent call had no execution token')
  return { result, token }
}
