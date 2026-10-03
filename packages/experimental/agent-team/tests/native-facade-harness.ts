import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import type { SubagentSettlementNoticePolicy, SubagentSettlementNoticeFacts, SubagentSettlementNoticeWording } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { onTestFinished, vi } from 'vitest'
import TeamService, { type Config } from '../src/index.ts'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TestSessionQuery } from './test-session-query.ts'

/** Native facade test resources, including real Preset leases and Session storage. */
export async function nativeFacadeHarness(options: {
  config?: Config
  leadPresetId?: string
  seed?: readonly SessionEvent[]
  script?: ConstructorParameters<typeof MockAdapter>[0]
} = {}) {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-facade-'))
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentPresets, { default: 'standard' })
  await ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await ctx.agentPresets.register({ id: 'reviewer', plugins: [{
    name: new URL('../../../subagent/subagent-in-process-driver/tests/fixtures/plugins/preset-tool.js', import.meta.url).href,
    config: { tool: 'review_only' },
  }] })
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  let policy: SubagentSettlementNoticePolicy | undefined
  let wording: ((facts: SubagentSettlementNoticeFacts) => SubagentSettlementNoticeWording | undefined) | undefined
  const register = ctx.subagents.registerSettlementNoticePolicy.bind(ctx.subagents)
  const capture = vi.spyOn(ctx.subagents, 'registerSettlementNoticePolicy').mockImplementation((decide, fallback) => {
    policy = decide
    wording = fallback
    return register(decide, fallback)
  })
  const fiber = ctx.plugin(TeamService, options.config ?? {})
  try { await fiber } finally { capture.mockRestore() }
  if (policy === undefined || wording === undefined) throw new Error('native settlement policies were not installed')
  const adapter = new MockAdapter(options.script ?? [])
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agents.create({ sessionId: SessionId('facade-anchor'),
    agentOptions: { provider: 'mock', model: 'mock' },
    ...options.seed === undefined ? {} : { seed: options.seed },
    setup: async (scoped) => {
      const presets = scoped.get('agentPresets')
      if (presets === undefined) throw new Error('native facade fixture requires Presets')
      await presets.mount(scoped, options.leadPresetId ?? 'standard')
    },
  })
  return { ctx, lead: lead.agent, adapter, fiber, policy, wording }
}

/** Controlled composition used by native facade and tool lifecycle tests. */
export const facadeControlledMode = { kind: 'controlled' as const, requiredTaskExtensionId: 'facade-writer',
  permissionTableId: 'facade-permissions', permissionRevision: 'revision-1', maxOrdinaryMessageBytes: 4096 }
