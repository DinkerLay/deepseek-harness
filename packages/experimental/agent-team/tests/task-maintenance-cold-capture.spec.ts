/** Actual controlled member input is captured from JSONL after its Agent handle closes. */
import type { AgentInput } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { LeadExecutionHandle } from '../src/index.ts'
import { facadeControlledMode, nativeFacadeHarness } from './native-facade-harness.ts'

it.each(['restore', 'handback'] as const)('captures an original cold input and %s returns its exact non-waking identity', async (disposition) => {
  const signal = new AbortController().signal
  let leadOwner: LeadExecutionHandle | undefined
  const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode }, beforeLead: (ctx) => {
    leadOwner = ctx.agentTeams.installLeadExecutions({
      isReady: anchor => ctx.agents.get(anchor.id) === anchor,
      resolveAnchor: (id) => {
        const anchor = ctx.agents.get(id)
        if (anchor === undefined) throw new Error('the real fixture anchor is not resident')
        return Promise.resolve(anchor)
      },
    })
  } })
  if (leadOwner === undefined) throw new Error('the native Lead owner did not initialize')
  await leadOwner.prepareAnchor(test.lead)
  const observing = vi.spyOn(test.ctx.sessionQuery, 'observeSession').mockImplementation((id, options) =>
    SessionQuery.prototype.observeSession.call(test.ctx.sessionQuery, id, options))
  onTestFinished(() => { observing.mockRestore() })
  const unavailable = (): Promise<never> => Promise.reject(new Error('this fixture does not run model Task commands'))
  const tasks = test.ctx.agentTeams.installTaskExtension({ id: facadeControlledMode.requiredTaskExtensionId,
    requireDurableAcknowledgement: true, create: unavailable, update: unavailable,
    validateMemberGroup: () => undefined, classifyInput: () => undefined })
  const memberOwner = test.ctx.agentTeams.installMemberExecutions({ id: 'cold-capture-member-owner' })
  const { member } = await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'cold-worker', context: 'fresh',
    provider: 'spawn', presetId: 'standard', prompt: [{ type: 'text', text: 'Registration is not work' }], signal })
  if (member.preset === undefined) throw new Error('the registered member has no Preset')
  await test.ctx.subagents.prepareContinuable({ childId: member.id, provider: 'spawn', label: member.name,
    preset: member.preset, request: { parent: test.lead }, signal })
  const live = await test.ctx.agents.resume({ resumeSessionId: member.id,
    agentOptions: { provider: 'mock', model: 'mock' }, setup: async (ctx) => {
      const presets = ctx.get('agentPresets')
      if (presets === undefined) throw new Error('the fixture Preset registry is absent')
      await presets.mount(ctx, 'standard')
    } })
  onTestFinished(async () => { await live.dispose() })
  const operationId = 'cold-capture-admission'
  await memberOwner.hold(test.lead, { memberId: member.id, operationId, expectedGeneration: 1 },
    () => ({ recordId: 'cold-capture-held', dataJson: '{}' }))
  const input: AgentInput = { target: 'next-turn', wakeup: false,
    message: createUserMessage({ content: [{ type: 'text', text: 'Keep this original coordination input pending' }],
      source: { kind: 'user' } }) }
  expect(await test.ctx.agents.receiveInput(live.agent, input)).toMatchObject({ location: 'held' })
  expect(live.agent.inbox.nextTurn).toEqual([])
  // Graceful AgentHandle.dispose cancels its executable inbox. Admission-held input
  // survives that real teardown; cold restoration creates the later pending queue.
  await live.dispose()
  expect(test.ctx.agents.get(member.id)).toBeUndefined()
  expect(test.ctx.sessions.get(member.id)).toBeUndefined()
  const registering = vi.spyOn(test.ctx.agents, 'registerInputController')
  onTestFinished(() => { registering.mockRestore() })
  await memberOwner.release(test.lead, member.id, operationId,
    { recordId: 'cold-capture-control-released', dataJson: '{}' }, () => [])
  const request = { target: { kind: 'member' as const, memberId: member.id, executionId: member.id, generation: 1 } }
  await tasks.withExecutionMaintenance(test.lead, request, signal, async (scope) => {
    expect(scope.source).toBe('stored')
    expect(scope.read()?.pending).toEqual([])
    expect(scope.read()?.inputControl.records.find(record => record.input.message.id === input.message.id)?.captured).not.toBe(true)
    await scope.restore([input.message.id])
    expect(scope.read()?.pending).toEqual([{ target: input.target, message: input.message }])
  })
  await tasks.withExecutionMaintenance(test.lead, request, signal, async (scope) => {
    expect(scope.source).toBe('stored')
    expect(scope.read()?.pending).toEqual([{ target: input.target, message: input.message }])
    expect(await scope.capture([input.message.id])).toEqual([input])
    const held = scope.read()
    expect(held?.pending).toEqual([])
    expect(held?.inputControl.records.find(record => record.input.message.id === input.message.id))
      .toMatchObject({ input, location: 'held', captured: true })
    if (disposition === 'restore') {
      await scope.restore([input.message.id])
      await scope.restore([input.message.id])
      expect(scope.read()?.pending).toEqual([{ target: input.target, message: input.message }])
    }
  })
  expect(registering).not.toHaveBeenCalled()
  expect(test.ctx.agents.get(member.id)).toBeUndefined()
  expect(test.ctx.sessions.get(member.id)).toBeUndefined()
  const stored = await test.ctx.sessionPersistence.open(member.id, 'read')
  try {
    const { events } = await stored.read()
    expect(events.filter(event => event.type === 'agent/input/held' && event.data.captured === true
      && event.data.input.message.id === input.message.id)).toHaveLength(1)
    expect(events.filter(event => event.type === 'agent/inbox/spliced' && event.data.heldInput === input.message.id)).toHaveLength(1)
    const returned = events.filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === input.message.id))
    expect(returned).toHaveLength(2)
    for (const event of returned) {
      if (event.type !== 'agent/inbox/spliced') throw new Error('the selected event is not an inbox splice')
      expect(event.data).toMatchObject({ target: input.target, inserted: [input.message], wakeup: false })
    }
    expect(events.some(event => event.type === 'agent/input/released' && event.data.messageId === input.message.id)).toBe(false)
  } finally { await stored.close() }
  expect(test.adapter.requests).toHaveLength(0)
})
