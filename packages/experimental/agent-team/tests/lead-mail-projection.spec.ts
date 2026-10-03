import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { teamProjectionDefinition } from '../src/projection.ts'
import { TeamId, TeamMessageId, TeamTaskId } from '../src/types.ts'
import type { TeamMessageSnapshot } from '../src/types.ts'

const ROOT = SessionId('mail-projection-root')
const TEAM = TeamId(ROOT)
const mode: SessionEvent<'team/mode'> = { type: 'team/mode', seq: SessionSeq(0), time: 0,
  data: { version: 1, teamId: TEAM, mode: { kind: 'controlled', requiredTaskExtensionId: 'writer',
    permissionTableId: 'permissions', permissionRevision: 'revision' } } }

function event<T extends Extract<SessionEventType, `team/${string}`>>(type: T, data: SessionEventMap[T]): SessionEvent<T> {
  return { type, data, seq: SessionSeq(1), time: 1 } as SessionEvent<T>
}

function transfer(): TeamMessageSnapshot & { transfer: NonNullable<TeamMessageSnapshot['transfer']> } {
  return { id: TeamMessageId('projected-transfer'), senderId: ROOT, senderName: 'lead', targetId: ROOT, content: [],
    transfer: { sourceExecutionId: ROOT, heldSeq: SessionSeq(4), input: {
      message: { ...createUserMessage({ content: [{ type: 'text', text: 'original user input' }], source: { kind: 'user' } }) },
      target: 'next-step', wakeup: false,
    } } }
}

function project(events: readonly SessionEvent[]) {
  let state = teamProjectionDefinition.init({ version: SESSION_FORMAT_VERSION, id: ROOT, createdAt: 0, isSeeded: false })
  for (const value of events) state = teamProjectionDefinition.apply(state, value)
  return state
}

