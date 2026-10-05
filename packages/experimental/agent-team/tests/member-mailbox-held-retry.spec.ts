/** Real controlled continuation custody is retried only for the mailbox's exact unacknowledged admission hold. */
import type { Agent, AgentInput, InputControllerHandle } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContinuableInputCustodyScope } from '@deepseek-ai/dsh-subagent'
import { expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { TeamId, TeamTaskId } from '../src/index.ts'
import type { TeamMessageSnapshot } from '../src/index.ts'
import type { TeamJournal } from '../src/journal.ts'
import type { TeamMemberExecutions } from '../src/member-runtime.ts'
import type { TeamMailbox } from '../src/mailbox.ts'
import { facadeControlledMode, nativeFacadeHarness } from './native-facade-harness.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const signal = new AbortController().signal
const text = (value: string) => [{ type: 'text' as const, text: value }]

async function setup(taskWork = false) {
  const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode, messageRetryDelayMs: 2_000 },
    script: Array.from({ length: 8 }, () => textResponse('Actual controlled coordination received')) })
  vi.spyOn(test.ctx.sessionQuery, 'observeSession').mockImplementation((id, options) =>
    SessionQuery.prototype.observeSession.call(test.ctx.sessionQuery, id, options))
  const unavailable = async (): Promise<never> => { throw new Error('model Task mutations are outside this mailbox test') }
  const writer = test.ctx.agentTeams.installTaskExtension({ id: facadeControlledMode.requiredTaskExtensionId,
    requireDurableAcknowledgement: true, validateMemberGroup: () => undefined,
    assessSettlementNotice: () => 'suppress', create: unavailable, update: unavailable,
    classifyInput: (anchor, input: AgentInput) => {
      if (!taskWork || input.message.source.kind !== 'team-message') return undefined
      const source = input.message.source
      const queued = test.ctx.sessionProjections.stateOf(anchor.session, 'agentTeam')?.messages.find(message =>
        message.id === source.messageId && message.senderId === source.senderId)
      return source.teamId === TeamId(test.lead.id) && queued !== undefined
        ? { taskId: TeamTaskId('task-1'), current: true } : undefined
    } })
  const owner = test.ctx.agentTeams.installMemberExecutions({ id: 'mailbox-retry-owner' })
  const removeMemberPreset = await test.ctx.agentPresets.register({ id: 'mailbox-member-standard', plugins: [] })
  const member = (await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'mailbox-retry-member', context: 'fresh',
    provider: 'spawn', presetId: 'mailbox-member-standard', prompt: [], signal })).member
  if (taskWork) await writer.commit(test.lead, () => ({ updates: [{ previousRevision: null,
    task: { id: TeamTaskId('task-1'), revision: 1, subject: 'Exact queued assignment', description: 'Mailbox final admission',
      status: 'in_progress', ownerId: member.id, blockedBy: [], writeScopes: [] } }], dataJson: '{}' }))
  const runtime = Reflect.get(test.ctx.agentTeams, 'memberExecutions') as TeamMemberExecutions
  const input = Reflect.get(runtime, 'input') as InputControllerHandle
  const mailbox = Reflect.get(test.ctx.agentTeams, 'mailbox') as TeamMailbox
  const warnings = vi.spyOn(test.ctx.logger, 'warn')
  const state = () => {
    const current = test.ctx.sessionProjections.stateOf(test.lead.session, 'agentTeam')
    if (current === undefined || current.failure !== undefined) throw new Error('the actual Team projection must remain valid')
    return current
  }
  return { ...test, owner, writer, member, runtime, input, mailbox, state, warnings, removeMemberPreset }
}
type Harness = Awaited<ReturnType<typeof setup>>

