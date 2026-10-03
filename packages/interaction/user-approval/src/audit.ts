/** Host fold of approval identity, original route and sole terminal outcome for exact-request recovery. */
import { z } from 'zod'
import { SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionLogOffset as LogOffset, SessionSeq as Seq } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ToolCallId as CallId } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { ApprovalAnswererRouteId } from './types.ts'
import type { ApprovalOutcome } from './types.ts'

/** Original question facts and its sole terminal outcome; unmatched interrupted questions remain unsettled. */
export interface ApprovalAuditRecord {
  readonly askedSeq: Seq
  readonly turn: number
  readonly toolName: string
  readonly callId?: ToolCallId
  readonly routeId: ApprovalAnswererRouteId | null
  readonly outcome: ApprovalOutcome | null
}

/** Host-only approval audit; failure prevents recovery from accepting an ambiguous log. */
export interface ApprovalAuditState {
  readonly inheritedEventCount: LogOffset
  readonly openTurn: number | null
  readonly routeId: ApprovalAnswererRouteId | null
  readonly requests: Readonly<Record<string, ApprovalAuditRecord>>
  readonly failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { approvalAudit: ApprovalAuditState }
}

const routeIdSchema = z.string().min(1).transform(ApprovalAnswererRouteId).nullable()
const recordSchema = z.object({
  askedSeq: z.number().int().min(0).transform(SessionSeq), turn: z.number().int().min(1),
  toolName: z.string().min(1), callId: z.string().transform(CallId).optional(), routeId: routeIdSchema,
  outcome: z.enum(['allowed-once', 'rejected', 'cancelled', 'unavailable']).nullable(),
}).strict().transform((record): ApprovalAuditRecord => ({
  askedSeq: record.askedSeq, turn: record.turn, toolName: record.toolName, routeId: record.routeId, outcome: record.outcome,
  ...record.callId === undefined ? {} : { callId: record.callId },
}))

/** Fold exact locally-owned audit facts without exposing a second decision store to Clients. */
export const approvalAuditProjection: ProjectionDefinition<'approvalAudit'> = {
  key: 'approvalAudit', stateVersion: 1,
  stateSchema: z.object({
    inheritedEventCount: z.number().int().min(0).transform(SessionLogOffset),
    openTurn: z.number().int().min(1).nullable(), routeId: routeIdSchema,
    requests: z.record(z.string(), recordSchema), failure: z.string().optional(),
  }).strict().transform((state): ApprovalAuditState => ({
    inheritedEventCount: state.inheritedEventCount, openTurn: state.openTurn, routeId: state.routeId, requests: state.requests,
    ...state.failure === undefined ? {} : { failure: state.failure },
  })),
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, openTurn: null, routeId: null, requests: {} }),
  apply: (state, event) => {
    if (state.failure !== undefined) return state
    if (event.type === 'approval/answerer-route') return { ...state, routeId: event.data.routeId }
    if (event.seq < state.inheritedEventCount) return state
    if (event.type === 'turn/start') return { ...state, openTurn: event.data.turn }
    if (event.type === 'turn/end') return { ...state, openTurn: null }
    if (event.type === 'approval/asked') {
      if (state.openTurn === null || state.requests[event.data.id] !== undefined || event.data.toolName.length === 0) {
        return { ...state, failure: 'approval question has an invalid turn, identity or tool' }
      }
      return { ...state, requests: { ...state.requests, [event.data.id]: { askedSeq: event.seq, turn: state.openTurn,
        toolName: event.data.toolName, ...event.data.callId === undefined ? {} : { callId: event.data.callId },
        routeId: state.routeId, outcome: null } } }
    }
    if (event.type !== 'approval/decided' && event.type !== 'approval/interrupted-rejected') return state
    const prior = state.requests[event.data.id]
    if (prior === undefined || prior.outcome !== null) return { ...state, failure: 'approval terminal has no unmatched question' }
    if (event.type === 'approval/decided') {
      if (state.openTurn !== prior.turn) return { ...state, failure: 'approval decision is outside its original turn' }
    } else {
      const data: Readonly<Record<string, unknown>> = event.data
      if (data.version !== 1 || state.openTurn !== null || prior.routeId === null) {
        return { ...state, failure: 'interrupted approval rejection requires a closed routed question and version 1' }
      }
    }
    const outcome = event.type === 'approval/decided' ? event.data.outcome : 'rejected'
    return { ...state, requests: { ...state.requests, [event.data.id]: { ...prior, outcome } } }
  },
}
