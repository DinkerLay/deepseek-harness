/** Test-only Host coordination at the original Team tool's dispatch boundary. */
import { TeamTaskId, TeamLeadOperationId } from '@deepseek-ai/dsh-experimental-agent-team'

export const name = 'team-freeze-admission'
export const inject = ['agents', 'agentTeams']

/** Install owned coordination; only the external conversation model is replayed.
 * @param {import('@deepseek-ai/cordis').Context} ctx - scenario composition.
 */
export function apply(ctx) {
  const owner = ctx.agentTeams.installLeadExecutions({
    resolveAnchor: async id => {
      const anchor = ctx.agents.get(id)
      if (anchor === undefined) throw new Error('snapshot anchor is not loaded')
      return anchor
    },
    isReady: () => true,
  })
  const coordinator = ctx.agentTeams.installLeadCoordinator({ id: 'snapshot-coordinator' })
  ctx.effect(() => () => coordinator.dispose())
  ctx.effect(() => () => owner.dispose())
  const unavailable = async () => { throw new Error('snapshot does not update Tasks') }
  ctx.effect(() => ctx.agentTeams.installTaskExtension({ id: 'snapshot-task-writer',
    create: async (caller, request, handle) => {
      const [task] = await handle.commit(caller, snapshot => ({ dataJson: '{}', updates: [{ previousRevision: null,
        task: { id: TeamTaskId(`task-${snapshot.nextTaskNumber}`), revision: 1, subject: request.subject,
          description: request.description, status: 'pending', blockedBy: [], writeScopes: [] } }] }))
      if (task === undefined) throw new Error('snapshot Task commit returned no task')
      return task
    }, update: unavailable }).dispose)
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession === undefined) await owner.prepareAnchor(agent)
  })
  const frozen = new WeakSet()
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'team_task_create' || exec.agent === undefined || frozen.has(exec.agent)) return await next()
    const anchor = exec.agent
    frozen.add(anchor)
    await coordinator.record(anchor, { operationId: TeamLeadOperationId('snapshot-handoff'), previousTerm: 1,
      phase: 'requested', recordId: 'snapshot-requested', dataJson: '{}' })
    await coordinator.record(anchor, { operationId: TeamLeadOperationId('snapshot-handoff'), previousTerm: 1,
      phase: 'frozen', recordId: 'snapshot-frozen', dataJson: '{}' })
    return await next()
  }, { global: true })
}
