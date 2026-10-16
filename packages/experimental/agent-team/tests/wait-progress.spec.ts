/** A Team wait still observes progress while Team mail is starting a teammate, or while product runtime work is under way. */
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { expect, it, vi } from 'vitest'
import { facadeControlledMode, nativeFacadeHarness } from './native-facade-harness.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const signal = new AbortController().signal
const text = (value: string) => [{ type: 'text' as const, text: value }]

async function setup(retries: { maxMessageRetries?: number; messageRetryDelayMs?: number } = {}) {
  const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode, ...retries },
    script: Array.from({ length: 4 }, () => textResponse('Member finished')) })
  vi.spyOn(test.ctx.sessionQuery, 'observeSession').mockImplementation((id, options) =>
    SessionQuery.prototype.observeSession.call(test.ctx.sessionQuery, id, options))
  const unavailable = async (): Promise<never> => { throw new Error('Task commands are outside wait progress tests') }
  test.ctx.agentTeams.installTaskExtension({ id: facadeControlledMode.requiredTaskExtensionId,
    validateMemberGroup: () => undefined, create: unavailable, update: unavailable })
  const owner = test.ctx.agentTeams.installMemberExecutions({ id: 'wait-progress-owner' })
  await test.ctx.agentPresets.register({ id: 'wait-progress-member', plugins: [] })
  const member = (await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'wait-progress-member', context: 'fresh',
    provider: 'spawn', presetId: 'wait-progress-member', prompt: [], signal })).member
  return { ...test, owner, member }
}

it('counts Team mail a teammate has not acknowledged as progress, and not once a member operation holds the teammate', async () => {
  const test = await setup()
  expect(test.ctx.agentTeams.waitCanProgress(test.lead)).toBe(false)
  // The first delivery stops before it reaches the teammate, as in the window before its run starts.
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  const original = test.ctx.subagents.deliverContinuableInput.bind(test.ctx.subagents)
  let first = true
  const delivery = vi.spyOn(test.ctx.subagents, 'deliverContinuableInput').mockImplementation(async (...args) => {
    if (first) { first = false; entered.resolve(undefined); await resume.promise }
    return await original(...args)
  })
  const sending = test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Start this work'), signal })
  await entered.promise
  expect(test.ctx.agentTeams.listMembers(test.lead).find(member => member.id === test.member.id)?.status).toBe('inactive')
  expect(test.ctx.agentTeams.waitCanProgress(test.lead)).toBe(true)
  expect(test.ctx.agentTeams.teammateStarting(test.lead, test.member.id)).toBe(true)
  expect(test.ctx.agentTeams.teammateStarting(test.lead, test.lead.id)).toBe(false)
  // A held teammate does not start from its mail, so a wait would see nothing.
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'wait-progress-hold', expectedGeneration: 1 },
    () => ({ recordId: 'wait-progress-hold', dataJson: '{}' }))
  expect(test.ctx.agentTeams.waitCanProgress(test.lead)).toBe(false)
  resume.resolve(undefined)
  expect((await sending).status).toBe('queued')
  delivery.mockRestore()
  // Mail cancelled while the teammate was held does not start it once the hold ends.
  await test.ctx.agentTeams.cancelPendingMessages(test.lead, test.member.name, 'No longer needed')
  await test.owner.release(test.lead, test.member.id, 'wait-progress-hold',
    { recordId: 'wait-progress-hold:released', dataJson: '{}' }, () => [])
  expect(test.ctx.agentTeams.waitCanProgress(test.lead)).toBe(false)
})