/** A real hold wins between mailbox admission and actual continuation receipt. */
async function admissionHeld(test: Harness) {
  const requestsBefore = test.adapter.requests.length
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  const original = test.ctx.subagents.deliverContinuableInput.bind(test.ctx.subagents)
  let first = true
  const delivery = vi.spyOn(test.ctx.subagents, 'deliverContinuableInput').mockImplementation(async (...args) => {
    if (first) { first = false; entered.resolve(undefined); await resume.promise }
    return await original(...args)
  })
  const sending = test.ctx.agentTeams.sendMessage(test.lead, { target: test.member.name,
    content: text('Exact still-queued native message'), signal })
  await entered.promise
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'held-for-mail-retry', expectedGeneration: 1 },
    () => ({ recordId: 'held-for-mail-retry', dataJson: '{}' }))
  resume.resolve(undefined)
  const queued = await sending
  delivery.mockRestore()
  expect(queued.status).toBe('queued')
  const message = test.state().messages.find(message => message.id === queued.messageId)
  if (message === undefined || test.member.preset === undefined) throw new Error('queued member input needs actual native facts')
  const execution = test.ctx.agents.get(test.member.id)
  if (execution === undefined) throw new Error('the real continuation must retain its unconsumed input')
  const source = test.ctx.agents.inputControlState(execution.session).records.find(record =>
    record.input.message.id === MessageId(message.id))
  expect(source).toMatchObject({ location: 'held' })
  expect(source?.captured).not.toBe(true)
  expect(test.state().delivered).not.toContain(message.id)
  expect(test.state().cancelled.some(record => record.messageId === message.id)).toBe(false)
  expect(test.adapter.requests).toHaveLength(requestsBefore)
  expect(JSON.stringify(test.adapter.requests)).not.toContain('Exact still-queued native message')
  return { message, execution, material: source!.input, requestsBefore }
}

function sourceRecord(test: Harness, execution: Agent, message: TeamMessageSnapshot) {
  return test.ctx.agents.inputControlState(execution.session).records.find(record => record.input.message.id === MessageId(message.id))
}

function currentSourceRecord(test: Harness, message: TeamMessageSnapshot) {
  const session = test.ctx.sessions.get(test.member.id)
  return session === undefined ? undefined : test.ctx.agents.inputControlState(session).records.find(record =>
    record.input.message.id === MessageId(message.id))
}

async function deliveryReceiptCount(test: Harness, message: TeamMessageSnapshot) {
  using stored = await test.ctx.sessionQuery.observeSession(test.lead.id)
  return stored.events.filter(event => (event.type === 'team/message/delivered' || event.type === 'team/message/member-delivered')
    && event.data.messageId === message.id).length
}

async function setTaskBlocked(test: Harness, blocked: boolean, beforeCommit?: () => void) {
  await test.writer.commit(test.lead, (snapshot) => {
    const task = snapshot.tasks.find(task => task.id === TeamTaskId('task-1'))
    if (task === undefined) throw new Error('the actual mailbox Task must exist')
    const { dispatchBlocked: _old, ...current } = task
    beforeCommit?.()
    return { updates: [{ previousRevision: task.revision, task: { ...current, revision: task.revision + 1,
      ...blocked ? { dispatchBlocked: true as const } : {} } }], dataJson: '{}' }
  })
}

/** Delay entry to the actual journal lock, leaving other real transactions free to win. */
function beforeRootDecision(test: Harness) {
  const journal = Reflect.get(test.ctx.agentTeams, 'journal') as TeamJournal
  const original = journal.transact.bind(journal)
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  let first = true, armed = false
  const transaction = vi.spyOn(journal, 'transact').mockImplementation(async <T>(id: SessionId, operation: () => Promise<T>): Promise<T> => {
    if (armed && first) { first = false; entered.resolve(undefined); await resume.promise }
    return await original(id, operation)
  })
  return { entered, resume, transaction, arm: () => { armed = true } }
}

it('does not restore a held member-control input or a wrong target, then retries the same ID once after release', async () => {
  const test = await setup()
  const { message, execution, requestsBefore } = await admissionHeld(test)
  try {
    const before = execution.session.seq
    await test.runtime.restoreMailboxHeld(test.lead, test.member.id, message.id, signal)
    await test.runtime.restoreMailboxHeld(test.lead, test.lead.id, message.id, signal)
    expect(execution.session.seq).toBe(before)
    expect(sourceRecord(test, execution, message)?.location).toBe('held')
    await test.owner.release(test.lead, test.member.id, 'held-for-mail-retry', { recordId: 'mail-admission-released', dataJson: '{}' }, () => [])
    await test.mailbox.recoverFor(test.lead, signal)
    await vi.waitFor(() => { expect(test.state().delivered, JSON.stringify(test.warnings.mock.calls)).toContain(message.id) })
    await test.ctx.agents.get(execution.id)?.whenIdle()
    expect(await deliveryReceiptCount(test, message)).toBe(1)
    expect(test.adapter.requests).toHaveLength(requestsBefore + 1)
    await test.runtime.restoreMailboxHeld(test.lead, test.member.id, message.id, signal)
    expect(await deliveryReceiptCount(test, message)).toBe(1)
    using stored = await test.ctx.sessionQuery.observeSession(execution.id)
    expect(stored.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'team-message'
      && event.data.source.messageId === message.id)).toHaveLength(1)
  } finally { test.writer.dispose(); await test.owner.dispose() }
})

