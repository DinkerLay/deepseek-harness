/**
 * Service Definition for the approval capability seam, covering requests, cancellation, audit, and per-session policy. Missing
 * answerers fail closed; grants apply only to the requested action.
 * @module @deepseek-ai/dsh-user-approval
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'user-approval': { kind: 'user-approval' } & ContextFormed
  }
}

import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'

declare module '@deepseek-ai/cordis' {
  interface Context {
    approval: ApprovalService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's approval policy was switched — log-only, durable,
     * replayable, never in the model transcript (the model learns the policy
     * from the runtime-context snapshot and live switch notices). The LAST
     * such event is the session's override.
     * `source: 'delegation'` marks an override seeded into a child; an absent
     * source is a runtime switch.
     */
    'approval/policy': {
      policy: ApprovalPolicy
      /** Marks an override seeded into a child at delegation. */
      source?: 'delegation'
    }
    /** Optional Host route binding; ordinary Sessions do not write it. */
    'approval/answerer-route': { readonly version: 1; readonly routeId: ApprovalAnswererRouteId }
  }
}

import { ApprovalRequestId, ApprovalAnswererRouteId } from './types.ts'
import type { ApprovalOutcome, ApprovalRequestEvent } from './types.ts'

export { ApprovalRequestId, ApprovalAnswererRouteId } from './types.ts'
export type { ApprovalOutcome } from './types.ts'

/** Every {@link ApprovalOutcome}, for runtime normalization of answerer returns. */
const OUTCOMES: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/**
 * A session's approval policy — what happens to an {@link ApprovalService}
 * ask BEFORE any interactive answerer sees it:
 *
 * - `'ask'` (the default) — delegate to the composed answerers; with none
 *   composed the chain falls through to the fail-closed `'unavailable'`.
 * - `'never'` — never prompt anyone: every ask resolves `'rejected'`
 *   deterministically. The strict headless stance (CI, unattended runs) and
 *   the policy whose outcome is knowable without asking.
 */
export type ApprovalPolicy = 'ask' | 'never'

/** Every {@link ApprovalPolicy}, for option advertisement and runtime validation of untrusted policy strings. */
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['ask', 'never']

/** Model-facing statement for the deterministic `'never'` policy. */
const NEVER_SENTENCE = 'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'
/** Model-facing statement for an interactive policy that may still fail closed. */
const ASK_SENTENCE = 'Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.'

/**
 * Whether the log currently sits inside an open turn (a `turn/start` not yet
 * closed by a `turn/end`) — the {@link ApprovalService.request} precondition.
 * The audit pair must be turn-enclosed: the turn is the durable log's
 * commit/replay boundary, so a bare event appended between turns is
 * indistinguishable from a crash tail and silently dropped on reload.
 */
function hasOpenTurn(session: Session): boolean {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const type = session.eventAt(SessionSeq(seq))?.type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}

/**
 * Append the sole durable representation of a session policy override. Invalid
 * values throw before the log changes; consumers fold the new value on each read.
 * @param session - the session the override belongs to.
 * @param policy - the policy in effect until the next switch.
 */
export function setApprovalPolicy(session: Session, policy: ApprovalPolicy): void {
  if (!APPROVAL_POLICIES.includes(policy)) {
    throw new TypeError('approval policy must be one of "ask" or "never"')
  }
  session.append('approval/policy', { policy })
}

/**
 * Readonly same-process permission question. `callId` links to an already
 * presented tool call, so arguments are not duplicated here.
 */
export interface ApprovalRequest extends ApprovalRequestEvent {
  /**
   * The agent on whose behalf the question is asked. Routes the question (a
   * UI answerer only answers for agents it owns) and receives the audit
   * events on its session log.
   */
  readonly agent: Agent
  /** The tool the question is about (presentation and audit). */
  readonly toolName: string
  /**
   * The exact tool call being decided, when the asker has one — lets a UI
   * attach the prompt to the tool call it already streamed.
   */
  readonly callId?: ToolCallId
  /** The asker's human-readable explanation of WHY it is asking. */
  readonly reason?: string
  /**
   * Aborting withdraws the question: the request settles `'cancelled'`
   * immediately and a late answer from a still-pending answerer is discarded.
   */
  readonly signal?: AbortSignal
}

