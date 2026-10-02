import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import Approval, { ApprovalAnswererRouteId, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import SubagentRuntime from '../src/index.ts'
import { applyDelegatedComposition } from '../src/child-agent.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function setup(omit?: 'sandbox' | 'permissions') {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Approval)
  if (omit !== 'sandbox') await ctx.plugin(SandboxPolicy, { mode: 'read-only' })
  ctx.provide('shell', {
    sandboxMode: 'read-only',
    resolve() { throw new Error('permission synchronization does not execute commands') },
    run() { throw new Error('permission synchronization does not execute commands') },
    start() { throw new Error('permission synchronization does not execute commands') },
  })
  const permissions = () => ctx.plugin(PermissionPresets, { defaultPreset: 'read-only', presets: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  } })
  if (omit !== 'permissions') await permissions()
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  const parent = await ctx.agents.create({ sessionId: SessionId('sync-parent'), agentOptions: {} })
  const child = await ctx.agents.create({ sessionId: SessionId('sync-child'),
    meta: { parentSession: parent.agent.id }, agentOptions: {} })
  setApprovalPolicy(child.agent.session, 'never')
  return { ctx, parent, child }
}

describe('continuable permission synchronization', () => {
  it('fails identified input delivery when its Host composition omits the Session store', async () => {
    const { parent } = await setup()
    const empty = new Context()
    contexts.push(empty)
    await empty.plugin(AgentRegistry)
    await empty.plugin(SubagentRuntime)
    const host: Agent = { ...parent.agent, ctx: empty }
    empty.effect(() => empty.agents.enter(host, undefined))
    const input = createUserMessage({ content: [{ type: 'text', text: 'host input' }], source: { kind: 'user' } })
    await expect(empty.subagents.deliverContinuableInput({ provider: 'spawn', childId: SessionId('unavailable-store-child'),
      label: 'missing store', request: { parent: host, prompt: [...input.content] }, signal: new AbortController().signal,
    }, input)).rejects.toThrow(/identified delivery requires the Session service/)
  })
  it('uses deployment defaults for preexisting sessions without seeded permission facts', async () => {
    const { ctx, parent, child } = await setup()
    const parentId = SessionId('unseeded-parent')
    const childId = SessionId('unseeded-child')
    const bareParent: Agent = { ...parent.agent, id: parentId,
      session: Session.create(parentId, undefined, { ...parent.agent.session.header, id: parentId }) }
    const bareChild: Agent = { ...child.agent, id: childId,
      session: Session.create(childId, undefined, { ...child.agent.session.header, id: childId, parentSession: parentId }) }
    ctx.effect(() => ctx.agents.enter(bareParent, undefined))
    ctx.effect(() => ctx.agents.enter(bareChild, bareParent))
    setApprovalPolicy(bareChild.session, 'never')
    expect(ctx.sandboxPolicy.overrideOf(bareParent.session)).toBeUndefined()
    expect(ctx.sessionProjections.stateOf(bareChild.session, 'permissions')?.preset).toBeNull()
    ctx.subagents.synchronizeContinuablePermissions(bareParent, bareChild)
    expect(ctx.sandboxPolicy.overrideOf(bareChild.session)).toBe('read-only')
    expect(ctx.sessionProjections.stateOf(bareChild.session, 'permissions')?.preset).toBe('read-only')
    expect(ctx.approval.overrideOf(bareChild.session)).toBe('never')
  })

  it('renders delegated approval guidance from the same effective policy and Auto identity', async () => {
    const { ctx, parent, child } = await setup()
    applyDelegatedComposition(child.agent.ctx, {})
    const scope = scopeOf(child.agent.ctx)
    if (scope === undefined) throw new Error('expected the child composition scope')
    const render = async (withAgent = true) => renderContextSnapshot(await ctx.systemPrompt.assemble({
      scope, ...withAgent ? { agent: child.agent } : {},
    }))
    expect(await render(false)).toContain('delegated subagent')
    const route = ApprovalAnswererRouteId('delegation-guidance')
    ctx.approval.registerAnswererRoute(route, () => ({ agent: parent.agent, displaySubject: 'worker' }))
    ctx.approval.bindAnswererRoute(child.agent, route)
    expect(await render()).toContain('may be submitted through your configured answerer')
    expect(await render()).not.toContain('Auto review denial is final')
    ctx.permissionPresets.registerAuto(() => {})
    ctx.permissionPresets.set(parent.agent.session, 'auto')
    ctx.subagents.synchronizeContinuablePermissions(parent.agent, child.agent)
    expect(await render()).toContain('Auto review denial is final')
    setApprovalPolicy(parent.agent.session, 'never')
    expect(await render()).not.toContain('may be submitted through your configured answerer')
  })
  it('copies current modes without changing child approval or duplicating unchanged facts', async () => {
    const { ctx, parent, child } = await setup()
    const session = child.agent.session
    ctx.subagents.synchronizeContinuablePermissions(parent.agent, child.agent)
    expect(ctx.sandboxPolicy.overrideOf(session)).toBe('read-only')
    expect(ctx.sessionProjections.stateOf(session, 'permissions')?.preset).toBe('read-only')
    expect(ctx.approval.overrideOf(session)).toBe('never')
    const unchanged = session.seq
    ctx.subagents.synchronizeContinuablePermissions(parent.agent, child.agent)
    expect(session.seq).toBe(unchanged)
    ctx.permissionPresets.set(parent.agent.session, 'workspace-write')
    ctx.subagents.synchronizeContinuablePermissions(parent.agent, child.agent)
    expect(ctx.sandboxPolicy.overrideOf(session)).toBe('workspace-write')
    expect(ctx.sessionProjections.stateOf(session, 'permissions')?.preset).toBe('workspace-write')
    ctx.permissionPresets.registerAuto(() => {})
    ctx.permissionPresets.set(parent.agent.session, 'auto')
    ctx.subagents.synchronizeContinuablePermissions(parent.agent, child.agent)
    expect(ctx.sandboxPolicy.overrideOf(session)).toBe('danger-full-access')
    expect(ctx.permissionPresets.current(session)).toBe('auto')
    expect(ctx.approval.overrideOf(session)).toBe('never')
    setSandboxMode(parent.agent.session, 'read-only')
    ctx.subagents.synchronizeContinuablePermissions(parent.agent, child.agent)
    expect(ctx.sessionProjections.stateOf(session, 'permissions')?.preset).toBe('read-only')
    expect(ctx.sandboxPolicy.overrideOf(session)).toBe('read-only')
  })

  it.each(['sandbox', 'permissions'] as const)('rejects missing %s without appending partial state', async (missing) => {
    const { ctx, parent, child } = await setup(missing)
    const before = child.agent.session.seq
    expect(() => { ctx.subagents.synchronizeContinuablePermissions(parent.agent, child.agent) })
      .toThrow(/requires sandbox policy and permission presets/)
    expect(child.agent.session.seq).toBe(before)
  })

  it('rejects unrelated or released subjects without appending permission facts', async () => {
    const { ctx, parent, child } = await setup()
    const unrelated = await ctx.agents.create({ sessionId: SessionId('other-parent'), agentOptions: {} })
    expect(() => { ctx.subagents.synchronizeContinuablePermissions(unrelated.agent, child.agent) }).toThrow(/exact live direct parent/)
    const oldChild = child.agent
    await child.dispose()
    expect(() => { ctx.subagents.synchronizeContinuablePermissions(parent.agent, oldChild) }).toThrow(/exact live direct parent/)
    const oldParent = parent.agent
    await parent.dispose()
    expect(() => { ctx.subagents.synchronizeContinuablePermissions(oldParent, unrelated.agent) }).toThrow(/exact live direct parent/)
  })

  it('rejects a service composition without the live Agent registry', async () => {
    const { parent, child } = await setup()
    const empty = new Context()
    contexts.push(empty)
    await empty.plugin(SubagentRuntime)
    expect(() => { empty.subagents.synchronizeContinuablePermissions(parent.agent, child.agent) }).toThrow(/exact live direct parent/)
  })
})
