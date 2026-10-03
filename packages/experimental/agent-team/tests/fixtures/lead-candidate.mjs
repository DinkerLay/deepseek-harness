import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'lead-candidate-fixture'
export const inject = ['agents', 'agentTeams', 'agentPresets', 'llm']

export async function apply(ctx) {
  const removePreset = await ctx.agentPresets.register({ id: 'snapshot-lead', plugins: [] })
  const executions = ctx.agentTeams.installLeadExecutions({ resolveAnchor: async id => {
    const anchor = ctx.agents.get(id)
    if (anchor === undefined) throw new Error('snapshot anchor is not live')
    return anchor
  } })
  const candidates = []
  ctx.effect(() => async () => {
    for (const candidate of candidates.toReversed()) await candidate.dispose()
    await executions.dispose()
    await removePreset()
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    if (!ctx.llm.listProviders().some(provider => provider.name === 'Lead Candidate Replay')) {
      throw new Error('lead-candidate snapshot requires its replay adapter')
    }
    const lease = await ctx.agentPresets.acquireComposition('snapshot-lead')
    try {
      if (lease.revision === undefined) throw new Error('snapshot Preset has no revision')
      const candidate = await executions.create(agent, { sessionId: SessionId(`${agent.id}-candidate`),
        term: 2, presetId: lease.id, revision: lease.revision, agentOptions: agent.options })
      candidates.push(candidate)
      if (ctx.agentTeams.tryMembership(candidate.agent) !== undefined || ctx.agents.canStartInput(candidate.agent)) {
        throw new Error('unbound snapshot candidate acquired Lead authority')
      }
    } finally {
      await lease[Symbol.asyncDispose]()
    }
  })
}
