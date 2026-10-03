import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Invariants from '@deepseek-ai/dsh-invariants'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, onTestFinished } from 'vitest'
import ApprovalService, { ApprovalAnswererRouteId, setApprovalPolicy } from '../src/index.ts'
import * as ApprovalInvariant from '../src/invariant.ts'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** Real Loader, Agent and JSONL owners; answerers and model responses remain caller-owned external inputs. */
export async function rejectionHarness(options: { invariants?: boolean
  script?: ConstructorParameters<typeof MockAdapter>[0]
  cut?: { header: SessionHeader; events: readonly SessionEvent[] } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-approval-rejection-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins['rejection-approval'] = ApprovalService
  ctx.loader.builtins['rejection-jsonl'] = JsonlPersistence
  ctx.loader.builtins['rejection-loop'] = AgentLoop
  ctx.loader.builtins['rejection-invariants'] = Invariants
  ctx.loader.builtins['rejection-approval-invariant'] = ApprovalInvariant
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: 'cordis:rejection-jsonl', config: { root: join(root, 'sessions'), compression: 'none' } },
    { name: 'cordis:rejection-loop', config: { agents: [] } },
    { name: 'cordis:rejection-approval' },
    ...options.invariants === false ? [] : [{ name: 'cordis:rejection-invariants' }, { name: 'cordis:rejection-approval-invariant' }],
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  if (ctx.get('agentLoop') === undefined || ctx.get('approval') === undefined || ctx.get('sessionPersistence') === undefined) {
    throw new Error('approval fixture Loader rows did not activate their real services')
  }
  const adapter = new MockAdapter(options.script ?? [])
  ctx.llm.registerAdapter(['mock'], adapter)
  const answerer = await ctx.agents.create({ sessionId: SessionId('rejection-answerer'), agentOptions: { provider: 'mock', model: 'mock' } })
  const status = { valid: true }
  const route = ApprovalAnswererRouteId('rejection-route')
  const removeRoute = ctx.approval.registerAnswererRoute(route, (origin, question) => {
    const call = origin.session.snapshotEvents().findLast(event => event.type === 'tool/call' && event.data.callId === question?.callId)
    return { agent: answerer.agent, displaySubject: 'worker', isValid: () => status.valid,
      ...call?.type !== 'tool/call' ? {} : { operation: { name: call.data.name, arguments: call.data.arguments } } }
  })
  if (options.cut !== undefined) {
    const saved = await ctx.sessionPersistence.create(options.cut.header)
    try { await saved.append(options.cut.events); await saved.flush() } finally { await saved.close() }
  }
  const source = options.cut === undefined
    ? await ctx.agents.create({ sessionId: SessionId('rejection-source'), agentOptions: { provider: 'mock', model: 'mock' } })
    : await ctx.agents.resume({ resumeSessionId: options.cut.header.id, agentOptions: { provider: 'mock', model: 'mock' } })
  if (options.cut === undefined) {
    setApprovalPolicy(source.agent.session, 'never')
    ctx.approval.bindAnswererRoute(source.agent, route)
    await ctx.sessions.flush(source.agent.session)
  }
  const callId = ToolCallId('rejection-operation')
  const open = () => {
    source.agent.session.append('turn/start', { turn: 1 })
    source.agent.session.append('step/start', { turn: 1, step: 1 })
  }
  const close = () => {
    source.agent.session.append('step/end', { turn: 1, step: 1 })
    source.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  return { ctx, root, adapter, answerer, source, route, status, removeRoute, callId, open, close }
}

/** Retain the persisted unanswered cut, then settle its live producer normally; dispose is not simulated process loss. */
export async function captureUnansweredCut() {
  const test = await rejectionHarness()
  test.open()
  const entered = Promise.withResolvers<undefined>()
  const answer = Promise.withResolvers<import('../src/index.ts').ApprovalOutcome>()
  test.ctx.on('approval/request', async () => { entered.resolve(undefined); return answer.promise })
  const waiting = test.ctx.approval.request({ agent: test.source.agent, toolName: 'sensitive_operation', callId: test.callId })
  await entered.promise
  const captured = test.ctx.approval.pendingRequests()[0]
  if (captured === undefined) throw new Error('original request is not pending')
  await test.ctx.sessions.flush(test.source.agent.session)
  const saved = await test.ctx.sessionPersistence.open(test.source.agent.id, 'read')
  let cut: { header: SessionHeader; events: readonly SessionEvent[] }
  try { cut = { header: saved.header, events: (await saved.read()).events } } finally { await saved.close() }
  answer.resolve('rejected')
  expect(await waiting).toBe('rejected')
  test.close()
  return { cut, captured }
}

/** Mount only persisted readers/writers and the approval service; there is no Agent factory or activated Session. */
export async function offlineRejectionHarness(cut: { header: SessionHeader; events: readonly SessionEvent[] },
  shared?: { root: string; contexts: Context[] }) {
  const resources = shared ?? { root: await mkdtemp(join(tmpdir(), 'dsh-approval-offline-')), contexts: [] }
  const releases: Array<() => void> = []
  const ctx = new Context()
  resources.contexts.push(ctx)
  if (shared === undefined) onTestFinished(async () => {
    for (const release of releases) release()
    try { for (const context of resources.contexts.toReversed()) await context.fiber.dispose() }
    finally { await rm(resources.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlPersistence, { root: join(resources.root, 'sessions'), compression: 'none' })
  const approval = await ctx.plugin(ApprovalService)
  await ctx.plugin(Invariants)
  await ctx.plugin(ApprovalInvariant)
  if (shared === undefined) {
    const saved = await ctx.sessionPersistence.create(cut.header)
    try { await saved.append(cut.events); await saved.flush() } finally { await saved.close() }
  }
  const read = async () => {
    const saved = await ctx.sessionPersistence.open(cut.header.id, 'read')
    try { return { header: saved.header, events: (await saved.read()).events } } finally { await saved.close() }
  }
  return { ctx, approval, resources, read, releases }
}
