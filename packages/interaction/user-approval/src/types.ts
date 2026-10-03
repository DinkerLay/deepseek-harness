/**
 * Wire-safe approval identifiers and outcome vocabulary, free of
 * cordis/service imports so browser type chains can
 * consume them without loading this package's Context augmentation.
 * @module @deepseek-ai/dsh-user-approval/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'

/**
 * Pairs one `approval/asked` with its normal decision or interrupted rejection.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/** Host-registered identity of an optional interactive answerer route. */
export type ApprovalAnswererRouteId = Branded<'ApprovalAnswererRouteId'>

/** Brand a stable Host answerer-route name.
 * @param id - stable Host route name.
 * @returns the branded route identity.
 */
export function ApprovalAnswererRouteId(id: string): ApprovalAnswererRouteId {
  return id as ApprovalAnswererRouteId
}

/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ApprovalRequestId(id: string): ApprovalRequestId {
  return id as ApprovalRequestId
}

/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, withdrawn
 * request, or unavailable answerer. Callers fail closed on `unavailable`.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Detached Host view of one unanswered request; no Agent, callback or live signal is exposed. */
export interface PendingApprovalRequest {
  readonly id: ApprovalRequestId
  readonly originSessionId: SessionId
  readonly answererSessionId: SessionId
  readonly askedSeq: SessionSeq
  readonly toolName: string
  readonly callId?: ToolCallId
  readonly routeId?: ApprovalAnswererRouteId
}

/** Optional exact-id filters for the Host's live pending-request view. */
export interface PendingApprovalQuery {
  readonly originSessionId?: SessionId
  readonly answererSessionId?: SessionId
  readonly routeId?: ApprovalAnswererRouteId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * An approval question was put to the answerer chain — log-only audit
     * (like `hook/*`; NOT a surface event, carries no `surfaceOp`). `id` pairs
     * it with its sole terminal decision or interrupted rejection; `toolName` is the
     * tool the question is about, `callId` the exact tool call when the asker
     * had one, `reason` the asker's human-readable explanation (e.g. a hook's
     * permission-decision reason).
     */
    'approval/asked': {
      id: ApprovalRequestId
      toolName: string
      callId?: ToolCallId
      reason?: string
    }
    /**
     * The outcome of a prior `approval/asked` (same `id`) — log-only audit.
     * Exactly one per ask, appended when the outcome is known: a decision, a
     * cancellation, or the fail-closed `'unavailable'`.
     */
    'approval/decided': {
      id: ApprovalRequestId
      outcome: ApprovalOutcome
    }
    /** Explicit Host rejection of a routed question whose original turn ended without a decision.
     * Log-only; exactly one terminal event may settle the original request id.
     */
    'approval/interrupted-rejected': { readonly version: 1; readonly id: ApprovalRequestId }
  }
}

/** Client-safe payload declared for the approval answerer waterfall. */
export interface ApprovalRequestEvent {
  /** Agent identity projected to the corresponding Client Context in transit. */
  readonly agent: Agent
  /** Tool whose operation requires a decision. */
  readonly toolName: string
  /** Exact tool call being decided, when available. */
  readonly callId?: ToolCallId
  /** Human-readable reason supplied by the asker. */
  readonly reason?: string
  /** Localized presentation only; never persisted in approval audit events. */
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  /** Withdrawal lifetime of the presentation; the service owns its audited outcome. */
  readonly signal?: AbortSignal
  /** Origin of a routed request; the waterfall Agent remains its answerer. */
  readonly originSessionId?: SessionId
  /** Identity of the audit pair in the originating Session. */
  readonly approvalRequestId?: ApprovalRequestId
  /** Exact originating native or PTC-bound call. */
  readonly originCallId?: ToolCallId
  /** Trusted Host subject label. */
  readonly displaySubject?: string
  /** Optional product-owned work label; absence means attribution is unknown. */
  readonly taskId?: string
  /** Exact operation copied from the origin's durable call; absent disables routed grants. */
  readonly originOperation?: { readonly name: string; readonly arguments: string }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask composed answerers for one decision. Return an outcome to claim the
     * request or call `next()` to delegate. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param req - pending approval request.
     * @mode waterfall
     */
    'approval/request'(
      this: Scoped<Agent>,
      req: ApprovalRequestEvent,
      next: () => Promise<ApprovalOutcome>,
    ): Promise<ApprovalOutcome>
  }
}
