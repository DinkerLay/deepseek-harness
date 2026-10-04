import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { toolCallResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { leadCoordinatorHarness } from '../../agent-team/tests/lead-coordinator-harness.ts'
import * as toolTeam from '../src/index.ts'

const signal = new AbortController().signal

async function setup(term: number, activePeer = false) {
  const test = await leadCoordinatorHarness({}, [
    ...activePeer ? ['hang' as const] : [],
    toolCallResponse('lead-wait-call', 'wait_agent', { timeout_ms: 600_000 }),
    textResponse('Lead wait finished'),
  ])
  test.writer.dispose()
  test.ctx.agentTeams.installTaskExtension({ id: 'facade-writer',
    validateMemberGroup: (_caller, group) => { if (group !== 'waiters') throw new Error('Wait fixture requires its waiters group') },
    planLeadRelease: () => '{}',
    create: async () => { throw new Error('Wait fixture does not create Tasks') },
    update: async () => { throw new Error('Wait fixture does not update Tasks') },
  })
  test.ctx.loader.builtins['lead-wait-tools'] = toolTeam
  await test.ctx.loader.create({ name: 'cordis:lead-wait-tools', config: { controlledTasks: true } })
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
  const result = () => {
    const event = current.session.snapshotEvents().find(item => item.type === 'tool/result' && item.data.message.source.callId === 'lead-wait-call')
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
