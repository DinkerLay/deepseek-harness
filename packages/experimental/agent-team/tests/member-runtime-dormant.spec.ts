/** Dormant member custody over actual continuations, Preset leases and JSONL storage. */
import { existsSync, readdirSync, renameSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AgentInput } from '@deepseek-ai/dsh-agent'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import { createMessage, createUserMessage, ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { nativeFacadeHarness, facadeControlledMode } from './native-facade-harness.ts'
import { leadCoordinatorHarness } from './lead-coordinator-harness.ts'
import { TeamLeadOperationId } from '../src/index.ts'

const signal = new AbortController().signal
const text = (value: string) => [{ type: 'text' as const, text: value }]
const record = (recordId: string) => ({ recordId, dataJson: '{}' })
const changedPreset = { id: 'dormant-source', name: 'Changed role', plugins: [{
  name: new URL('../../../subagent/subagent-in-process-driver/tests/fixtures/plugins/preset-tool.js', import.meta.url).href,
  config: { tool: 'dormant_changed_tool' },
}] }
const gate = () => {
  const value = Promise.withResolvers<undefined>()
  return { promise: value.promise, resolve: () => { value.resolve(undefined) } }
}

async function setup() {
  const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode },
    script: [textResponse('Member finished'), textResponse('Lead received completion')] })
  vi.spyOn(test.ctx.sessionQuery, 'observeSession').mockImplementation((id, options) =>
    SessionQuery.prototype.observeSession.call(test.ctx.sessionQuery, id, options))
  const removePreset = await test.ctx.agentPresets.register({ id: 'dormant-source', name: 'Dormant source', plugins: [] })
  const unavailable = async (): Promise<never> => { throw new Error('Task commands are outside dormant custody tests') }
  const writer = test.ctx.agentTeams.installTaskExtension({ id: facadeControlledMode.requiredTaskExtensionId,
    validateMemberGroup: () => undefined, create: unavailable, update: unavailable })
  const owner = test.ctx.agentTeams.installMemberExecutions({ id: 'dormant-member-owner' })
  const member = (await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'dormant-worker', context: 'fresh', provider: 'spawn',
    presetId: 'dormant-source', prompt: text('Unused registration'), signal })).member
  return { ...test, member, owner, writer, removePreset, modelBaseline: { count: 0 } }
}

type Test = Awaited<ReturnType<typeof setup>>
async function startAndSettle(test: Test) {
  await test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name, content: text('Complete this first work'), signal })
  await vi.waitFor(() => {
    expect(test.adapter.requests.length).toBeGreaterThan(0)
    expect(test.ctx.agents.get(test.member.id)).toBeUndefined()
  })
  await test.lead.whenIdle()
  test.modelBaseline.count = test.adapter.requests.length
}
async function hold(test: Test, operationId = 'dormant-replace', candidate?: SessionId) {
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId, expectedGeneration: 1,
    ...candidate === undefined ? {} : { nextExecutionId: candidate } }, () => record(`${operationId}:hold`))
}
async function events(test: Test): Promise<readonly SessionEvent[]> {
  const handle = await test.ctx.sessionPersistence.open(test.member.id, 'read')
  try { return (await handle.read()).events } finally { await handle.close() }
}
/** Write one owned crash fixture into the inactive original log, excluding preparation markers. */
async function appendSource(test: Test, append: (session: Session) => void) {
  expect(test.ctx.agents.get(test.member.id)).toBeUndefined()
  const handle = await test.ctx.sessionPersistence.open(test.member.id, 'write')
  try {
    const stored = await handle.read()
    const source = test.ctx.sessions.prepare(test.member.id, { seed: stored.events, meta: handle.header,
      inheritedEventCount: handle.inheritedEventCount })
    const start = source.seq
    append(source)
    const suffix = source.snapshotEvents(SessionLogOffset(start))
      .map((event, index) => ({ ...event, seq: SessionSeq(stored.events.length + index) }))
    await handle.append(suffix)
    await handle.flush()
  } finally { await handle.close() }
}