it.each(['false', 'throw'] as const)('does not ACK a retry when its actual source preload checkpoint returns %s', async (failure) => {
  const test = await setup()
  const { message, execution, requestsBefore } = await admissionHeld(test)
  const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
  let failing = true
  const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
    const source = test.ctx.agents.inputControlState(session).records.find(record => record.input.message.id === MessageId(message.id))
    if (failing && session.id === execution.id && source?.location === 'inbox') {
      if (failure === 'throw') throw new Error('actual mailbox source preload failed')
      return false
    }
    return await original(session)
  })
  try {
    await test.owner.release(test.lead, test.member.id, 'held-for-mail-retry', { recordId: 'mail-release-before-source-checkpoint', dataJson: '{}' }, () => [])
    await test.mailbox.recoverFor(test.lead, signal)
    await vi.waitFor(() => { expect(currentSourceRecord(test, message)?.location).toBe('inbox') })
    expect(test.state().delivered).not.toContain(message.id)
    expect(await deliveryReceiptCount(test, message)).toBe(0)
    expect(test.adapter.requests).toHaveLength(requestsBefore)
    failing = false
    await test.writer.commitRecord(test.lead, () => ({ recordId: 'explicit-same-ID-retry', dataJson: '{}' }))
    await test.mailbox.recoverFor(test.lead, signal)
    await vi.waitFor(() => { expect(test.state().delivered).toContain(message.id) })
    await test.ctx.agents.get(execution.id)?.whenIdle()
    expect(await deliveryReceiptCount(test, message)).toBe(1)
    using stored = await test.ctx.sessionQuery.observeSession(execution.id)
    expect(stored.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'team-message'
      && event.data.source.messageId === message.id)).toHaveLength(1)
  } finally { flush.mockRestore(); test.writer.dispose(); await test.owner.dispose() }
})

it('never restores genuine captured custody or explicitly released input on a mailbox retry', async () => {
  const test = await setup()
  const { message, execution, material, requestsBefore } = await admissionHeld(test)
  try {
    await test.input.preload(execution, material)
    await test.input.holdPending(execution, [material.message.id])
    expect(sourceRecord(test, execution, message)).toMatchObject({ location: 'held', captured: true })
    await test.owner.release(test.lead, test.member.id, 'held-for-mail-retry', { recordId: 'captured-source-release', dataJson: '{}' }, () => [])
    await test.runtime.restoreMailboxHeld(test.lead, test.member.id, message.id, signal)
    expect(sourceRecord(test, execution, message)).toMatchObject({ location: 'held', captured: true })
    expect(test.state().delivered).not.toContain(message.id)
    await test.input.release(execution, material.message.id)
    const before = execution.session.seq
    await test.runtime.restoreMailboxHeld(test.lead, test.member.id, message.id, signal)
    expect(execution.session.seq).toBe(before)
    expect(sourceRecord(test, execution, message)?.location).toBe('released')
    await test.mailbox.recoverFor(test.lead, signal)
    expect(test.state().delivered).not.toContain(message.id)
    expect(test.adapter.requests).toHaveLength(requestsBefore)
  } finally { test.writer.dispose(); await test.owner.dispose() }
})

it('leaves the exact source held while the real member release maintenance owns it', async () => {
  const test = await setup()
  const { message, execution } = await admissionHeld(test)
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  const release = test.owner.release(test.lead, test.member.id, 'held-for-mail-retry',
    { recordId: 'mail-occupied-release', dataJson: '{}' }, async () => {
      entered.resolve(undefined)
      await resume.promise
      return []
    })
  try {
    await entered.promise
    expect(test.runtime.admitted(test.lead, test.member.id)).toBe(false)
    const before = execution.session.seq
    await test.runtime.restoreMailboxHeld(test.lead, test.member.id, message.id, signal)
    expect(execution.session.seq).toBe(before)
    expect(sourceRecord(test, execution, message)).toMatchObject({ location: 'held' })
    expect(test.state().delivered).not.toContain(message.id)
  } finally {
    resume.resolve(undefined)
    await release
    test.writer.dispose(); await test.owner.dispose()
  }
})

