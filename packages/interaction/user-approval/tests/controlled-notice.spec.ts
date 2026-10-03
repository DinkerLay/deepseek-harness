import { Context } from '@deepseek-ai/cordis'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

it.each(['success', 'false', 'throw'] as const)('observes %s custody for a non-waking approval policy notice', async (outcome) => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService)
  const adapter = new MockAdapter([])
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await ctx.agents.create({ sessionId: SessionId('policy-notice'), agentOptions: { provider: 'mock', model: 'mock' } })
  const cap = ctx.agents.registerInputController(InputControllerId('policy-notice-custody'), {
    admit: () => ({ kind: 'hold' }), canStart: () => true, canClaim: () => true,
  })
  cap.bind(agent.session)
  const flush = vi.spyOn(ctx.sessions, 'flush')
  if (outcome === 'throw') flush.mockRejectedValueOnce(new Error('notice persistence failed'))
  else flush.mockResolvedValueOnce(outcome === 'success')
  const warn = vi.spyOn(ctx.logger, 'warn')
  ctx.approval.setPolicy(agent, 'never')
  ctx.approval.setPolicy(agent, 'never')
  await expect.poll(() => flush.mock.calls.length).toBe(1)
  if (outcome !== 'success') {
    await expect.poll(() => warn.mock.calls.length).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('input notice durability was not confirmed'))
  } else await flush.mock.results[0]?.value
  expect(ctx.approval.overrideOf(agent.session)).toBe('never')
  expect(ctx.agents.inputControlState(agent.session).records).toHaveLength(1)
  expect(ctx.agents.inputControlState(agent.session).records[0]?.input).toMatchObject({ target: 'next-step', wakeup: false })
  expect(agent.inbox.nextStep).toEqual([])
  expect(adapter.requests).toHaveLength(0)
})