it.each(['removed', 'changed'] as const)('captures and settles an actually started cold member after its Preset is %s, without restoring it', async (kind) => {
  const test = await setup()
  await startAndSettle(test)
  const pending: AgentInput = { message: createUserMessage({ source: { kind: 'user' }, content: text('Unconsumed original work') }),
    target: 'next-turn', wakeup: true }
  await appendSource(test, (source) => {
    source.append('agent/inbox/spliced', { target: pending.target, start: 0, inserted: [pending.message], wakeup: pending.wakeup })
  })
  await hold(test)
  await test.removePreset()
  if (kind === 'changed') await test.ctx.agentPresets.register(changedPreset)
  const mounts = vi.spyOn(test.ctx.agentPresets, 'acquireComposition')
  const restore = vi.spyOn(test.ctx.subagents, 'withContinuableExecution')
  let inspected = false
  expect(await test.owner.captureCurrent(test.lead, test.member.id, 'dormant-replace', signal, (id, stored) => {
    expect(id).toBe(test.member.id)
    expect(stored?.pending.map(item => item.message.id)).toEqual([pending.message.id])
    inspected = true
    return []
  })).toEqual([pending])
  await test.owner.releaseCaptured(test.lead, test.member.id, 'dormant-replace', [pending.message.id], record('dormant-replace:disposition'))
  await test.owner.release(test.lead, test.member.id, 'dormant-replace', record('dormant-replace:released'), (_id, stored) => {
    expect(stored?.pending).toEqual([])
    return []
  })
  expect(inspected).toBe(true)
  expect(restore).not.toHaveBeenCalled()
  expect(mounts).not.toHaveBeenCalled()
  expect(test.ctx.agents.get(test.member.id)).toBeUndefined()
  expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(false)
  expect(test.adapter.requests).toHaveLength(test.modelBaseline.count)
  const saved = await events(test)
  expect(saved.filter(event => event.type === 'agent/input/held' && event.data.input.message.id === pending.message.id)).toHaveLength(1)
  expect(saved.filter(event => event.type === 'agent/input/released' && event.data.messageId === pending.message.id)).toHaveLength(1)
  expect(saved.filter(event => event.type === 'turn/start')).toHaveLength(1)
})

it('keeps renewal tied to the original Preset revision even though the old source can be maintained', async () => {
  const test = await setup()
  await startAndSettle(test)
  const candidate = SessionId('dormant-renew-candidate')
  await hold(test, 'dormant-renew', candidate)
  await test.removePreset()
  await test.ctx.agentPresets.register(changedPreset)
  if (test.member.preset === undefined) throw new Error('source fixture requires its original Preset')
  const specification = { childId: candidate, provider: 'spawn', label: 'dormant-source', request: { parent: test.lead }, signal }
  await expect(test.ctx.subagents.prepareContinuable({ ...specification, preset: test.member.preset })).rejects.toThrow(/changed/)
  await using current = await test.ctx.agentPresets.acquireComposition('dormant-source')
  if (current.revision === undefined) throw new Error('changed fixture requires its declaration revision')
  await test.ctx.subagents.prepareContinuable({ ...specification, preset: { id: 'dormant-source', revision: current.revision } })
  await expect(test.owner.commit(test.lead, test.member.id, 'dormant-renew', record('dormant-renew:commit'), () => []))
    .rejects.toMatchObject({ code: 'TEAM_PRESET_UNAVAILABLE' })
  expect(test.owner.read(test.lead, test.member.id)).toMatchObject({ control: { held: true },
    execution: { executionId: test.member.id, generation: 1 } })
  expect(test.adapter.requests).toHaveLength(test.modelBaseline.count)
})