it('counts runtime work an installed observer reports, and joins the reports of the observers when a wait returns', async () => {
  const test = await setup()
  let preparing = true
  const removeProgress = test.ctx.agentTeams.installWaitObserver({ progressing: caller => caller === test.lead && preparing })
  expect(test.ctx.agentTeams.waitCanProgress(test.lead)).toBe(true)
  // An observer that only reports progress adds nothing to the wait result.
  expect(test.ctx.agentTeams.beginWaitReport(test.lead)()).toBeUndefined()
  preparing = false
  expect(test.ctx.agentTeams.waitCanProgress(test.lead)).toBe(false)
  preparing = true
  removeProgress()
  expect(test.ctx.agentTeams.waitCanProgress(test.lead)).toBe(false)

  const started: string[] = []
  const removeFirst = test.ctx.agentTeams.installWaitObserver({ begin: (caller) => {
    started.push(caller.id)
    return () => 'task-1 started'
  } })
  const removeSecond = test.ctx.agentTeams.installWaitObserver({ begin: () => () => undefined })
  const report = test.ctx.agentTeams.beginWaitReport(test.lead)
  expect(started).toEqual([test.lead.id])
  expect(report()).toBe('task-1 started')
  removeFirst()
  expect(test.ctx.agentTeams.beginWaitReport(test.lead)()).toBeUndefined()
  removeSecond()

  // An observer that fails is logged and counts as reporting nothing, so the wait still works.
  const warn = vi.spyOn(test.ctx.logger, 'warn')
  const removeFailing = test.ctx.agentTeams.installWaitObserver({
    progressing: () => { throw new Error('progress fault') },
    begin: () => { throw new Error('begin fault') },
  })
  const removeLate = test.ctx.agentTeams.installWaitObserver({ begin: () => () => { throw new Error('finish fault') } })
  expect(test.ctx.agentTeams.waitCanProgress(test.lead)).toBe(false)
  expect(test.ctx.agentTeams.beginWaitReport(test.lead)()).toBeUndefined()
  expect(warn.mock.calls.map(([message]) => String(message)).filter(message => message.startsWith('Team wait observer'))).toHaveLength(3)
  removeFailing()
  removeLate()
})

it('wakes a wait when the runtime work an observer reported ends without a Team change', async () => {
  const test = await setup()
  const wakes: (() => void)[] = []
  let unwatched = 0
  const remove = test.ctx.agentTeams.installWaitObserver({ progressing: () => true, watch: (_caller, wake) => {
    wakes.push(wake)
    return () => { unwatched++ }
  } })
  const failing = test.ctx.agentTeams.installWaitObserver({ watch: () => { throw new Error('watch fault') } })
  for (const userInput of [false, true]) {
    const waiting = test.ctx.agentTeams.waitForChange(test.lead, 60_000, signal, { userInput })
    await vi.waitFor(() => { expect(wakes).toHaveLength(userInput ? 2 : 1) })
    wakes.at(-1)!()
    expect(await waiting).toEqual({ timedOut: false })
  }
  expect(unwatched).toBe(2)
  remove()
  failing()
})

it('stops counting Team mail as progress once its delivery has used up its retries', async () => {
  const test = await setup({ maxMessageRetries: 1, messageRetryDelayMs: 10 })
  // The teammate first starts normally, so a later delivery failure leaves it in post.
  await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('First work'), signal })
  await vi.waitFor(() => {
    expect(test.ctx.agentTeams.listMembers(test.lead).find(member => member.id === test.member.id)?.status).toBe('inactive')
    expect(test.adapter.requests.length).toBeGreaterThan(0)
  })
  await test.lead.whenIdle()
  vi.spyOn(test.ctx.subagents, 'deliverContinuableInput').mockRejectedValue(new Error('delivery keeps failing'))
  const sent = await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Second work'), signal })
  expect(sent.status).toBe('queued')
  const pending = () => test.ctx.sessionProjections.stateOf(test.lead.session, 'agentTeam')!.messages
  await vi.waitFor(() => { expect(pending().some(message => message.id === `team-start-incomplete-${sent.messageId}`)).toBe(true) },
    { timeout: 10_000 })
  expect(test.ctx.agentTeams.teammateStarting(test.lead, test.member.id)).toBe(false)
  expect(test.ctx.agentTeams.waitCanProgress(test.lead)).toBe(false)
})