describe('native Lead mail durable projection', () => {
  it('accepts the implicit initial seat and stores one new receipt in the existing terminal index', () => {
    const message = transfer()
    const queued = event('team/message/input-queued', { version: 1, teamId: TEAM, message })
    const receipt = event('team/message/lead-delivered', { version: 1, teamId: TEAM, messageId: message.id,
      targetId: ROOT, executionId: ROOT, term: 1 })
    const state = project([mode, queued, receipt])
    expect(state.failure).toBeUndefined()
    expect(state.delivered).toEqual([message.id])
    expect(state.leadDeliveries).toEqual([{ messageId: message.id, targetId: ROOT, executionId: ROOT, term: 1 }])
    expect(project([mode, queued, receipt, receipt]).failure).toMatch(/already settled/)
  })

  it('rejects wrong controlled targets, content overlays, old delivery and cancellation for transferred input', () => {
    const message = transfer()
    const queued = event('team/message/input-queued', { version: 1, teamId: TEAM, message })
    expect(project([queued]).failure).toMatch(/controlled logical Lead/)
    for (const changed of [
      { ...message, targetId: SessionId('not-anchor') },
      { ...message, content: [{ type: 'text' as const, text: 'native overlay changes source' }] },
    ]) expect(project([mode, event('team/message/input-queued', { version: 1, teamId: TEAM, message: changed })])
      .failure).toMatch(/controlled logical Lead/)
    expect(project([mode, queued, event('team/message/delivered', { version: 2, teamId: TEAM,
      messageId: message.id, targetId: ROOT })]).failure).toMatch(/one Lead delivery/)
    expect(project([mode, queued, event('team/message/cancelled', { version: 3, teamId: TEAM,
      targetId: ROOT, messageIds: [message.id], reason: 'ordinary cancellation cannot discard custody' })])
      .failure).toMatch(/cannot be cancelled/)
  })

  it('requires a queued logical target and a real historical seat before accepting any receipt', () => {
    const message = transfer()
    const queued = event('team/message/input-queued', { version: 1, teamId: TEAM, message })
    const receipt = event('team/message/lead-delivered', { version: 1, teamId: TEAM, messageId: message.id,
      targetId: ROOT, executionId: ROOT, term: 1 })
    expect(project([receipt]).failure).toMatch(/queued controlled/)
    expect(project([mode, receipt]).failure).toMatch(/queued controlled/)
    const { transfer: _transfer, ...ordinary } = message
    const member = { ...ordinary, targetId: SessionId('member') }
    expect(project([mode, event('team/message/queued', { version: 2, teamId: TEAM, message: member }), receipt])
      .failure).toMatch(/queued controlled/)
    expect(project([mode, queued, { ...receipt, data: { ...receipt.data, targetId: SessionId('member') } }])
      .failure).toMatch(/queued controlled/)
    expect(project([mode, queued, { ...receipt, data: { ...receipt.data, term: 2 } }]).failure).toMatch(/never held/)
    const binding = { executionId: SessionId('projected-second'), term: 2, presetId: 'reviewer', revision: 'b'.repeat(64) }
    const commit = event('team/lead/transaction', { version: 1, teamId: TEAM, previousTerm: 1, binding,
      extension: { id: 'writer', dataJson: '{}' }, releases: [] })
    expect(project([mode, queued, commit, { ...receipt, data: { ...receipt.data, executionId: binding.executionId, term: 9 } }])
      .failure).toMatch(/never held/)
    const normal = { ...ordinary }
    const cancel = event('team/message/cancelled', { version: 3, teamId: TEAM, targetId: ROOT,
      messageIds: [message.id], reason: 'ordinary cancelled' })
    expect(project([mode, event('team/message/queued', { version: 2, teamId: TEAM, message: normal }), cancel, receipt])
      .failure).toMatch(/already settled/)
  })

  it('validates complete original input material including both queues, requested target and wake intent', () => {
    const captured = transfer()
    const valid = { ...captured, transfer: { ...captured.transfer, input: {
      ...captured.transfer.input, target: 'next-turn' as const, requestedTarget: 'next-step' as const, wakeup: true,
    } } }
    expect(project([mode, event('team/message/input-queued', { version: 1, teamId: TEAM, message: valid })]).failure).toBeUndefined()
    const mutate = (change: (message: ReturnType<typeof transfer>) => void) => {
      const message = transfer()
      change(message)
      return project([mode, event('team/message/input-queued', { version: 1, teamId: TEAM, message })]).failure
    }
    for (const invalid of [null, 'not-an-input', {}]) {
      expect(mutate((message) => { Reflect.set(message.transfer, 'input', invalid) })).toMatch(/invalid/)
    }
    for (const invalid of [null, 'not-a-message']) {
      expect(mutate((message) => { Reflect.set(message.transfer.input, 'message', invalid) })).toMatch(/invalid/)
    }
    expect(mutate((message) => { Reflect.set(message.transfer.input, 'requestedTarget', 'next-turn') })).toBeUndefined()
    for (const [key, invalid] of [['target', 'other'], ['wakeup', 'yes'], ['requestedTarget', 'other']] as const) {
      expect(mutate((message) => { Reflect.set(message.transfer.input, key, invalid) })).toMatch(/invalid/)
    }
    for (const [key, invalid] of [['id', ''], ['role', 'assistant'], ['content', [{}]], ['source', null]] as const) {
      expect(mutate((message) => { Reflect.set(message.transfer.input.message, key, invalid) })).toMatch(/invalid/)
    }
  })

  it('admits owner-only transfer facts through no ordinary notice event', () => {
    const message = transfer()
    const task = { id: TeamTaskId('task-1'), revision: 1, subject: 'subject', description: 'description',
      status: 'pending' as const, blockedBy: [], writeScopes: [] }
    const ordinary = event('team/message/queued', { version: 2, teamId: TEAM, message })
    const extension = event('team/extension', { version: 1, teamId: TEAM,
      extension: { id: 'writer', recordId: 'forged-transfer', dataJson: '{}' }, notices: [message] })
    const lead = event('team/lead/transaction', { version: 1, teamId: TEAM, previousTerm: 1,
      binding: { executionId: SessionId('forged-transfer-recipient'), term: 2, presetId: 'reviewer', revision: 'a'.repeat(64) },
      extension: { id: 'writer', dataJson: '{}' }, releases: [], notices: [message] })
    const transaction = event('team/task/transaction', { version: 1, teamId: TEAM, updates: [{ previousRevision: null, task }],
      extension: { id: 'writer', dataJson: '{}' }, notices: [message] })
    for (const forged of [ordinary, extension, lead, transaction]) {
      expect(project([mode, forged]).failure).toMatch(/payload is invalid/)
    }
    const missing = transfer()
    Reflect.deleteProperty(missing, 'transfer')
    expect(project([mode, event('team/message/input-queued', { version: 1, teamId: TEAM, message: missing })])
      .failure).toBeDefined()
  })
})