it('supplies repaired unknown effects to the stored blocker reader and retains the member hold', async () => {
  const test = await setup()
  await startAndSettle(test)
  const callId = ToolCallId('member-unconfirmed-operation')
  await appendSource(test, (source) => {
    source.append('turn/start', { turn: 2 })
    source.append('step/start', { turn: 2, step: 1 })
    source.append('assistant/message', { turn: 2, step: 1, stream: [], message: createMessage({ role: 'assistant',
      source: { kind: 'model', provider: 'mock', model: 'mock' },
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }] }) }, { surfaceOp: 'append' })
    source.append('tool/call', { turn: 2, step: 1, callId, name: 'bash', arguments: '{}' })
  })
  await hold(test, 'unknown-effect')
  await test.removePreset()
  await expect(test.owner.captureCurrent(test.lead, test.member.id, 'unknown-effect', signal, (_id, stored) => {
    expect(stored?.events.some(event => event.type === 'tool/result' && event.data.error?.code === TOOL_OUTCOME_UNKNOWN)).toBe(true)
    return ['unconfirmed original operation']
  })).rejects.toMatchObject({ code: 'TEAM_MEMBER_BLOCKED' })
  expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
  expect(test.adapter.requests).toHaveLength(test.modelBaseline.count)
  expect((await events(test)).filter(event => event.type === 'tool/result' && event.data.error?.code === TOOL_OUTCOME_UNKNOWN)).toHaveLength(1)
})

it.each(['missing', 'corrupt'] as const)('refuses an already created source whose storage is %s instead of treating it as unstarted', async (kind) => {
  const test = await setup()
  await startAndSettle(test)
  await hold(test, 'unavailable-source')
  const directory = join(test.resources.root, '_no-cwd', test.member.id)
  const parked = join(test.resources.root, 'parked-dormant-source')
  expect(existsSync(directory)).toBe(true)
  const name = readdirSync(directory).find(value => /\.jsonl(?:\.zstd)?$/u.test(value))
  if (name === undefined) throw new Error('source fixture has no JSONL log')
  const path = join(directory, name)
  const before = readFileSync(path)
  if (kind === 'missing') renameSync(directory, parked)
  else writeFileSync(path, 'invalid persisted source log\n')
  try {
    await expect(test.owner.captureCurrent(test.lead, test.member.id, 'unavailable-source')).rejects.toThrow()
    await expect(test.owner.release(test.lead, test.member.id, 'unavailable-source', record('unavailable-source:released'), () => [])).rejects.toThrow()
    expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
    expect(test.adapter.requests).toHaveLength(test.modelBaseline.count)
  } finally {
    if (kind === 'missing') renameSync(parked, directory)
    else writeFileSync(path, before)
  }
})

it('uses real maintenance for a resident execution while leaving the Team lock available', async () => {
  const test = await setup()
  await hold(test, 'resident-source')
  if (test.member.preset === undefined) throw new Error('source fixture requires its Preset')
  await test.ctx.subagents.prepareContinuable({ childId: test.member.id, provider: 'spawn', label: 'dormant-source', preset: test.member.preset,
    request: { parent: test.lead }, signal })
  const entered = gate(), exit = gate()
  const occupied = test.ctx.subagents.withContinuableExecution(test.lead, test.member.id, signal, async (execution) => {
    expect(execution.status).toBe('idle')
    entered.resolve()
    await exit.promise
  })
  await entered.promise
  const dormant = vi.spyOn(test.ctx.subagents, 'withDormantContinuable')
  let inspected = false
  const releasing = test.owner.release(test.lead, test.member.id, 'resident-source', record('resident-source:released'), (_id, stored) => {
    expect(stored).toBeUndefined()
    const execution = test.ctx.agents.get(test.member.id)
    if (execution === undefined) throw new Error('resident source disappeared before its maintenance reader')
    expect(() => execution.runMaintenance(async () => {})).toThrow(/active work/)
    inspected = true
    return []
  })
  try {
    expect(await test.ctx.agentTeams.readCompositionLocked(test.lead, cut => cut.composition.phase)).toBe('dynamic')
    expect(inspected).toBe(false)
    exit.resolve()
    await occupied
    await releasing
    expect(dormant).not.toHaveBeenCalled()
    expect(inspected).toBe(true)
  } finally { exit.resolve(); await Promise.allSettled([occupied, releasing]) }
})