/** Current Host-resolved answerer and display data, independent of product policy. */
export interface ApprovalAnswererRoute {
  readonly agent: Agent
  readonly displaySubject: string
  readonly taskId?: string
  /** Optional provider-owned lookup of the exact operation in the origin's log. */
  readonly operation?: ApprovalRequestEvent['originOperation']
  /**
   * Revalidate the ownership and readiness captured by this route resolution.
   * The service checks it during lookup and immediately before recording a grant.
   * Policy changes alone must not invalidate an already-presented question.
   * @returns Whether this captured route still owns the decision; false or a thrown error rejects a grant.
   */
  isValid?(): boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { approvalAnswererRoute: ApprovalAnswererRouteId | null }
}

/** Optional call identity passed only when resolving an actual question. */
export type ApprovalRouteQuestion = Readonly<Pick<ApprovalRequest, 'callId' | 'toolName'>>

/** Plugin config. All optional — `static Config` supplies the defaults. */
export interface Config {
  /**
   * The deployment's default {@link ApprovalPolicy} for sessions without an
   * `approval/policy` override — `'ask'` delegates to the composed answerers
   * (fail-closed with none); `'never'` auto-rejects every ask without
   * prompting (the deterministic CI/unattended stance).
   */
  readonly policy?: ApprovalPolicy
}

/**
 * Approval service that applies session policy before answerers and logs every
 * ask/outcome pair to the requesting session. It exposes deterministic policy
 * changes to the model through the runtime-context snapshot and switch notices.
 */
