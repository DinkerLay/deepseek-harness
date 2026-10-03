import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { InputControllerId, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createInboxStub, mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude-code'
import * as HooksCodex from '@deepseek-ai/dsh-hooks-codex'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import SubagentRuntime, { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function bootTree(dialect: 'codex' | 'claude', point: 'SessionStart' | 'Stop' | 'SubagentStart', standalone = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hook-receipt-'))
  const ctx = new Context()
  const gates: Array<ReturnType<typeof Promise.withResolvers<boolean>>> = []
  onTestFinished(async () => {
    for (const gate of gates) gate.resolve(false)
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  const configPath = join(root, 'hooks.json')
  const command = point === 'Stop' ? 'printf "keep working" >&2; exit 2'
    : `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: point, additionalContext: 'controlled guidance' } })}'`
  writeFileSync(configPath, JSON.stringify({ hooks: { [point]: [{ hooks: [{ type: 'command', command }] }] } }))
  if (standalone) await ctx.plugin(SessionProjectionRegistry)
  else {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
  }
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  if (dialect === 'codex') await ctx.plugin(HooksCodex, { configPath })
  else await ctx.plugin(HooksClaude, { configPath })
  const adapter = new MockAdapter([])
  if (!standalone) ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter, gates }
}

async function boot(dialect: 'codex' | 'claude', point: 'SessionStart' | 'Stop' | 'SubagentStart') {
  const { ctx, adapter, gates } = await bootTree(dialect, point)
  const cap = ctx.agents.registerInputController(InputControllerId('hook-custody'), {
    admit: () => ({ kind: 'accept' }), canStart: () => false, canClaim: () => false,
    initialize(session) { cap.bind(session) },
  })
  const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
  const warn = vi.spyOn(ctx.logger, 'warn')
  const flushGate = () => {
    const gate = Promise.withResolvers<boolean>()
    gates.push(gate)
    flush.mockReturnValueOnce(gate.promise)
    return gate
  }
  return { ctx, adapter, flush, warn, flushGate }
}

function standaloneAgent(ctx: Context, id: string): Agent {
  const session = Session.create(SessionId(id))
  const inbox = createInboxStub()
  return {
    id: session.id, session, inbox, options: {}, ctx, status: 'idle',
    send() {}, followup() {}, cancel() {},
    inject(message) { inbox.append('next-step', message) },
    steer(message) { inbox.append('next-step', message) },
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
}

describe.each(['codex', 'claude'] as const)('%s hooks with controlled input', (dialect) => {
  it.each(['SessionStart', 'Stop'] as const)('keeps %s synchronous delivery in a standalone hooks composition', async (point) => {
    const test = await bootTree(dialect, point, true)
    const agent = standaloneAgent(test.ctx, 'standalone-hook')
    expect(test.ctx.get('agents')).toBeUndefined()
    if (point === 'SessionStart') await test.ctx.serial('agent/created', { agent, source: 'startup' })
    else await test.ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    expect(agent.inbox.nextStep).toHaveLength(1)
    expect(agent.inbox.nextStep[0]?.content).toEqual([{ type: 'text', text: point === 'Stop' ? 'keep working' : 'controlled guidance' }])
    expect(agent.session.snapshotEvents().some(event => event.type.startsWith('agent/input/'))).toBe(false)
  })
  it('waits for SessionStart context custody before creation returns', async () => {
    const test = await boot(dialect, 'SessionStart')
    const gate = test.flushGate()
    let created = false
    const pending = test.ctx.agents.create({ sessionId: SessionId('hook-session'), agentOptions: { provider: 'mock', model: 'mock' } })
      .then((handle) => { created = true; return handle })
    await expect.poll(() => test.flush.mock.calls.length).toBe(1)
    expect(created).toBe(false)
    expect(test.adapter.requests).toHaveLength(0)
    gate.resolve(true)
    const { agent } = await pending
    expect(test.ctx.agents.inputControlState(agent.session).records[0]?.input).toMatchObject({
      target: 'next-step', wakeup: false,
      message: { source: { kind: `hooks-${dialect === 'claude' ? 'claude-code' : 'codex'}` } },
    })
  })

  it.each(['false', 'throw'] as const)('observes a %s SessionStart durability failure', async (failure) => {
    const test = await boot(dialect, 'SessionStart')
    if (failure === 'false') test.flush.mockResolvedValueOnce(false)
    else test.flush.mockRejectedValueOnce(new Error('hook persistence failed'))
    const { agent } = await test.ctx.agents.create({ sessionId: SessionId('hook-session'), agentOptions: { provider: 'mock', model: 'mock' } })
    expect(test.warn).toHaveBeenCalledWith(expect.stringContaining('SessionStart hook failed'))
    expect(test.ctx.agents.inputControlState(agent.session).records).toHaveLength(1)
    expect(test.ctx.agents.canStartInput(agent)).toBe(false)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('waits for Stop continuation custody and propagates a failed receipt', async () => {
    const test = await boot(dialect, 'Stop')
    const { agent } = await test.ctx.agents.create({ sessionId: SessionId('hook-session'), agentOptions: { provider: 'mock', model: 'mock' } })
    const gate = test.flushGate()
    let settled = false
    const pending = test.ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
      .then(() => { settled = true })
    await expect.poll(() => test.flush.mock.calls.length).toBe(1)
    expect(settled).toBe(false)
    gate.resolve(true)
    await pending
    expect(test.ctx.agents.inputControlState(agent.session).records[0]?.input).toMatchObject({ target: 'next-step', wakeup: true })
    test.flush.mockRejectedValueOnce(new Error('stop persistence failed'))
    await expect(test.ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal }))
      .rejects.toThrow('stop persistence failed')
    expect(test.adapter.requests).toHaveLength(0)
  })
})

it('observes detached Claude SubagentStart receipts and their failures on the original child', async () => {
  const test = await boot('claude', 'SubagentStart')
  await test.ctx.plugin(SubagentRuntime)
  const { agent } = await test.ctx.agents.create({ sessionId: SessionId('original-child'), agentOptions: { provider: 'mock', model: 'mock' } })
  const gate = test.flushGate()
  const announce = () => { test.ctx.emit(scopeTarget(test.ctx.subagents, undefined), 'subagent/start', {
    runId: SubagentRunId('controlled-child-run'), provider: 'test', id: agent.id, local: true,
  }) }
  announce()
  await expect.poll(() => test.flush.mock.calls.length).toBe(1)
  expect(test.ctx.agents.inputControlState(agent.session).records).toHaveLength(1)
  expect(test.warn.mock.calls.some(call => String(call[0]).includes('SubagentStart hook failed'))).toBe(false)
  gate.resolve(true)
  test.flush.mockRejectedValueOnce(new Error('child persistence failed'))
  announce()
  await expect.poll(() => test.warn.mock.calls.some(call => String(call[0]).includes('SubagentStart hook failed'))).toBe(true)
  expect(test.ctx.agents.inputControlState(agent.session).records).toHaveLength(2)
  expect(test.adapter.requests).toHaveLength(0)
})

it('keeps standalone child context delivery after its optional registry unloads during the hook', async () => {
  const test = await bootTree('claude', 'SubagentStart', true)
  const registry = await test.ctx.plugin(AgentRegistry)
  await test.ctx.plugin(SubagentRuntime)
  const child = standaloneAgent(test.ctx, 'standalone-child')
  test.ctx.agents.enter(child, undefined)
  const entered = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<boolean>()
  test.gates.push(gate)
  const execute = test.ctx.shell.execute.bind(test.ctx.shell)
  vi.spyOn(test.ctx.shell, 'execute').mockImplementationOnce(async (spec) => {
    entered.resolve(undefined)
    await gate.promise
    return execute(spec)
  })
  test.ctx.emit(scopeTarget(test.ctx.subagents, undefined), 'subagent/start', {
    runId: SubagentRunId('standalone-child-run'), provider: 'test', id: child.id, local: true,
  })
  await entered.promise
  await registry.dispose()
  expect(test.ctx.get('agents')).toBeUndefined()
  expect(child.inbox.nextStep).toHaveLength(0)
  gate.resolve(true)
  await expect.poll(() => child.inbox.nextStep.length).toBe(1)
  expect(child.inbox.nextStep[0]?.content).toEqual([{ type: 'text', text: 'controlled guidance' }])
})
