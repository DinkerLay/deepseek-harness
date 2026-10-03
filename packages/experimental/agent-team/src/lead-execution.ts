/** Host-only identity fold for an ordinary, unseeded Lead execution. */

import { z } from 'zod'
import { SessionId, type SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { TeamId } from './types.ts'

/** Immutable identity written before a prepared execution is published. */
export interface TeamLeadExecutionIdentity {
  /** Identity payload version; this does not change Session format 4. */
  readonly version: 1
  /** Stable Team anchor, also the execution's durable parent. */
  readonly teamId: TeamId
  /** Candidate Lead term after the initial anchor's term one. */
  readonly term: number
  /** Preset id fixed in the execution's Session header. */
  readonly presetId: string
  /** SHA-256 declaration revision captured by the composition lease. */
  readonly revision: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Ordinary execution identity; presence alone grants no Lead authority. */
    'team/lead/execution': TeamLeadExecutionIdentity
  }
}

/** Host-owned derived state; no client view or second Team journal. */
export interface LeadExecutionRecord {
  readonly sessionId: SessionId
  readonly inheritedEventCount: SessionLogOffset
  readonly parentSession?: SessionId | undefined
  readonly presetId?: string | undefined
  readonly origin?: string | undefined
  readonly seeded: boolean
  readonly eligible: boolean
  readonly identity: TeamLeadExecutionIdentity | null
  readonly failure?: string | undefined
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { teamLeadExecutionRecord: LeadExecutionRecord }
}

const identitySchema = z.object({
  version: z.literal(1),
  teamId: z.string().min(1).transform(value => TeamId(value)),
  term: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  presetId: z.string().min(1),
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

const sessionIdSchema = z.custom<SessionId>(value => typeof value === 'string' && value.length > 0)
const offsetSchema = z.custom<SessionLogOffset>(value => Number.isSafeInteger(value) && Number(value) >= 0)

/** Incremental identity validation that excludes a fork-inherited prefix. */
export const leadExecutionProjection: ProjectionDefinition<'teamLeadExecutionRecord'> = {
  key: 'teamLeadExecutionRecord',
  stateVersion: 1,
  stateSchema: z.object({
    sessionId: sessionIdSchema,
    inheritedEventCount: offsetSchema,
    parentSession: sessionIdSchema.optional(),
    presetId: z.string().optional(),
    origin: z.string().optional(),
    seeded: z.boolean(),
    eligible: z.boolean(),
    identity: identitySchema.nullable(),
    failure: z.string().optional(),
  }).strict(),
  init: (header, inheritedEventCount) => ({
    sessionId: header.id, inheritedEventCount,
    ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
    ...header.agentPreset === undefined ? {} : { presetId: header.agentPreset },
    ...header.origin === undefined ? {} : { origin: header.origin },
    seeded: header.isSeeded, eligible: true, identity: null,
  }),
  apply: (state, event) => {
    if (event.seq < state.inheritedEventCount || state.failure !== undefined) return state
    if (event.type !== 'team/lead/execution') {
      return state.eligible && (event.type.startsWith('team/') || event.type === 'turn/start'
        || event.type === 'user/message' || event.type === 'request/header')
        ? { ...state, eligible: false }
        : state
    }
    const parsed = identitySchema.safeParse(event.data)
    if (!parsed.success) return { ...state, failure: parsed.error.message }
    if (state.identity !== null) return { ...state, failure: 'duplicate Lead execution identity' }
    if (!state.eligible) return { ...state, failure: 'Lead identity must precede Team and model activity' }
    if (state.seeded || state.origin === 'subagent') {
      return { ...state, failure: 'Lead execution must be ordinary and unseeded' }
    }
    const identity = parsed.data
    const anchorId = SessionId(identity.teamId)
    if (state.parentSession !== anchorId || state.sessionId === anchorId) {
      return { ...state, failure: 'Lead execution anchor must match its distinct durable parent' }
    }
    if (state.presetId !== identity.presetId) {
      return { ...state, failure: 'Lead execution Preset must match its immutable header' }
    }
    return { ...state, identity }
  },
}