it('blocks held member writes during requested Lead coordination and lets the ready replacement Lead finish safe cleanup', async () => {
  const test = await leadCoordinatorHarness()
  vi.spyOn(test.ctx.sessionQuery, 'observeSession').mockImplementation((id, options) =>
    SessionQuery.prototype.observeSession.call(test.ctx.sessionQuery, id, options))
  test.writer.dispose()
  const unavailable = async (): Promise<never> => { throw new Error('Task commands are outside this test') }
  test.ctx.agentTeams.installTaskExtension({ id: facadeControlledMode.requiredTaskExtensionId, validateMemberGroup: () => undefined,
    planLeadRelease: () => '{}', create: unavailable, update: unavailable })
  const memberOwner = test.ctx.agentTeams.installMemberExecutions({ id: 'handoff-dormant-owner' })
  const member = (await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'handoff-held-member', context: 'fresh', provider: 'spawn',
    presetId: 'standard', prompt: text('Unused registration'), signal })).member
  const candidate = SessionId('handoff-member-candidate')
  await memberOwner.hold(test.lead, { memberId: member.id, operationId: 'before-handoff', expectedGeneration: 1, nextExecutionId: candidate },
    () => record('before-handoff:hold'))
  if (member.preset === undefined) throw new Error('member fixture requires its Preset')
  await test.ctx.subagents.prepareContinuable({ childId: candidate, provider: 'spawn', label: 'standard', preset: member.preset,
    request: { parent: test.lead }, signal })
  await test.stage('requested')
  for (const action of [() => memberOwner.record(test.lead, member.id, 'before-handoff', record('before-handoff:progress')),
    () => memberOwner.commit(test.lead, member.id, 'before-handoff', record('before-handoff:commit'), () => []),
    () => memberOwner.release(test.lead, member.id, 'before-handoff', record('before-handoff:stop'), () => [])]) {
    await expect(action()).rejects.toThrow()
  }
  expect(memberOwner.read(test.lead, member.id).control?.held).toBe(true)
  const next = await test.create('new-lead-cleans-member', 2)
  await test.stage('frozen')
  await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
    await safe.record({ recordId: 'handoff-member:prepared', dataJson: '{}' }, true)
    await safe.commitLeadTransaction({ binding: test.binding(next.agent), releases: [], record: { recordId: 'handoff-member:commit', dataJson: '{}' } })
  })
  await expect(memberOwner.release(next.agent, member.id, 'before-handoff', record('before-handoff:stop'), () => [])).rejects.toThrow()
  await test.stage('ready')
  await memberOwner.release(next.agent, member.id, 'before-handoff', record('before-handoff:stop'), () => [])
  expect(memberOwner.read(next.agent, member.id).control?.held).toBe(false)
  expect(test.adapter.requests).toHaveLength(0)
})

it('checks the original direct parent before repairing a foreign member source', async () => {
  const test = await setup()
  await hold(test, 'foreign-source')
  const source = test.ctx.sessions.prepare(test.member.id, { meta: { parentSession: SessionId('another-Team'), origin: 'subagent' } })
  source.append('agent/input/controller-bound', { version: 1, controllerId: InputControllerId('dormant-member-owner/input') })
  source.append('subagent/descriptor', snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: 'another-Team member' }))
  source.append('turn/start', { turn: 1 })
  const write = await test.ctx.sessionPersistence.create(source.header)
  try { await write.append(source.snapshotEvents()); await write.flush() }
  finally { await write.close() }
  const before = await events(test)
  await expect(test.owner.captureCurrent(test.lead, test.member.id, 'foreign-source')).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await expect(test.owner.release(test.lead, test.member.id, 'foreign-source', record('foreign-source:release'), () => []))
    .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  expect(await events(test)).toEqual(before)
  expect(before.some(event => event.type === 'turn/end')).toBe(false)
  expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
  expect(test.adapter.requests).toHaveLength(0)
})

