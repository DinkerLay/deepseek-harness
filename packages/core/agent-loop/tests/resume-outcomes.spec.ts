import { ToolCallId, createMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq, SessionId, TOOL_NOT_APPLIED, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { InterruptedToolOutcome, PendingToolCall, SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

async function mount(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
  return ctx
}

/** Store a log whose tail turn was interrupted inside a started `team_write` call, then resume it in a fresh process. */
async function resumeWith(resolve: () => Promise<InterruptedToolOutcome>): Promise<{ stored: readonly SessionEvent[]; asked: unknown[] }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-resume-outcomes-'))
  dirs.push(root)
  const sessionId = SessionId('interrupted-owned-call')
  const first = await mount(root)
  const handle = await first.sessionPersistence.create(first.sessions.prepare(sessionId).header)
  await handle.append([
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time: 1, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: SessionSeq(2), time: 2, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [],
      message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'team_write', arguments: '{}' }] }) } },
    { type: 'tool/call', seq: SessionSeq(3), time: 2, data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'team_write', arguments: '{}' } },
  ] as SessionEvent[])
  await handle.close()
  await first.fiber.dispose()

  const second = await mount(root)
  const owner = vi.fn((_query: { readonly call: PendingToolCall }, _signal: AbortSignal) => resolve())
  second.effect(() => second.agents.registerInterruptedToolOwner({ tools: ['team_write'], resolve: owner }))
  await (await second.agents.resume({ resumeSessionId: sessionId })).dispose()
  const reader = await second.sessionPersistence.open(sessionId, 'read')
  try {
    return { stored: (await reader.read()).events, asked: owner.mock.calls.map(([query]) => query.call) }
  } finally {
    await reader.close()
    await second.fiber.dispose()
  }
}

it('asks the tool owner before closing an interrupted call and writes its recorded result durably', async () => {
  const { stored, asked } = await resumeWith(() => Promise.resolve({ kind: 'recorded', text: 'task-1 paused' }))
  expect(asked).toEqual([{ callId: 'call-1', name: 'team_write', arguments: '{}', started: true }])
  expect(stored[4]).toMatchObject({ type: 'tool/result', sourceEventSeqs: [3], data: { message: { isError: false } } })
  expect(JSON.stringify(stored[4])).toContain('task-1 paused')
})

it('writes "not applied" when the owner found no effect, and keeps "unknown" when the owner fails', async () => {
  expect((await resumeWith(() => Promise.resolve({ kind: 'absent' }))).stored[4]).toMatchObject({ data: { error: { code: TOOL_NOT_APPLIED } } })
  expect((await resumeWith(() => Promise.reject(new Error('log read failed')))).stored[4])
    .toMatchObject({ data: { error: { code: TOOL_OUTCOME_UNKNOWN } } })
})