it('leaves a source held while the Root checkpoint is unconfirmed, without acknowledging the queued message', async () => {
  const test = await setup()
  const { message, execution } = await admissionHeld(test)
  try {
    await test.owner.release(test.lead, test.member.id, 'held-for-mail-retry',
      { recordId: 'mail-release-before-root-checkpoint', dataJson: '{}' }, () => [])
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    try {
      await expect(test.writer.commitRecord(test.lead, () => ({ recordId: 'root-unconfirmed-mail', dataJson: '{}' })))
        .rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
      expect(test.state().extensionRecords.some(record => record.recordId === 'root-unconfirmed-mail')).toBe(true)
      expect(test.writer.recordsConfirmed(test.lead)).toBe(false)
      const before = execution.session.seq
      await test.runtime.restoreMailboxHeld(test.lead, test.member.id, message.id, signal)
      expect(execution.session.seq).toBe(before)
      expect(sourceRecord(test, execution, message)).toMatchObject({ location: 'held' })
      expect(test.state().delivered).not.toContain(message.id)
    } finally { flush.mockRestore() }
  } finally { test.writer.dispose(); await test.owner.dispose() }
})

it('does not restore an exact queued input after that native message was cancelled', async () => {
  const test = await setup()
  const { message, execution } = await admissionHeld(test)
  try {
    await test.ctx.agentTeams.cancelPendingMessages(test.lead, test.member.name, 'This exact message is no longer requested', [message.id])
    expect(test.state().cancelled.some(record => record.messageId === message.id)).toBe(true)
    const before = execution.session.seq
    await test.runtime.restoreMailboxHeld(test.lead, test.member.id, message.id, signal)
    expect(execution.session.seq).toBe(before)
    expect(sourceRecord(test, execution, message)).toMatchObject({ location: 'held' })
    expect(test.state().delivered).not.toContain(message.id)
  } finally { test.writer.dispose(); await test.owner.dispose() }
})

it('does not restore admission custody after its real input owner has been disposed', async () => {
  const test = await setup()
  const { message, execution } = await admissionHeld(test)
  try {
    await test.owner.dispose()
    const before = execution.session.seq
    await test.runtime.restoreMailboxHeld(test.lead, test.member.id, message.id, signal)
    expect(execution.session.seq).toBe(before)
    expect(sourceRecord(test, execution, message)).toMatchObject({ location: 'held' })
    expect(test.state().delivered).not.toContain(message.id)
    expect(test.adapter.requests).toHaveLength(0)
  } finally { test.writer.dispose(); await test.owner.dispose() }
})

it('rechecks member admission after real continuation custody acquisition before restoring the exact source', async () => {
  const test = await setup()
  const { message, execution } = await admissionHeld(test)
  await test.owner.release(test.lead, test.member.id, 'held-for-mail-retry',
    { recordId: 'mail-before-custody-CAS-release', dataJson: '{}' }, () => [])
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  const original = test.ctx.subagents.withContinuableInputCustody.bind(test.ctx.subagents)
  let first = true
  const acquire = vi.spyOn(test.ctx.subagents, 'withContinuableInputCustody').mockImplementation(async <T>(
    parent: Agent, childId: SessionId, input: InputControllerHandle, incoming: AbortSignal,
    callback: (scope: ContinuableInputCustodyScope) => Promise<T>,
  ): Promise<T> => {
    if (first) { first = false; entered.resolve(undefined); await resume.promise }
    return await original(parent, childId, input, incoming, callback)
  })
  const restoring = test.runtime.restoreMailboxHeld(test.lead, test.member.id, message.id, signal)
  try {
    await entered.promise
    await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'held-after-custody-preview', expectedGeneration: 1 },
      () => ({ recordId: 'held-after-custody-preview', dataJson: '{}' }))
    resume.resolve(undefined)
    await restoring
    using stored = await test.ctx.sessionQuery.observeSession(execution.id)
    expect(stored.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(input => input.id === MessageId(message.id)))).toBe(false)
    expect(test.state().delivered).not.toContain(message.id)
    expect(test.adapter.requests).toHaveLength(0)
    await test.owner.release(test.lead, test.member.id, 'held-after-custody-preview',
      { recordId: 'mail-after-custody-CAS-release', dataJson: '{}' }, () => [])
    await test.mailbox.recoverFor(test.lead, signal)
    await vi.waitFor(() => { expect(test.state().delivered).toContain(message.id) })
    expect(await deliveryReceiptCount(test, message)).toBe(1)
  } finally {
    resume.resolve(undefined); await restoring; acquire.mockRestore()
    test.writer.dispose(); await test.owner.dispose()
  }
})

