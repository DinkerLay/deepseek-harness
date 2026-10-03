import { Context } from '@deepseek-ai/cordis'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { JobOutcome, JobSettleCause } from '@deepseek-ai/dsh-jobs'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ToolJobs from '../src/index.ts'

describe('job completion controlled input receipts', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
    vi.restoreAllMocks()
  })

  async function boot(admission: 'accept' | 'reject' = 'accept') {
    const owner = ctx = new Context()
    await mountAgentLoopTestDependencies(owner)
    const loop = await mountAgentLoopTestHarness(owner)
    await owner.plugin(LocalJobs)
    const fiber = await owner.plugin(ToolJobs)
    const agent = await loop.create(SessionId('completion-owner'))
    const controller = owner.agents.registerInputController(InputControllerId('completion-receipt'), {
      admit: () => admission === 'reject' ? { kind: 'reject', reason: 'completion custody denied' } : { kind: 'accept' },
      canStart: () => false, canClaim: () => false,
    })
    controller.bind(agent.session)
    owner.on('session/flush', () => {})
    const start = (label: string) => {
      const done = Promise.withResolvers<JobOutcome>()
      const id = owner.jobs.start({ owner: agent.id, kind: 'bash', label,
        run: () => ({ done: done.promise, cancel: () => { done.resolve({ status: 'killed' }) } }),
      })
      return { id, settle: () => { done.resolve({ status: 'completed' }) } }
    }
    return { owner, agent, controller, fiber, start }
  }

  it('owns a pending receipt through plugin disposal and stops accepting later notices', async () => {
    const test = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = test.owner.sessions.flush.bind(test.owner.sessions)
    vi.spyOn(test.owner.sessions, 'flush').mockImplementationOnce(async (session) => {
      expect(session).toBe(test.agent.session)
      entered.resolve(undefined)
      await release.promise
      return flush(session)
    })
    const first = test.start('first completion')
    const second = test.start('later completion')
    const secondSettled = Promise.withResolvers<JobSettleCause>()
    test.owner.jobs.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'settled' && event.job.id === second.id) {
        secondSettled.resolve(event.cause)
      }
    })
    first.settle()
    try {
      await entered.promise
      const input = test.owner.agents.inputControlState(test.agent.session).records[0]!.input
      expect(input).toMatchObject({ target: 'next-turn', wakeup: true, message: { source: { kind: 'tool-jobs' } } })
      const content = input.message.content[0]
      if (content?.type !== 'text') throw new Error('completion notice must contain text')
      expect(content.text).toContain(first.id)
      let disposed = false
      const disposal = test.fiber.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      second.settle()
      expect(await secondSettled.promise).toBe('producer')
      release.resolve(undefined)
      await disposal
      expect(test.owner.agents.inputControlState(test.agent.session).records).toHaveLength(1)
      expect(test.agent.inbox.nextTurn).toEqual([input.message])
      expect(test.agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
    } finally {
      first.settle()
      second.settle()
      release.resolve(undefined)
      await test.fiber.dispose()
    }
  })

  it.each(['false', 'throw'] as const)('reports uncertain persistence %s without changing job settlement or losing custody', async (failure) => {
    const test = await boot()
    const warned = Promise.withResolvers<undefined>()
    const warning = vi.spyOn(test.owner.logger, 'warn').mockImplementation(() => { warned.resolve(undefined) })
    const flush = vi.spyOn(test.owner.sessions, 'flush')
    if (failure === 'false') flush.mockResolvedValueOnce(false)
    else flush.mockRejectedValueOnce(new Error('custody storage failed'))
    const job = test.start('uncertain completion')
    job.settle()
    await warned.promise
    expect(warning.mock.calls[0]?.[0]).toMatch(failure === 'false' ? /not confirmed/ : /custody storage failed/)
    expect(test.owner.jobs.get(job.id, test.agent.id).status).toBe('completed')
    expect(test.agent.inbox.nextTurn).toHaveLength(1)
    expect(test.owner.agents.canStartInput(test.agent)).toBe(false)
    expect(flush).toHaveBeenCalledTimes(1)
    await test.fiber.dispose()
  })

  it('reports rejected completion custody while preserving the settled job', async () => {
    const test = await boot('reject')
    const warned = Promise.withResolvers<undefined>()
    const warning = vi.spyOn(test.owner.logger, 'warn').mockImplementation(() => { warned.resolve(undefined) })
    const job = test.start('denied completion')
    job.settle()
    await warned.promise
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning.mock.calls[0]?.[0]).toContain('completion custody denied')
    expect(test.owner.jobs.get(job.id, test.agent.id).status).toBe('completed')
    expect(test.owner.agents.inputControlState(test.agent.session).records).toEqual([])
    expect(test.agent.inbox.nextTurn).toEqual([])
    await test.fiber.dispose()
  })
})
