# User Approval

English | [中文](approval.zh.md)

The user-approval seam of [dsh-user-approval](../../packages/interaction/user-approval) answers one question: may this specific action proceed? It owns the shared request/outcome vocabulary, the `ctx.approval` dispatch service, the `approval/request` answerer waterfall, the log-only audit pair, and the per-session `ask`/`never` policy. UI channels may provide human answerers; the [ACP automation bridge](../../packages/acp/acp) provides one-shot machine decisions for its own agents. Callers such as [dsh-tools](../../packages/core/tools) and [dsh-tool-bash](../../packages/shell/tool-bash) consume the closed outcome and fail closed unless it is `allowed-once`.

Source: [`packages/interaction/user-approval/src/index.ts`](../../packages/interaction/user-approval/src/index.ts)

## Identity and outcome

Every request receives a fresh `ApprovalRequestId`. The brand pairs the `approval/asked` and `approval/decided` audit events without making approval ids interchangeable with tool-call or agent/session ids.

```ts type-equiv
/**
 * Pairs one `approval/asked` with its normal decision or interrupted rejection.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
type ApprovalRequestId = Branded<'ApprovalRequestId'>
```

`ApprovalOutcome` is closed and fail-closed. `allowed-once` grants only the asked-about action; callers deny on `rejected`, `cancelled`, and `unavailable`. A missing, non-owning, throwing, or non-conforming answerer becomes `unavailable` rather than opening the gate.

```ts type-equiv
/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, withdrawn
 * request, or unavailable answerer. Callers fail closed on `unavailable`.
 */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
```

## Per-session policy

`ApprovalPolicy` determines what happens before interactive answerers run. `ask` delegates to the composed answerer chain, whose no-answer default is `unavailable`; `never` deterministically returns `rejected` without dispatching any answerer. The effective value is the last `approval/policy` event in the session log, falling back to the service config. Consumers read it with `ctx.approval.effectivePolicy(session)`; `setApprovalPolicy(session, policy)` is the single write path, so replay reconstructs the override.

```ts type-equiv
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
type ApprovalPolicy = 'ask' | 'never'
```

Both policies contribute their complete current meaning to the cache-safe runtime-context snapshot. The sourced `user/message` is the durable model-visible input; changing approval state appends a new full snapshot after retained history without touching the `system/message` nodes that hold the rendered system prompt.

## Approval request

`ApprovalRequest` identifies the agent and tool action closely enough to route and audit the question. It deliberately omits tool arguments: an answerer attaches the prompt to the already-streamed tool call through `callId` instead of rendering a second copy that could drift. Optional `displayReason` carries requester-owned locale strings to presentation; `reason` remains the audit text.

```ts type-equiv
/**
 * Readonly same-process permission question. `callId` links to an already
 * presented tool call, so arguments are not duplicated here.
 */
interface ApprovalRequest extends ApprovalRequestEvent {
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
   * Aborting withdraws the question immediately; an unrouted request or a
   * still-valid captured route settles `cancelled`. Host forced denial or an
   * invalid captured route settles `rejected` instead. A late answer is discarded.
   */
  readonly signal?: AbortSignal
}
```

## Dispatch and audit

`ctx.approval.request(req)` requires the requesting session to be inside an open turn. It appends `approval/asked`, obtains one outcome, appends the matching `approval/decided`, and resolves with that outcome. The `never` policy is enforced inside the service before waterfall dispatch, so even an answerer registered later with `prepend` cannot bypass it. Answerers return an outcome when they own the request or call `next()` to delegate; the first answer occupies the single decision slot.

The audit events are log-only and do not enter the model transcript. Model-visible behavior is the caller's derived tool result plus the current runtime-context snapshot. Service disposal removes its context contribution; answerer listeners are independently effect-bound to their owning plugins.

Host coordinators can query detached pending-request identities and reject an exact routed request without acting as its human answerer. Rejection claims the same one-shot terminal decision as an ordinary answer, records the original Session's audit before withdrawing the card, and requires confirmed durability. A captured route that is no longer valid returns explicit rejection; policy changes alone do not invalidate an already-presented question. Cold recovery checks only retained original identities and uses `approval/interrupted-rejected` after the original turn has ended, without starting a model, fabricating a turn or changing an existing terminal outcome.

```ts type-equiv
/** Detached Host view of one unanswered request; no Agent, callback or live signal is exposed. */
interface PendingApprovalRequest {
  readonly id: ApprovalRequestId
  readonly originSessionId: SessionId
  readonly answererSessionId: SessionId
  readonly askedSeq: SessionSeq
  readonly toolName: string
  readonly callId?: ToolCallId
  readonly routeId?: ApprovalAnswererRouteId
}
```

```ts type-equiv
/** Optional exact-id filters for the Host's live pending-request view. */
interface PendingApprovalQuery {
  readonly originSessionId?: SessionId
  readonly answererSessionId?: SessionId
  readonly routeId?: ApprovalAnswererRouteId
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxapproval--approvalservice"></a>

### `ctx.approval` — `ApprovalService`

Approval service that applies session policy before answerers and logs every ask/outcome pair to the requesting session. It exposes deterministic policy changes to the model through the runtime-context snapshot and switch notices.

```ts cordis-catalog
/**
 * Switch one live agent's policy and queue the transition for its next model
 * step. Session initialization uses {@link setApprovalPolicy} directly
 * because there is no previously visible policy to change.
 * @param agent - the live agent whose policy is changing.
 * @param policy - the new effective policy.
 */
