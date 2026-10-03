import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import DynamicCordisRunnerService from '../src/index.ts'
import type { ApprovalRequestId } from '../src/types.ts'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function harness(outcome: 'success' | 'false' | 'throw' = 'success') {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Timer)
  await ctx.plugin(DynamicCordisRunnerService)
  const adapter = new MockAdapter([])
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await ctx.agents.create({ sessionId: SessionId('cordis-notice-owner'), agentOptions: { provider: 'mock', model: 'mock' } })
  const cap = ctx.agents.registerInputController(InputControllerId('cordis-notice-custody'), {
    admit: () => ({ kind: 'hold' }), canStart: () => true, canClaim: () => true,
  })
  cap.bind(agent.session)
  const flush = vi.spyOn(ctx.sessions, 'flush')
  if (outcome === 'throw') flush.mockRejectedValue(new Error('Cordis notice persistence failed'))
  else flush.mockResolvedValue(outcome === 'success')
  const warn = vi.spyOn(ctx.logger, 'warn')
  const runner = ctx.dynamicCordisRunner
  return { ctx, agent, adapter, flush, warn, runner }
}

it.each(['success', 'false', 'throw'] as const)('observes %s custody for Cordis runtime failure and panel notices', async (outcome) => {
  const { ctx, agent, adapter, flush, warn, runner } = await harness(outcome)
  const { pluginId, packageId } = runner.define({
    sessionId: agent.id, plugin: { kind: 'new', idPrefix: 'notice' }, name: 'failure fixture', purpose: 'record runtime failures',
    code: { host: `
      harness.handle('fail', async () => { throw new Error('handler failed') })
      return { name: 'failure-fixture', apply() {} }
    ` },
  })
  const started = await runner.run(agent, pluginId, packageId, 'run')
  if (!started.ok) throw new Error(started.message)
  expect(runner.snapshot(agent)[0]?.latestRun?.status).toBe('running')
  await expect(runner.invoke(pluginId, started.pluginRunId, 'fail', null)).resolves.toMatchObject({ ok: false, code: 'handler-error' })
  await runner.reportClientGuardFailure(agent, pluginId, started.pluginRunId, { message: 'guard failed' })
  await runner.reportClientGuardFailure(agent, pluginId, started.pluginRunId, { message: 'guard failed' })
  await runner.reportRenderFailure(agent, pluginId, started.pluginRunId, { slot: 'test.slot', message: 'render failed', abdicated: true })
  await runner.stopFromPanel(agent, pluginId)
  const requests: ApprovalRequestId[] = []
  ctx.on('cordis/request-run', ({ requestId }) => { requests.push(requestId) })
  for (const result of ['approved', 'rejected', 'failed'] as const) {
    const definition = runner.define({
      sessionId: agent.id, plugin: { kind: 'new', idPrefix: 'defer' }, name: `deferred ${result}`, purpose: 'record late activation result',
      code: { client: 'return () => {}' },
    })
    await runner.run(agent, definition.pluginId, definition.packageId, 'run')
    const requestId = requests.at(-1)!
    if (result === 'approved') {
      const half = await runner.runHostHalf(agent, definition.pluginId, definition.packageId, 'run', requestId, false)
      if (!half.ok) throw new Error(half.message)
      await runner.resolveRequestRun(requestId, { ok: true, pluginRunId: half.pluginRunId })
    } else {
      await runner.resolveRequestRun(requestId, { ok: false, reason: result === 'rejected' ? 'rejected' : 'client-half-failed', message: result })
    }
  }
  await expect.poll(() => flush.mock.calls.length).toBe(7)
  if (outcome !== 'success') {
    await expect.poll(() => warn.mock.calls.filter(call => String(call[0]).includes('input notice durability was not confirmed')).length).toBe(7)
  }
  const records = ctx.agents.inputControlState(agent.session).records
  expect(records).toHaveLength(7)
  expect(records.map(record => record.input.wakeup)).toEqual([true, true, true, false, true, true, true])
  expect(records.every(record => record.location === 'held' && record.input.message.source.kind === 'cordis-host-runner')).toBe(true)
  expect(agent.inbox.nextStep).toEqual([])
  expect(adapter.requests).toHaveLength(0)
})

