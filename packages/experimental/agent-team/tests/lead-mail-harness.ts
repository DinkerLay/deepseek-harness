import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamId } from '../src/index.ts'
import type { Config, LeadExecutionHandle, LeadExecutionProvider } from '../src/index.ts'
import { facadeControlledMode, nativeFacadeHarness } from './native-facade-harness.ts'
import type { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** Real JSONL/Loader/native execution fixture with replaceable owned resolution. */
export async function leadMailHarness(script: ConstructorParameters<typeof MockAdapter>[0] = [], options: {
  resources?: Awaited<ReturnType<typeof nativeFacadeHarness>>['resources']
  resume?: boolean
  config?: Omit<Config, 'controlledMode'>
} = {}) {
  const readiness = { ready: false }
  let owner!: LeadExecutionHandle
  let provider!: LeadExecutionProvider
  const beforeLead = (ctx: Context) => {
    provider = {
      resolveAnchor: async (id) => {
        const anchor = ctx.agents.get(id)
        if (anchor === undefined) throw new Error('test anchor is not loaded')
        return anchor
      },
      isReady: () => readiness.ready,
      resolveExecution: async (id, cancel) => {
        const live = ctx.agents.get(id)
        if (live !== undefined) return live
        using cut = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none',
          ...cancel === undefined ? {} : { signal: cancel } })
        await using preparation = await owner.prepareActivation(cut)
        return (await ctx.agents.resume({ resumeSessionId: id,
          agentOptions: { provider: 'mock', model: 'mock' }, ...cancel === undefined ? {} : { signal: cancel },
          ...preparation === undefined ? {} : { setup: preparation.setup } })).agent
      },
    }
    owner = ctx.agentTeams.installLeadExecutions(provider)
  }
  const test = await nativeFacadeHarness({ ...options,
    config: { ...options.config, controlledMode: facadeControlledMode }, script, beforeLead })
  await owner.prepareAnchor(test.lead)
  const revision = (await test.ctx.agentPresets.acquireComposition('reviewer'))
  const capturedRevision = revision.revision
  await revision[Symbol.asyncDispose]()
  if (capturedRevision === undefined) throw new Error('reviewer requires a declaration revision')
  const create = (id: string, term: number) => owner.create(test.lead, { sessionId: SessionId(id), term,
    presetId: 'reviewer', revision: capturedRevision, agentOptions: { provider: 'mock', model: 'mock' } })
  const commit = async (handle: AgentHandle, previousTerm: number) => {
    test.lead.session.append('team/lead/transaction', { version: 1, teamId: TeamId(test.lead.id), previousTerm,
      binding: { executionId: handle.agent.id, term: previousTerm + 1, presetId: 'reviewer', revision: capturedRevision },
      extension: { id: facadeControlledMode.requiredTaskExtensionId, dataJson: '{}' }, releases: [] })
    await test.ctx.sessions.flush(test.lead.session)
  }
  const state = () => {
    const value = test.ctx.sessionProjections.stateOf(test.lead.session, 'agentTeam')
    if (value === undefined || value.failure !== undefined) throw new Error('Team projection is invalid')
    return value
  }
  const replaceProvider = async (overrides: Partial<LeadExecutionProvider>, omitResolver = false) => {
    await owner.dispose()
    const withoutResolver = { ...provider }
    Reflect.deleteProperty(withoutResolver, 'resolveExecution')
    provider = { ...omitResolver ? withoutResolver : provider, ...overrides }
    owner = test.ctx.agentTeams.installLeadExecutions(provider)
    return owner
  }
  return { ...test, get owner() { return owner }, get provider() { return provider }, readiness,
    create, commit, state, replaceProvider }
}