it('rechecks Lead coordination after a stored blocker wait before capturing any input', async () => {
  const test = await setup()
  await startAndSettle(test)
  const pending: AgentInput = { message: createUserMessage({ source: { kind: 'user' }, content: text('Must remain pending') }),
    target: 'next-turn', wakeup: true }
  await appendSource(test, (source) => {
    source.append('agent/inbox/spliced', { target: pending.target, start: 0, inserted: [pending.message], wakeup: pending.wakeup })
  })
  await hold(test, 'capture-before-handoff')
  const coordinator = test.ctx.agentTeams.installLeadCoordinator({ id: 'capture-handoff-coordinator' })
  const entered = gate(), release = gate()
  const capturing = test.owner.captureCurrent(test.lead, test.member.id, 'capture-before-handoff', signal, async () => {
    entered.resolve()
    await release.promise
    return []
  })
  const outcome = capturing.then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await entered.promise
    await coordinator.record(test.lead, { operationId: TeamLeadOperationId('capture-handoff'), previousTerm: 1,
      phase: 'requested', recordId: 'capture-handoff:requested', dataJson: '{}' })
    release.resolve()
    expect(await outcome).toHaveProperty('error')
    expect((await events(test)).some(event => event.type === 'agent/input/held' && event.data.input.message.id === pending.message.id)).toBe(false)
    expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
    expect(test.adapter.requests).toHaveLength(test.modelBaseline.count)
  } finally { release.resolve(); await outcome }
})

it('refuses release when an originally present dormant source disappears during blocker inspection', async () => {
  const test = await setup()
  await startAndSettle(test)
  await hold(test, 'disappearing-source')
  const entered = gate(), release = gate()
  const changing = test.owner.release(test.lead, test.member.id, 'disappearing-source', record('disappearing-source:release'), async (_id, stored) => {
    expect(stored?.header.id).toBe(test.member.id)
    entered.resolve()
    await release.promise
    return []
  })
  const outcome = changing.then(() => ({ accepted: true }), (error: unknown) => ({ error }))
  const directory = join(test.resources.root, '_no-cwd', test.member.id)
  const parked = join(test.resources.root, 'disappeared-during-inspection')
  await entered.promise
  renameSync(directory, parked)
  try {
    release.resolve()
    expect(await outcome).toHaveProperty('error')
    expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
    expect(test.lead.session.snapshotEvents().some(event => event.type === 'team/member/control'
      && event.data.record.recordId === 'disappearing-source:release')).toBe(false)
    expect(test.adapter.requests).toHaveLength(test.modelBaseline.count)
  } finally { release.resolve(); renameSync(parked, directory); await outcome }
})

it('rechecks the held candidate after a stored blocker wait without capturing pending input', async () => {
  const test = await setup()
  await startAndSettle(test)
  const before = SessionId('stored-capture-old-candidate'), after = SessionId('stored-capture-new-candidate')
  const pending: AgentInput = { message: createUserMessage({ source: { kind: 'user' }, content: text('Not captured by an obsolete plan') }),
    target: 'next-turn', wakeup: true }
  await appendSource(test, (source) => {
    source.append('agent/inbox/spliced', { target: pending.target, start: 0, inserted: [pending.message], wakeup: pending.wakeup })
  })
  await hold(test, 'stored-capture-change', before)
  await expect(test.owner.captureCurrent(test.lead, test.member.id, 'stored-capture-change', signal, async () => {
    await test.owner.retarget(test.lead, test.member.id, 'stored-capture-change', before, after, record('stored-capture-change:target'), () => [])
    return []
  })).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  expect((await events(test)).some(event => event.type === 'agent/input/held' && event.data.input.message.id === pending.message.id)).toBe(false)
  expect(test.owner.read(test.lead, test.member.id).control?.nextExecutionId).toBe(after)
})