export class ApprovalService extends Service {
  private readonly routes = new Map<ApprovalAnswererRouteId, {
    resolver: (origin: Agent, question?: ApprovalRouteQuestion) => ApprovalAnswererRoute | undefined
    controller: AbortController
  }>()
  static Config: z<Config> = z.object({
    policy: z.union(['ask', 'never'] as const).default('ask'),
  })

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'approval')
    ctx.inject(['sessionProjections'], (scope) => {
      scope.sessionProjections.register({ key: 'approvalAnswererRoute', stateVersion: 1,
        stateSchema: zod.string().transform(ApprovalAnswererRouteId).nullable(), init: () => null,
        apply: (state, event) => event.type === 'approval/answerer-route' ? event.data.routeId : state })
    })

    const effective = (agent: Agent): ApprovalPolicy => this.effectivePolicy(agent)

    // The complete current value travels after retained history, so switching
    // policy does not rewrite the stable system-prompt cache prefix.
    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'approval:policy',
        order: scope.systemPrompt.getContextOrder('APPROVAL_POLICY'),
        text: (context) => {
          const agent = context.agent
          // A bare assemble() (tests, diagnostics) has no session to state.
          if (agent === undefined) return ''
          const policy = effective(agent)
          return policy === 'never' ? NEVER_SENTENCE : ASK_SENTENCE
        },
      })
    })
  }

  /**
   * Switch one live agent's policy and queue the transition for its next model
   * step. Session initialization uses {@link setApprovalPolicy} directly
   * because there is no previously visible policy to change.
   * @param agent - the live agent whose policy is changing.
   * @param policy - the new effective policy.
   */
  setPolicy(agent: Agent, policy: ApprovalPolicy): void {
    const previous = this.ownPolicy(agent.session)
    if (previous === policy) return
    setApprovalPolicy(agent.session, policy)
    const message = createUserMessage({
      content: [{
        type: 'text',
        text: `The approval policy changed from "${previous}" to "${policy}" (changed by the user).`,
      }],
      source: { kind: 'user-approval' },
    })
    const agents = this.ctx.get('agents')
    if (agents === undefined) agent.inject(message)
    else agents.sendInputNotice(agent, { message, target: 'next-step', wakeup: false })
  }

  /**
   * Ask the composed answerers to decide one readonly same-process request.
   * The service borrows the request, agent, session, and live signal directly.
   * The request requires an open turn because the audit pair must be enclosed
   * by the durable log's commit/replay boundary; an idle ask rejects before
   * appending anything. The answerer phase always produces an outcome: an
   * aborted signal yields `'cancelled'`, a missing or throwing answerer yields
   * `'unavailable'` (fail closed), and a rogue non-vocabulary return value is
   * normalized to `'unavailable'`. A failure that prevents either audit append
   * from committing still rejects because returning an unlogged decision would
   * violate the pair. Session contains post-commit observer failures, so an
   * authoritative append cannot reject the request or suppress its matching
   * audit event.
   * A routed grant is accepted only while its captured route remains valid;
   * a false or throwing validity check records `rejected` instead.
   * @param req - the pending decision (agent, tool identity, reason, signal).
   * @returns the closed outcome; `'allowed-once'` is the only grant.
   * @throws when no turn is open or either audit event fails before the session
   *   append commit point.
   */
  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const session = req.agent.session
    if (!hasOpenTurn(session)) {
      throw new Error(
        'approval.request() outside an open turn: the approval/asked + approval/decided audit pair '
        + 'must be turn-enclosed (a bare event between turns is crash-tail garbage on reload). '
        + 'Ask from inside the turn that needs the decision.',
      )
    }
    const id = ApprovalRequestId(randomUUID())
    session.append('approval/asked', {
      id,
      toolName: req.toolName,
      ...req.callId !== undefined ? { callId: req.callId } : {},
      ...req.reason !== undefined ? { reason: req.reason } : {},
    })
    const decision = await this.decide(req, id)
    const outcome = decision.outcome === 'allowed-once' && decision.route !== undefined
      && !this.validRoute(decision.route) ? 'rejected' : decision.outcome
    session.append('approval/decided', { id, outcome })
    return outcome
  }

  /**
   * The session's effective policy: its own `approval/policy` fold, else the
   * configured default (the schema already defaulted an omitted policy to
   * `'ask'`; the `??` only narrows the optional-input TYPE).
   * @param session - the exact accepted session whose policy applies.
   * @returns the policy every ask for this session resolves under right now.
   */
  private ownPolicy(session: Session): ApprovalPolicy {
    return this.overrideOf(session) ?? this.config.policy ?? 'ask'
  }

  /**
   * Register an optional answerer lookup for its effect lifetime.
   * @param id - stable Host-owned route identity.
   * @param resolver - synchronous current-answerer lookup; undefined fails closed.
   * @returns disposer that also withdraws requests using this registration.
   */
  registerAnswererRoute(id: ApprovalAnswererRouteId,
    resolver: (origin: Agent, question?: ApprovalRouteQuestion) => ApprovalAnswererRoute | undefined): () => Promise<void> | undefined {
    return this.ctx.effect(() => {
      if (this.routes.has(id)) throw new Error(`approval answerer route ${id} is already registered`)
      const controller = new AbortController()
      this.routes.set(id, { resolver, controller })
      return () => { this.routes.delete(id); controller.abort(new Error('approval answerer route disposed')) }
    }, 'approval.answererRoute()')
  }

  /**
   * Bind an entered Session before its first model operation.
   * @param agent - exact originating Agent.
   * @param id - registered Host route identity.
   */
  bindAnswererRoute(agent: Agent, id: ApprovalAnswererRouteId): void {
    if (!this.routes.has(id)) throw new Error(`approval answerer route ${id} is unavailable`)
    const previous = this.routeOf(agent)
    if (previous === id) return
    if (previous !== undefined) throw new Error('approval Session is already bound to another answerer route')
    agent.session.append('approval/answerer-route', { version: 1, routeId: id })
  }

  /**
   * Read the durable answerer binding from projected state.
   * @param agent - originating Agent.
   * @returns its route binding, if any.
   */
  routeOf(agent: Agent): ApprovalAnswererRouteId | undefined {
    return this.ctx.get('sessionProjections')?.stateOf(agent.session, 'approvalAnswererRoute') ?? undefined
  }

  /**
   * Resolve the current interactive answerer.
   * @param agent - originating Agent.
   * @returns the routed answerer, or undefined.
   */
  answererOf(agent: Agent): Agent | undefined { return this.resolveRoute(agent)?.target.agent }

  /**
   * Read the policy used by both request decisions and model-facing statements.
   * @param agent - originating Agent.
   * @returns its own policy, or the current answerer's policy; unavailable routes use never.
   */
  effectivePolicy(agent: Agent): ApprovalPolicy {
    if (this.routeOf(agent) === undefined) return this.ownPolicy(agent.session)
    const routed = this.resolveRoute(agent)
    return routed === undefined ? 'never' : this.ownPolicy(routed.target.agent.session)
  }

  private resolveRoute(agent: Agent, question?: ApprovalRouteQuestion): { target: ApprovalAnswererRoute; signal: AbortSignal } | undefined {
    const id = this.routeOf(agent)
    if (id === undefined) return undefined
    const route = this.routes.get(id)
    if (route === undefined || route.controller.signal.aborted) return undefined
    try {
      const target = route.resolver(agent, question)
      if (target === undefined || target.agent === agent) return undefined
      const agents = this.ctx.get('agents')
      if (agents !== undefined && agents.get(target.agent.id) !== target.agent) return undefined
      if (!this.validRoute(target)) return undefined
      return { target, signal: route.controller.signal }
    } catch { return undefined }
  }

  private validRoute(target: ApprovalAnswererRoute): boolean {
    try { return target.isValid?.() ?? true } catch (_error: unknown) { return false }
  }

  /**
   * Read the session override without applying the configured default.
   * @param session - session whose log supplies the override.
   * @returns the last logged policy, or `undefined` without one.
   */
  overrideOf(session: Session): ApprovalPolicy | undefined {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(SessionSeq(seq))
      if (event?.type === 'approval/policy') return event.data.policy
    }
    return undefined
  }

  /**
   * Dispatch the waterfall, contained and raced against the request signal.
   * @param req - the borrowed public request.
   * @param id - original audit identity forwarded to a routed answerer.
   * @returns the normalized outcome and captured route for the final grant check.
   */
  private async decide(req: ApprovalRequest, id: ApprovalRequestId): Promise<{
    outcome: ApprovalOutcome
    route?: ApprovalAnswererRoute
  }> {
    const binding = this.routeOf(req.agent)
    const resolved = binding === undefined ? undefined : this.resolveRoute(req.agent, req)
    const routed = resolved === undefined ? undefined : { ...resolved,
      signal: AbortSignal.any([resolved.signal, ...req.signal === undefined ? [] : [req.signal]]) }
    const signal = routed?.signal ?? req.signal
    const decision = (outcome: ApprovalOutcome) => ({ outcome, ...routed === undefined ? {} : { route: routed.target } })
    if (signal?.aborted) return decision('cancelled')
    // The 'never' policy is decided HERE, before any dispatch: a listener
    // registered with `prepend: true` after this service mounts would sit
    // ahead of any gate LISTENER, so a listener-shaped gate cannot keep the
    // documented promise that 'never' rejects deterministically regardless
    // of registration order — only the service's own request path can.
    if (binding !== undefined && routed === undefined) return decision('rejected')
    const answerer = routed?.target.agent ?? req.agent
    if (this.ownPolicy(answerer.session) === 'never') return decision('rejected')
    const operation = routed?.target.operation
    const forwarded: ApprovalRequest = routed === undefined ? req : {
      ...req, agent: answerer, originSessionId: req.agent.id, approvalRequestId: id,
      ...req.callId === undefined ? {} : { originCallId: req.callId },
      displaySubject: routed.target.displaySubject,
      ...routed.target.taskId === undefined ? {} : { taskId: routed.target.taskId },
      ...operation === undefined ? {} : { originOperation: operation },
      signal: routed.signal,
    }
    // Enter the promise chain BEFORE dispatching: a listener that throws
    // SYNCHRONOUSLY (before its first await) must land in the same rejection
    // path as an async one — `Promise.resolve(call())` would let it escape
    // the containment into the caller.
    const answer: Promise<ApprovalOutcome> = Promise.resolve().then(
      () => this.ctx.waterfall(
        scopeTarget(answerer, answerer), 'approval/request', forwarded,
        () => Promise.resolve<ApprovalOutcome>('unavailable'),
      ),
    ).then(
      // Normalize a rogue (non-vocabulary) answerer return to the fail-closed
      // outcome instead of leaking it into callers' closed-union switches.
      outcome => routed !== undefined && operation === undefined && outcome === 'allowed-once'
        ? 'rejected' : OUTCOMES.includes(outcome) ? outcome : 'unavailable',
      // A throwing answerer must fail the QUESTION closed, not the caller's
      // tool call open — the seam contains its callbacks.
      () => 'unavailable',
    )
    if (signal === undefined) return decision(await answer)
    return decision(await new Promise<ApprovalOutcome>((resolve) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort)
        resolve('cancelled')
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void answer.then((outcome) => {
        signal.removeEventListener('abort', onAbort)
        // After an abort won the race this resolve is a settled-promise no-op:
        // the late answer is discarded by construction.
        resolve(outcome)
      })
    }))
  }
}

export default ApprovalService
