/** Detached original-input observations shared by native execution occupations. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, StoredInputCustodySnapshot } from '@deepseek-ai/dsh-agent'

/** Read the actual occupied driver without exporting its Agent or writable Session.
 * @param ctx - native input owner containing the registered controller state.
 * @param agent - exact live execution retained by the caller's maintenance scope.
 * @returns detached header, events and original pending-input facts.
 */
export function readLiveExecution(ctx: Context, agent: Agent): StoredInputCustodySnapshot {
  // oxlint-disable-next-line typescript/no-deprecated -- Occupation owns this driver cut; consumers receive only detached facts.
  return structuredClone({ header: agent.session.header, events: agent.session.snapshotEvents(),
    inheritedEventCount: agent.session.inheritedEventCount, inputControl: ctx.agents.inputControlState(agent.session),
    pending: [...agent.inbox.nextStep.map(message => ({ target: 'next-step' as const, message })),
      ...agent.inbox.nextTurn.map(message => ({ target: 'next-turn' as const, message }))] })
}