setPolicy(agent: Agent, policy: ApprovalPolicy): void

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
 * A captured routed decision becomes `rejected` when its validity check
 * returns false or throws, including a cancelled or unavailable answer.
 * @param req - the pending decision (agent, tool identity, reason, signal).
 * @returns the closed outcome; `'allowed-once'` is the only grant.
 * @throws when no turn is open or either audit event fails before the session
 *   append commit point.
 */
async request(req: ApprovalRequest): Promise<ApprovalOutcome>

/** Read unanswered requests without returning borrowed Agents, signals or callbacks.
 * @param query - optional exact originating Session, answering Session or route filters.
 * @returns detached request identities; a claimed rejection is no longer unanswered even if its flush needs retry.
 */
pendingRequests(query: PendingApprovalQuery = {}): readonly PendingApprovalRequest[]

/** Reject one exact live routed question, recording the origin's rejection before withdrawing its card.
 * Normal answers and this method share one terminal decision; a late answer cannot grant after rejection claims it.
 * @param origin - exact originating Agent retained by the request, not its answerer.
 * @param id - service-issued question id captured from the pending view.
 * @returns true after rejection durability is confirmed; false for absent, unrelated, unrouted or already normally settled requests.
 * @throws when rejection audit or durability fails; retrying the same retained request reconfirms without another terminal event.
 */
async rejectPending(origin: Agent, id: ApprovalRequestId): Promise<boolean>

/** Reconfirm or write a captured routed question's explicit rejection after its original turn has ended.
 * The caller owns the quiet original Session and its writer; this method never activates an Agent or opens a turn.
 * @param session - exact originating Session loaded by the Host recovery owner.
 * @param captured - identity, route and asked sequence retained before interruption; other requests are untouched.
 * @returns true only after the existing or new rejection flush succeeds;
 *   false for mismatched facts, active requests or other terminal outcomes.
 * @throws when the audit projection is unavailable/invalid or durability is unconfirmed; retries never append a second rejection.
 */
async rejectInterrupted(session: Session, captured: PendingApprovalRequest): Promise<boolean>

/** Reject one captured offline question without activating its originating Agent.
 * This service acquires the original Session's atomic write lease, repairs its interrupted turn,
 * and appends only the exact rejection suffix. It never writes into the answerer or a replacement execution.
 * @param captured - original request facts retained by the Host coordinator.
 * @param signal - optional cancellation; acquired writers always close to quiescence, including late acquisition.
 * @returns true after the original writer's durability barrier and close; false for live identities or mismatched/other terminal facts.
 * @throws on unavailable persistence, writer conflict, cancellation or I/O failure;
 *   retries reread the original log and do not duplicate a terminal.
 */
rejectInterruptedStored(captured: PendingApprovalRequest, signal?: AbortSignal): Promise<boolean>

/**
 * Register an optional answerer lookup for its effect lifetime.
 * @param id - stable Host-owned route identity.
 * @param resolver - synchronous current-answerer lookup; undefined fails closed.
 * @returns disposer that also withdraws requests using this registration.
 */
registerAnswererRoute(id: ApprovalAnswererRouteId, resolver: (origin: Agent, question?: ApprovalRouteQuestion) => ApprovalAnswererRoute | undefined): () => Promise<void> | undefined

/**
 * Bind an entered Session before its first model operation.
 * @param agent - exact originating Agent.
 * @param id - registered Host route identity.
 */
bindAnswererRoute(agent: Agent, id: ApprovalAnswererRouteId): void

/**
 * Read the durable answerer binding from projected state.
 * @param agent - originating Agent.
 * @returns its route binding, if any.
 */
routeOf(agent: Agent): ApprovalAnswererRouteId | undefined

/**
 * Resolve the current interactive answerer.
 * @param agent - originating Agent.
 * @returns the routed answerer, or undefined.
 */
answererOf(agent: Agent): Agent | undefined

/**
 * Read the policy used by both request decisions and model-facing statements.
 * @param agent - originating Agent.
 * @returns its own policy, or the current answerer's policy; unavailable routes use never.
 */
effectivePolicy(agent: Agent): ApprovalPolicy

/**
 * Read the session override without applying the configured default.
 * @param session - session whose log supplies the override.
 * @returns the last logged policy, or `undefined` without one.
 */
overrideOf(session: Session): ApprovalPolicy | undefined
```

Types: [Agent](core.md) · [Session](session.md)

Source: [`packages/interaction/user-approval/src/index.ts`](../../packages/interaction/user-approval/src/index.ts)

<a id="approval-events"></a>

### `approval/*` events

<a id="approvalrequest--waterfall"></a>

#### `approval/request` — waterfall

Ask composed answerers for one decision. Return an outcome to claim the request or call `next()` to delegate. Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.

```ts cordis-catalog
/**
 * Ask composed answerers for one decision. Return an outcome to claim the
 * request or call `next()` to delegate. Scope-filtered dispatch
 * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @param req - pending approval request.
 * @mode waterfall
 */
'approval/request'( this: Scoped<Agent>, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>, ): Promise<ApprovalOutcome>
```

Types: [Agent](core.md) · [Scoped](scope.md)

Source: [`packages/interaction/user-approval/src/types.ts`](../../packages/interaction/user-approval/src/types.ts)
<!-- END GENERATED cordis-surface -->
