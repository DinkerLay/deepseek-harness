import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import Approval, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, onTestFinished } from 'vitest'
import Subagents from '../src/index.ts'

async function setup() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(Approval)
  await ctx.plugin(SandboxPolicy, { mode: 'read-only' })
  ctx.provide('shell', { sandboxMode: 'read-only' } as never)
  await ctx.plugin(PermissionPresets, { defaultPreset: 'read-only', presets: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  } })
  await ctx.plugin(Subagents)
  const parent = await ctx.agents.create({ sessionId: SessionId('settings-anchor'), agentOptions: { subagentDepth: 0 } })
  const source = await ctx.agents.create({ sessionId: SessionId('settings-execution'),
    meta: { parentSession: parent.agent.id, agentPreset: 'execution-preset' }, agentOptions: { subagentDepth: 0 } })
  const child = await ctx.agents.create({ sessionId: SessionId('settings-member'), parentAgent: parent.agent,
    meta: { parentSession: parent.agent.id, origin: 'subagent', agentPreset: 'member-preset', delegationDepth: 1 },
    agentOptions: { subagentDepth: 1 } })
  setApprovalPolicy(child.agent.session, 'never')
  return { ctx, parent, source, child }
}

describe('continuable settings source', () => {
  it('takes current settings from an ordinary execution while retaining real parent, depth, Preset and approval', async () => {
    const { ctx, parent, source, child } = await setup()
    ctx.permissionPresets.set(source.agent.session, 'workspace-write')
    const header = child.agent.session.header
    const options = child.agent.options
    ctx.subagents.synchronizeContinuablePermissions(parent.agent, child.agent, source.agent)
    expect(ctx.sessionProjections.stateOf(child.agent.session, 'permissions')?.preset).toBe('workspace-write')
    expect(ctx.sandboxPolicy.overrideOf(child.agent.session)).toBe('workspace-write')
    expect(ctx.permissionPresets.current(parent.agent.session)).toBe('read-only')
    expect(ctx.approval.overrideOf(child.agent.session)).toBe('never')
    expect(child.agent.session.header).toBe(header)
    expect(child.agent.session.header).toMatchObject({ parentSession: parent.agent.id, agentPreset: 'member-preset', delegationDepth: 1 })
    expect(child.agent.options).toBe(options)
    expect(ctx.agents.roots()).toContain(parent.agent)
    expect(ctx.agents.roots()).not.toContain(child.agent)
    expect(ctx.agents.isOwnedBy(child.agent.id, parent.agent)).toBe(true)
    expect(ctx.agents.isOwnedBy(child.agent.id, source.agent)).toBe(false)
    const unchanged = child.agent.session.seq
    ctx.subagents.synchronizeContinuablePermissions(parent.agent, child.agent, source.agent)
    expect(child.agent.session.seq).toBe(unchanged)
    ctx.permissionPresets.set(source.agent.session, 'danger-full-access')
    ctx.subagents.synchronizeContinuablePermissions(parent.agent, child.agent, source.agent)
    expect(ctx.permissionPresets.current(child.agent.session)).toBe('danger-full-access')
    expect(ctx.approval.overrideOf(child.agent.session)).toBe('never')
  })

  it('keeps default synchronization on the actual parent', async () => {
    const { ctx, parent, source, child } = await setup()
    ctx.permissionPresets.set(parent.agent.session, 'workspace-write')
    ctx.permissionPresets.set(source.agent.session, 'danger-full-access')
    ctx.subagents.synchronizeContinuablePermissions(parent.agent, child.agent)
    expect(ctx.sessionProjections.stateOf(child.agent.session, 'permissions')?.preset).toBe('workspace-write')
  })

  it('rejects a detached settings source before writing partial policy facts', async () => {
    const { ctx, parent, source, child } = await setup()
    const previous = child.agent.session.seq
    await source.dispose()
    expect(() => { ctx.subagents.synchronizeContinuablePermissions(parent.agent, child.agent, source.agent) })
      .toThrow(/exact live settings source/)
    expect(child.agent.session.seq).toBe(previous)
  })

  it('does not accept the settings owner as a substitute parent', async () => {
    const { ctx, parent, source, child } = await setup()
    const previous = child.agent.session.seq
    expect(() => { ctx.subagents.synchronizeContinuablePermissions(source.agent, child.agent, source.agent) })
      .toThrow(/exact live direct parent/)
    expect(child.agent.session.seq).toBe(previous)
    expect(child.agent.session.header.parentSession).toBe(parent.agent.id)
    expect(ctx.agents.roots()).not.toContain(child.agent)
  })
})