it('refuses a nonempty input disposition for an uncreated member rather than treating the input as settled', async () => {
  const test = await setup()
  await hold(test, 'uncreated-disposition')
  await expect(test.owner.releaseCaptured(test.lead, test.member.id, 'uncreated-disposition', [MessageId('unrecorded-input')],
    record('uncreated-disposition:attempt'))).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  expect(await test.ctx.sessionPersistence.stat(test.member.id)).toBeUndefined()
  expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
  expect(test.adapter.requests).toHaveLength(0)
})

it('cancels a stored capture whose blocker reader never settles without abandoning the original writer', async () => {
  const test = await setup()
  await startAndSettle(test)
  await hold(test, 'bounded-stored-capture')
  const entered = gate()
  const abort = new AbortController()
  const capturing = test.owner.captureCurrent(test.lead, test.member.id, 'bounded-stored-capture', abort.signal, () => {
    entered.resolve()
    return new Promise<readonly string[]>(() => {})
  })
  const outcome = capturing.then(value => ({ value }), (error: unknown) => ({ error }))
  await entered.promise
  abort.abort(new Error('bounded capture aborted'))
  const settled = await outcome
  if (!('error' in settled)) throw new Error('cancelled capture was acknowledged')
  expect(settled.error).toMatchObject({ message: 'bounded capture aborted' })
  expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
  expect((await events(test)).some(event => event.type === 'agent/input/held')).toBe(false)
  const writer = await test.ctx.sessionPersistence.open(test.member.id, 'write')
  await writer.close()
  expect(test.adapter.requests).toHaveLength(test.modelBaseline.count)
})

it('stops subsequent input releases when Lead coordination takes over between two confirmed custody effects', async () => {
  const test = await setup()
  await startAndSettle(test)
  const first: AgentInput = { message: createUserMessage({ source: { kind: 'user' }, content: text('First original input') }),
    target: 'next-turn', wakeup: true }
  const second: AgentInput = { message: createUserMessage({ source: { kind: 'user' }, content: text('Second original input') }),
    target: 'next-turn', wakeup: true }
  await appendSource(test, (source) => {
    source.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [first.message, second.message], wakeup: true })
  })
  await hold(test, 'two-input-disposition')
  expect(await test.owner.captureCurrent(test.lead, test.member.id, 'two-input-disposition')).toEqual([first, second])
  const coordinator = test.ctx.agentTeams.installLeadCoordinator({ id: 'two-input-handoff-coordinator' })
  const entered = gate(), release = gate()
  const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
  let paused = false
  const opening = vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[0] === test.member.id && args[1] === 'write') {
      const flush = handle.flush.bind(handle)
      vi.spyOn(handle, 'flush').mockImplementation(async (...options) => {
        const snapshot = await handle.read()
        if (!paused && snapshot.events.some(event => event.type === 'agent/input/released' && event.data.messageId === first.message.id)) {
          paused = true
          entered.resolve()
          await release.promise
        }
        return flush(...options)
      })
    }
    return handle
  })
  const changing = test.owner.releaseCaptured(test.lead, test.member.id, 'two-input-disposition', [first.message.id, second.message.id],
    record('two-input-disposition:release'))
  const outcome = changing.then(() => ({ accepted: true }), (error: unknown) => ({ error }))
  try {
    await entered.promise
    const requesting = coordinator.record(test.lead, { operationId: TeamLeadOperationId('two-input-handoff'), previousTerm: 1,
      phase: 'requested', recordId: 'two-input-handoff:requested', dataJson: '{}' })
    await Promise.resolve()
    release.resolve()
    await requesting
    expect(await outcome).toHaveProperty('error')
    const released = (await events(test)).flatMap(event => event.type === 'agent/input/released' ? [event.data.messageId] : [])
    expect(released).toEqual([first.message.id])
    expect(test.owner.read(test.lead, test.member.id).control?.held).toBe(true)
    expect(test.adapter.requests).toHaveLength(test.modelBaseline.count)
  } finally { release.resolve(); opening.mockRestore(); await outcome }
})
