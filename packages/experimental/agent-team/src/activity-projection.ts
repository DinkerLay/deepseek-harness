/** Lightweight Client invalidation without publishing the Host's Team records. */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TeamActivitySignal } from './types.ts'

const signalSchema = z.object({ revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()

/** Advance after committed roster, Task, or mailbox changes in the Lead Session. */
export const teamActivityProjectionDefinition = {
  key: 'agentTeamActivity',
  stateVersion: 1,
  stateSchema: signalSchema,
  init: (): TeamActivitySignal => ({ revision: 0 }),
  apply: (state, event) => event.type === 'team/task' || event.type === 'team/task/managed' || event.type === 'team/member'
    || event.type === 'team/member/configured'
    || event.type === 'team/message/queued' || event.type === 'team/message/queued-task'
    || event.type === 'team/message/delivered'
    ? { revision: state.revision + 1 }
    : state,
  wire: { viewSchema: signalSchema, view: (state): TeamActivitySignal => state },
} satisfies ProjectionDefinition<'agentTeamActivity', TeamActivitySignal>
