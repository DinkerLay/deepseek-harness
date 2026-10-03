import { TeamLeadOperationId, TeamTaskId } from '../src/index.ts'
import type { TeamLeadCoordinatorHandle, TeamTaskExtensionHandle, TeamTaskTransactionUpdate } from '../src/index.ts'
import { leadMailHarness } from './lead-mail-harness.ts'

/** Existing real Loader, loop, JSONL and Preset fixture with independent native owners. */
export async function leadCoordinatorHarness(options: Parameters<typeof leadMailHarness>[1] = {},
  script: Parameters<typeof leadMailHarness>[0] = []) {
  const test = await leadMailHarness(script, options)
  test.readiness.ready = true
  const coordinator = test.ctx.agentTeams.installLeadCoordinator({ id: 'facade-coordinator' })
  const audit = { dataJson: '{}' }
  const writer: TeamTaskExtensionHandle = test.ctx.agentTeams.installTaskExtension({ id: 'facade-writer',
    planLeadRelease: () => audit.dataJson,
    create: async (caller, request, handle) => {
      const [created] = await handle.commit(caller, snapshot => ({ dataJson: '{}', updates: [{ previousRevision: null,
        task: { id: TeamTaskId(`task-${snapshot.nextTaskNumber}`), revision: 1, subject: request.subject,
          description: request.description, blockedBy: [], writeScopes: [], status: 'pending' } }] }))
      if (created === undefined) throw new Error('fixture Task was not created')
      return created
    },
    update: async () => { throw new Error('use the owned fixture writer for atomic updates') },
  })
  const stage = (phase: 'requested' | 'frozen' | 'ready' | 'cancelled' | 'failed',
    operationId = 'handoff-1', previousTerm = 1, owner: TeamLeadCoordinatorHandle = coordinator) => owner.record(test.lead, {
    operationId: TeamLeadOperationId(operationId), previousTerm, phase,
    recordId: `${operationId}-${phase}`, dataJson: JSON.stringify({ phase }),
  })
  const freeze = async (operationId = 'handoff-1', previousTerm = 1) => {
    await stage('requested', operationId, previousTerm)
    await stage('frozen', operationId, previousTerm)
  }
  const releases = async (): Promise<TeamTaskTransactionUpdate[]> => await writer.read(test.lead, snapshot => snapshot.tasks
    .filter(task => task.ownerId === test.lead.id && task.status === 'in_progress').map((task) => {
      const { ownerId: _owner, ...rest } = task
      return { previousRevision: task.revision, task: { ...rest, revision: task.revision + 1, status: 'pending' as const } }
    }))
  const safeRequest = (operationId = 'handoff-1', previousTerm = 1) => ({ operationId: TeamLeadOperationId(operationId), previousTerm,
    record: { recordId: `${operationId}-safe`, dataJson: '{}' }, readBlockers: () => [] })
  const binding = (agent: import('@deepseek-ai/dsh-agent').Agent) => {
    const identity = test.ctx.sessionProjections.stateOf(agent.session, 'teamLeadExecutionRecord')?.identity
    if (identity === null || identity === undefined) throw new Error('fixture candidate is not marked')
    return { executionId: agent.id, term: identity.term, presetId: identity.presetId, revision: identity.revision }
  }
  return { ...test, coordinator, writer, audit, binding, stage, freeze, releases, safeRequest }
}
