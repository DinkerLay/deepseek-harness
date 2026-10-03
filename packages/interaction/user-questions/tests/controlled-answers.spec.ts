import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { InputControllerId, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import UserQuestionService, { TIMED_WAIT_PARAMETER } from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const callId = ToolCallId('continued-controlled-question')
const batch = { answers: [{ id: 'scope', selected: ['Tool only'] }] }

function continuedQuestion(agent: Agent): void {
  const args = JSON.stringify({ questions: [{ id: 'scope', question: 'Which scope?', options: [{ label: 'Tool only' }] }] })
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('step/start', { turn: 1, step: 1 })
  agent.session.append('request/header', {
    header: { config: { provider: 'mock', model: 'mock' }, tools: [{
      name: 'ask_user_question', description: 'Ask brief questions.',
      parameters: { type: 'object', properties: { questions: { type: 'array' }, [TIMED_WAIT_PARAMETER]: { type: 'integer' } } },
    }] }, reason: 'initial',
  })
  agent.session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({
    content: [{ type: 'tool-call', id: callId, name: 'ask_user_question', arguments: args }],
    source: { provider: 'mock', model: 'mock' },
  }), stream: [] }, { surfaceOp: 'append' })
  agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'ask_user_question',
    arguments: args,
  })
  agent.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
    callId, content: [{ type: 'text', text: JSON.stringify({ pending: true, callId }) }], isError: false,
  }) }, { surfaceOp: 'append' })
  agent.session.append('step/end', { turn: 1, step: 1 })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