it.each(['rejected', 'host-half-failed'] as const)(
  'records a direct %s result without inventing an activation after Host refusal', async (reason) => {
    const { ctx, agent, runner, flush } = await harness()
    const definition = runner.define({
      sessionId: agent.id, plugin: { kind: 'new', idPrefix: 'panel' }, name: 'panel fixture', purpose: 'report a refused panel start',
      code: { client: 'return () => {}' },
    })
    const refused = await runner.runHostHalf(agent, definition.pluginId, definition.packageId, 'update', null, false)
    if (refused.ok) throw new Error('an unstarted definition must refuse update mode')
    const result = await runner.settleUserRun(agent, definition.pluginId, { ok: false, reason, message: refused.message })
    expect(result).toMatchObject({ ok: false, reason })
    await expect.poll(() => flush.mock.calls.length).toBe(1)
    expect(runner.inventory()[0]?.latestRun).toBeUndefined()
    expect(runner.inventory()[0]?.activeRun).toBeUndefined()
    const record = ctx.agents.inputControlState(agent.session).records[0]!
    expect(record.input.wakeup).toBe(false)
    const text = `The user manually ran Cordis Plugin ${definition.pluginId}, but it failed: ${reason}\n`
      + `message: ${refused.message}\ncurrentPackageId: none\nnextPackageId: none`
    expect(record.input.message.content[0]).toEqual({ type: 'text', text })
  })

it('keeps an approved update failure notice attributable after its Plugin is removed during settlement', async () => {
  const { ctx, agent, runner, flush } = await harness()
  const requests: ApprovalRequestId[] = []
  ctx.on('cordis/request-run', ({ requestId }) => { requests.push(requestId) })
  const first = runner.define({
    sessionId: agent.id, plugin: { kind: 'new', idPrefix: 'panel' }, name: 'first page', purpose: 'approve page versions',
    code: { client: 'return () => {}' },
  })
  await runner.run(agent, first.pluginId, first.packageId, 'run')
  const requestId = requests.at(-1)!
  const initial = await runner.runHostHalf(agent, first.pluginId, first.packageId, 'run', requestId, true)
  if (!initial.ok) throw new Error(initial.message)
  await runner.resolveRequestRun(requestId, { ok: true, pluginRunId: initial.pluginRunId })
  const second = runner.define({
    sessionId: agent.id, plugin: { kind: 'existing', pluginId: first.pluginId }, name: 'second page', purpose: 'report an approved update failure',
    code: { client: 'return () => {}' },
  })
  await expect(runner.run(agent, first.pluginId, second.packageId, 'update')).resolves.toMatchObject({ ok: true, status: 'starting' })
  const updateRequest = requests.at(-1)!
  const update = await runner.runHostHalf(agent, first.pluginId, second.packageId, 'update', updateRequest, false)
  if (!update.ok) throw new Error(update.message)
  const resolving = runner.resolveRequestRun(updateRequest, { ok: false, reason: 'client-half-failed', pluginRunId: update.pluginRunId, message: 'page failed' })
  await runner.undefine(agent, first.pluginId)
  await expect(resolving).resolves.toEqual({ accepted: true })
  await expect.poll(() => flush.mock.calls.length).toBe(2)
  expect(runner.inventory()).toEqual([])
  const content = ctx.agents.inputControlState(agent.session).records.at(-1)?.input.message.content
  expect(content?.[0]?.type).toBe('text')
  if (content?.[0]?.type !== 'text') throw new Error('the failure notice must contain text')
  expect(content[0].text).toContain('failed after the runner returned starting')
  expect(content[0].text).toContain('currentPackageId: none')
  expect(content[0].text).toContain(`nextPackageId: ${second.packageId}`)
})