it('does not restore an exact queued source after its never-started recipient fails a real missing-Preset check', async () => {
  const test = await setup()
  const { message, execution } = await admissionHeld(test)
  try {
    await test.owner.release(test.lead, test.member.id, 'held-for-mail-retry',
      { recordId: 'mail-before-missing-Preset-release', dataJson: '{}' }, () => [])
    await test.removeMemberPreset()
    await test.mailbox.recoverFor(test.lead, signal)
    expect(test.state().members.find(member => member.id === test.member.id)?.phase).toBe('failed')
    expect(test.state().cancelled.some(record => record.messageId === message.id)).toBe(false)
    expect(test.state().delivered).not.toContain(message.id)
    await test.runtime.restoreMailboxHeld(test.lead, test.member.id, message.id, signal)
    using stored = await test.ctx.sessionQuery.observeSession(execution.id)
    expect(stored.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(input => input.id === MessageId(message.id)))).toBe(false)
    expect(stored.events.some(event => event.type === 'user/message' || event.type === 'request/header')).toBe(false)
    expect(await deliveryReceiptCount(test, message)).toBe(0)
  } finally { test.writer.dispose(); await test.owner.dispose() }
})

it('rechecks the real Task under the Root lock and does not cancel work that became schedulable', async () => {
  const test = await setup(true)
  const { message, execution } = await admissionHeld(test)
  await test.owner.release(test.lead, test.member.id, 'held-for-mail-retry',
    { recordId: 'mail-before-Task-CAS-release', dataJson: '{}' }, () => [])
  const gate = beforeRootDecision(test)
  let pending: readonly Promise<unknown>[] = []
  try {
    await setTaskBlocked(test, true, gate.arm)
    await gate.entered.promise
    pending = test.mailbox.pendingDispatches()
    await setTaskBlocked(test, false)
    await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'held-at-Task-CAS', expectedGeneration: 1 },
      () => ({ recordId: 'held-at-Task-CAS', dataJson: '{}' }))
    gate.resume.resolve(undefined)
    await Promise.all(pending)
    expect(test.state().cancelled.some(record => record.messageId === message.id)).toBe(false)
    expect(test.state().delivered).not.toContain(message.id)
    expect(sourceRecord(test, execution, message)).toMatchObject({ location: 'held' })
    await test.owner.release(test.lead, test.member.id, 'held-at-Task-CAS',
      { recordId: 'mail-after-Task-CAS-release', dataJson: '{}' }, () => [])
    await test.mailbox.recoverFor(test.lead, signal)
    await vi.waitFor(() => { expect(test.state().delivered).toContain(message.id) })
    expect(await deliveryReceiptCount(test, message)).toBe(1)
  } finally {
    gate.resume.resolve(undefined); await Promise.all(pending); gate.transaction.mockRestore()
    test.writer.dispose(); await test.owner.dispose()
  }
})

it('rechecks Root durability under the actual cancellation lock and keeps the exact message recoverable', async () => {
  const test = await setup(true)
  const { message, execution } = await admissionHeld(test)
  await test.owner.release(test.lead, test.member.id, 'held-for-mail-retry',
    { recordId: 'mail-before-root-CAS-release', dataJson: '{}' }, () => [])
  const gate = beforeRootDecision(test)
  let pending: readonly Promise<unknown>[] = []
  let checkpoint: MockInstance<typeof test.ctx.sessions.flush> | undefined
  try {
    await setTaskBlocked(test, true, gate.arm)
    await gate.entered.promise
    pending = test.mailbox.pendingDispatches()
    checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(test.writer.commitRecord(test.lead, () => ({ recordId: 'mail-lock-root-unconfirmed', dataJson: '{}' })))
      .rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
    expect(test.writer.recordsConfirmed(test.lead)).toBe(false)
    gate.resume.resolve(undefined)
    await Promise.all(pending)
    expect(test.state().cancelled.some(record => record.messageId === message.id)).toBe(false)
    expect(test.state().delivered).not.toContain(message.id)
    expect(sourceRecord(test, execution, message)).toMatchObject({ location: 'held' })
    checkpoint.mockRestore(); checkpoint = undefined
    // This real Task transaction confirms the prior write and restores work under the same Root lock.
    await setTaskBlocked(test, false)
    expect(test.writer.recordsConfirmed(test.lead)).toBe(true)
    await test.mailbox.recoverFor(test.lead, signal)
    await vi.waitFor(() => { expect(test.state().delivered).toContain(message.id) })
    expect(test.state().cancelled.some(record => record.messageId === message.id)).toBe(false)
    expect(await deliveryReceiptCount(test, message)).toBe(1)
  } finally {
    gate.resume.resolve(undefined); await Promise.all(pending); gate.transaction.mockRestore(); checkpoint?.mockRestore()
    test.writer.dispose(); await test.owner.dispose()
  }
})