async function boot(options: { admission?: 'accept' | 'hold' | 'reject'; controlled?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-question-custody-'))
  const contexts: Context[] = []
  const gates: Array<ReturnType<typeof Promise.withResolvers<boolean>>> = []
  onTestFinished(async () => {
    for (const gate of gates) gate.resolve(false)
    for (const ctx of contexts.toReversed()) await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  const admission = { kind: options.admission ?? 'accept' }
  async function mount(resume = false) {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(UserQuestionService)
    const adapter = new MockAdapter([textResponse('answer received')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const cap = ctx.agents.registerInputController(InputControllerId('question-custody'), {
      admit: () => admission.kind === 'reject' ? { kind: 'reject', reason: 'answer refused' } : { kind: admission.kind },
      canStart: () => false, canClaim: () => false,
    })
    const handle = resume
      ? await ctx.agents.resume({ resumeSessionId: SessionId('question-owner'), agentOptions: { provider: 'mock', model: 'mock' } })
      : await ctx.agents.create({ sessionId: SessionId('question-owner'), agentOptions: { provider: 'mock', model: 'mock' } })
    if (!resume) {
      continuedQuestion(handle.agent)
      if (options.controlled !== false) cap.bind(handle.agent.session)
    }
    return { ctx, agent: handle.agent, handle, cap, adapter }
  }
  return { ...await mount(), admission, mount, flushGate() {
    const gate = Promise.withResolvers<boolean>()
    gates.push(gate)
    return gate
  } }
}

describe('continued answers with controlled custody', () => {
  it('preserves the synchronous steer path for an unbound Remote answer', async () => {
    const test = await boot({ controlled: false })
    const steer = vi.spyOn(test.agent, 'steer')
    const flush = vi.spyOn(test.ctx.sessions, 'flush')
    const answered = test.ctx.userQuestions.answerConfirmed(test.agent, callId, batch)
    expect(steer).toHaveBeenCalledOnce()
    expect(test.agent.status).toBe('running')
    expect(flush).not.toHaveBeenCalled()
    await expect(answered).resolves.toBe(true)
    await test.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    await expect(test.ctx.userQuestions.answerConfirmed(test.agent, callId, batch)).resolves.toBe(false)
  })

  it.each(['accept', 'hold'] as const)('confirms %s custody only after flush settles', async (admission) => {
    const test = await boot({ admission })
    const gate = test.flushGate()
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockReturnValueOnce(gate.promise)
    let answered = false
    const pending = test.ctx.userQuestions.answerConfirmed(test.agent, callId, batch).then((value) => { answered = value })
    await expect.poll(() => flush.mock.calls.length).toBe(1)
    expect(answered).toBe(false)
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.ctx.agents.inputControlState(test.agent.session).records).toHaveLength(1)
    gate.resolve(true)
    await pending
    expect(answered).toBe(true)
    expect(test.ctx.agents.inputControlState(test.agent.session).records[0]?.location).toBe(admission === 'hold' ? 'held' : 'inbox')
  })

  it.each(['accept', 'hold'] as const)('retries failed %s custody with the original message identity', async (admission) => {
    const test = await boot({ admission })
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(test.ctx.userQuestions.answerConfirmed(test.agent, callId, batch)).rejects.toThrow(/durability/)
    const original = test.ctx.agents.inputControlState(test.agent.session).records[0]!
    expect(test.ctx.agents.canStartInput(test.agent)).toBe(false)
    await expect(test.ctx.userQuestions.answerConfirmed(test.agent, callId, batch)).resolves.toBe(true)
    expect(flush).toHaveBeenCalledTimes(2)
    expect(test.ctx.agents.inputControlState(test.agent.session).records).toEqual([original])
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('retains the same held reply after a thrown flush and cold recovery', async () => {
    const test = await boot({ admission: 'hold' })
    vi.spyOn(test.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(test.ctx.userQuestions.answerConfirmed(test.agent, callId, batch)).rejects.toThrow('disk unavailable')
    const original = test.ctx.agents.inputControlState(test.agent.session).records[0]!
    await test.handle.dispose()
    const recovered = await test.mount(true)
    await expect(recovered.ctx.userQuestions.answerConfirmed(recovered.agent, callId, batch)).resolves.toBe(true)
    expect(recovered.ctx.agents.inputControlState(recovered.agent.session).records).toEqual([original])
    expect(recovered.adapter.requests).toHaveLength(0)
  })

  it('permits a new answer after orderly shutdown discards an accepted inbox reply', async () => {
    const test = await boot()
    vi.spyOn(test.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(test.ctx.userQuestions.answerConfirmed(test.agent, callId, batch)).rejects.toThrow('disk unavailable')
    const original = test.ctx.agents.inputControlState(test.agent.session).records[0]!
    await test.handle.dispose()
    expect(test.agent.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')).toBe(true)
    const recovered = await test.mount(true)
    await expect(recovered.ctx.userQuestions.answerConfirmed(recovered.agent, callId, batch)).resolves.toBe(true)
    const records = recovered.ctx.agents.inputControlState(recovered.agent.session).records
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual(original)
    expect(records[1]?.input.message.id).not.toBe(original.input.message.id)
    expect(recovered.agent.inbox.nextStep).toHaveLength(1)
  })

  it('confirms the original receipt after an authorized edit without replacing the edited input', async () => {
    const test = await boot()
    await test.ctx.userQuestions.answerConfirmed(test.agent, callId, batch)
    const original = test.ctx.agents.inputControlState(test.agent.session).records[0]!.input
    const edited = [{ type: 'text' as const, text: 'the edited answer' }, { type: 'text' as const, text: 'extra context' }]
    await test.ctx.agents.mutateInput(test.agent, { kind: 'replace', messageId: original.message.id, content: edited })
    await expect(test.ctx.userQuestions.answerConfirmed(test.agent, callId, batch)).resolves.toBe(true)
    const records = test.ctx.agents.inputControlState(test.agent.session).records
    expect(records).toHaveLength(1)
    expect(records[0]?.originalInput).toEqual(original)
    expect(records[0]?.input.message.content).toEqual(edited)
    expect(test.agent.inbox.nextStep[0]?.content).toEqual(edited)
  })

  it('releases an unbound reservation when synchronous steering fails before custody', async () => {
    const test = await boot({ controlled: false })
    vi.spyOn(test.agent, 'steer').mockImplementationOnce(() => { throw new Error('synchronous steering failed') })
    await expect(test.ctx.userQuestions.answerConfirmed(test.agent, callId, batch)).rejects.toThrow('synchronous steering failed')
    await expect(test.ctx.userQuestions.answerConfirmed(test.agent, callId, batch)).resolves.toBe(true)
    await test.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('refuses replacement of an uncertain answer and permits a retry after admission rejects before custody', async () => {
    const test = await boot({ admission: 'reject' })
    await expect(test.ctx.userQuestions.answerConfirmed(test.agent, callId, batch)).rejects.toThrow('answer refused')
    expect(test.ctx.agents.inputControlState(test.agent.session).records).toHaveLength(0)
    test.admission.kind = 'hold'
    vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(test.ctx.userQuestions.answerConfirmed(test.agent, callId, batch)).rejects.toThrow(/durability/)
    await expect(test.ctx.userQuestions.answerConfirmed(test.agent, callId, { answers: [{ id: 'scope', selected: [] }] }))
      .rejects.toMatchObject({ code: 'REPLY_QUEUED' })
    expect(test.ctx.agents.inputControlState(test.agent.session).records).toHaveLength(1)
    await expect(test.ctx.userQuestions.answerConfirmed(test.agent, callId, batch)).resolves.toBe(true)
  })
})
