import { Context } from '@deepseek-ai/cordis'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAfterScheduleRecord, ScheduleId } from '../src/domain.ts'
import { ScheduleRuntime } from '../src/runtime.ts'
import type { ScheduleTask } from '../src/storage.ts'

describe('Schedule controlled input receipts', () => {
  let ctx: Context | undefined
  let runtime: ScheduleRuntime | undefined

  afterEach(async () => {
    await runtime?.dispose()
    await ctx?.fiber.dispose()
    runtime = undefined
    ctx = undefined
    vi.restoreAllMocks()
  })

  async function boot(admission: 'accept' | 'hold' | 'reject') {
    const owner = ctx = new Context()
    await mountAgentLoopTestDependencies(owner)
    const loop = await mountAgentLoopTestHarness(owner)
    const agent = await loop.create(SessionId('schedule-custody'))
    const controller = owner.agents.registerInputController(InputControllerId('schedule-receipt'), {
      admit: () => admission === 'reject' ? { kind: 'reject', reason: 'reminder custody denied' } : { kind: admission },
      canStart: () => false, canClaim: () => false,
    })
    controller.bind(agent.session)
    owner.provide('sessionController', { resolveAgent: async () => ({ agent }) } as never)
    owner.on('session/flush', () => {})
    const record = createAfterScheduleRecord(ScheduleId('controlled-reminder'), 'Controlled reminder', 1,
      Date.now() - 2000, 'Deliver this reminder')
    const tasks: ScheduleTask[] = [{ sessionId: agent.session.id, record, status: 'active' }]
    const commit = vi.fn(async (task: ScheduleTask) => { tasks[0] = task })
    const driver = runtime = new ScheduleRuntime(owner, () => tasks, work => work(), commit, { days: 30, records: 200 })
    return { owner, agent, controller, record, tasks, commit, driver }
  }

  it.each(['accept', 'hold'] as const)('retires a reminder only after durable %s custody, while disposal drains delivery', async (admission) => {
    const test = await boot(admission)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = test.owner.sessions.flush.bind(test.owner.sessions)
    vi.spyOn(test.owner.sessions, 'flush').mockImplementationOnce(async (session) => {
      expect(session).toBe(test.agent.session)
      entered.resolve(undefined)
      await release.promise
      return flush(session)
    })
    test.driver.requestDrive()
    try {
      await entered.promise
      expect(test.commit).not.toHaveBeenCalled()
      expect(test.tasks[0]?.status).toBe('active')
      const custody = test.owner.agents.inputControlState(test.agent.session).records[0]!
      expect(custody).toMatchObject({
        location: admission === 'hold' ? 'held' : 'inbox',
        input: { target: 'next-turn', wakeup: true, message: { source: { kind: 'schedule' } } },
      })
      let disposed = false
      const disposal = test.driver.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      release.resolve(undefined)
      await disposal
      expect(test.commit).toHaveBeenCalledTimes(1)
      expect(test.tasks[0]).toMatchObject({ status: 'inactive', lastDelivery: { messageId: custody.input.message.id } })
      expect(test.agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
      expect(test.agent.inbox.nextTurn).toHaveLength(admission === 'hold' ? 0 : 1)
    } finally {
      release.resolve(undefined)
      await test.driver.dispose()
    }
  })

  it.each(['false', 'throw'] as const)('retains the original task without a delivery record after uncertain persistence %s', async (failure) => {
    const test = await boot('accept')
    const warned = Promise.withResolvers<undefined>()
    const warning = vi.spyOn(test.owner.logger, 'warn').mockImplementation(() => { warned.resolve(undefined) })
    const flush = vi.spyOn(test.owner.sessions, 'flush')
    if (failure === 'false') flush.mockResolvedValueOnce(false)
    else flush.mockRejectedValueOnce(new Error('custody storage failed'))
    test.driver.requestDrive()
    await warned.promise
    await test.driver.dispose()
    expect(warning.mock.calls[0]?.[0]).toMatch(failure === 'false' ? /not confirmed/ : /custody storage failed/)
    expect(test.commit).not.toHaveBeenCalled()
    expect(test.tasks).toEqual([{ sessionId: test.agent.session.id, record: test.record, status: 'active' }])
    expect(test.agent.inbox.nextTurn).toHaveLength(1)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('retains the active task and reports custody rejection without retrying or recording delivery', async () => {
    const test = await boot('reject')
    const warned = Promise.withResolvers<undefined>()
    const warning = vi.spyOn(test.owner.logger, 'warn').mockImplementation(() => { warned.resolve(undefined) })
    test.driver.requestDrive()
    await warned.promise
    await test.driver.dispose()
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning.mock.calls[0]?.[0]).toContain('reminder custody denied')
    expect(test.commit).not.toHaveBeenCalled()
    expect(test.tasks).toEqual([{ sessionId: test.agent.session.id, record: test.record, status: 'active' }])
    expect(test.owner.agents.inputControlState(test.agent.session).records).toEqual([])
    expect(test.agent.inbox.nextTurn).toEqual([])
  })
})
