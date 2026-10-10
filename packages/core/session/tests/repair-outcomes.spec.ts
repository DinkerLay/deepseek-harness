import { describe, expect, it } from 'vitest'
import { ToolCallId, createMessage } from '@deepseek-ai/dsh-llm'
import { interruptedTurnClosers, pendingToolCalls, SessionSeq, TOOL_NOT_APPLIED, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '../src/index.ts'
import type { InterruptedToolOutcome, SessionEvent } from '../src/index.ts'
import { openTurnClosers } from '../src/repair.ts'

const started = ToolCallId('started')
const unstarted = ToolCallId('unstarted')

/** An open tail turn: one started write call and one request that never reached its call start. */
function interrupted(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: SessionSeq(3), time: 3, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [],
      message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [
        { type: 'tool-call', id: started, name: 'team_write', arguments: '{"task":"task-1"}' },
        { type: 'tool-call', id: unstarted, name: 'team_write', arguments: '{"task":"task-2"}' },
      ] }) } },
    { type: 'tool/call', seq: SessionSeq(4), time: 4, data: { turn: 1, step: 1, callId: started, name: 'team_write', arguments: '{"task":"task-1"}' } },
  ]
}

function resultOf(closers: readonly SessionEvent[], callId: string) {
  const result = closers.find(event => event.type === 'tool/result' && event.data.message.source.callId === callId)
  if (result?.type !== 'tool/result') throw new Error(`no result for ${callId}`)
  return result
}

describe('owner-reported outcomes of interrupted calls', () => {
  it('lists the unanswered requests with their tool names and whether they started', () => {
    expect(pendingToolCalls(interrupted())).toEqual([
      { callId: started, name: 'team_write', arguments: '{"task":"task-1"}', started: true },
      { callId: unstarted, name: 'team_write', arguments: '{"task":"task-2"}', started: false },
    ])
  })

  it('writes the recorded result for a started call whose owner found its effect', () => {
    const outcomes = new Map<ToolCallId, InterruptedToolOutcome>([[started, { kind: 'recorded', text: '{"phase":"accepted"}' }]])
    const result = resultOf(interruptedTurnClosers(interrupted(), outcomes), started)
    expect(result.data.message.isError).toBe(false)
    expect(result.data.error).toBeUndefined()
    expect(result.data.message.content).toEqual([
      { type: 'text', text: 'Recovered after an interruption: this call\'s effect was durably recorded before the interruption. Its result follows; do not repeat the call.' },
      { type: 'text', text: '{"phase":"accepted"}' },
    ])
    expect(result.sourceEventSeqs).toEqual([4])
  })

  it('confirms nothing changed when the owner found no effect, and keeps unknown otherwise', () => {
    const absent = resultOf(interruptedTurnClosers(interrupted(), new Map([[started, { kind: 'absent' }]])), started)
    expect(absent.data.error?.code).toBe(TOOL_NOT_APPLIED)
    expect(absent.data.message.content).toEqual([{ type: 'text',
      text: 'The tool call was interrupted, and its owner confirmed that no effect was recorded; nothing changed. Retry it if it is still needed.' }])
    expect(resultOf(interruptedTurnClosers(interrupted(), new Map([[started, { kind: 'unknown' }]])), started))
      .toEqual(resultOf(interruptedTurnClosers(interrupted()), started))
    expect(resultOf(interruptedTurnClosers(interrupted()), started).data.error?.code).toBe(TOOL_OUTCOME_UNKNOWN)
  })

  it('never applies an outcome to a call that did not start, or to a forked seed', () => {
    const outcomes = new Map<ToolCallId, InterruptedToolOutcome>([[unstarted, { kind: 'recorded', text: 'ignored' }],
      [started, { kind: 'recorded', text: 'ignored' }]])
    expect(resultOf(interruptedTurnClosers(interrupted(), outcomes), unstarted).data.error?.code).toBe(TOOL_NOT_STARTED)
    expect(openTurnClosers(interrupted(), { kind: 'forked' }, outcomes)).toEqual(openTurnClosers(interrupted(), { kind: 'forked' }))
  })
})
