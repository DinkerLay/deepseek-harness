# 用户审批

[English](approval.md) | 中文

[dsh-user-approval](../../packages/interaction/user-approval) 的用户审批 seam 回答一个问题：这个具体操作是否可以继续？它拥有共享的请求/结果词汇、`ctx.approval` 分发服务、`approval/request` 应答者 waterfall（瀑布式事件）、仅记录日志的审计事件对，以及按会话的 `ask`/`never` 策略。UI 通道可以提供人类应答者；[ACP（Agent Client Protocol）自动化桥接层](../../packages/acp/acp)为其拥有的 agent（智能体）提供一次性机器决策。调用方如 [dsh-tools](../../packages/core/tools) 和 [dsh-tool-bash](../../packages/shell/tool-bash) 消费闭合的结果，除非结果为 `allowed-once`，否则一律拒绝。

源码：[`packages/interaction/user-approval/src/index.ts`](../../packages/interaction/user-approval/src/index.ts)

## 标识与结果

每个请求都会获得一个全新的 `ApprovalRequestId`。该品牌类型将 `approval/asked` 与 `approval/decided` 审计事件配对，同时不会让审批 id 与工具调用 id 或 agent/会话 id 互换。

```ts type-equiv
/**
 * Pairs one `approval/asked` with its normal decision or interrupted rejection.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
type ApprovalRequestId = Branded<'ApprovalRequestId'>
```

`ApprovalOutcome` 是闭合的，且失败时拒绝。`allowed-once` 仅授权所询问的那一个操作；调用方对 `rejected`、`cancelled` 和 `unavailable` 均执行拒绝。缺失、不负责该请求、抛异常或不合规的应答者会产生 `unavailable`，而非放行。

```ts type-equiv
/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, withdrawn
 * request, or unavailable answerer. Callers fail closed on `unavailable`.
 */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
```

## 按会话策略

`ApprovalPolicy` 决定在交互式应答者运行之前发生什么。`ask` 委托给组合的应答者链，链的无应答默认值为 `unavailable`；`never` 确定性地返回 `rejected`，不分发任何应答者。生效值为会话日志中最后一条 `approval/policy` 事件，回退到服务配置。消费方通过 `ctx.approval.effectivePolicy(session)` 读取；`setApprovalPolicy(session, policy)` 是唯一的写入路径，因此回放能重建覆盖值。

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

两种策略都会将各自完整的当前含义贡献给缓存安全的运行时上下文快照。带来源的 `user/message` 是持久化且模型可见的输入；审批状态变化时，会在保留的历史后追加一份新的完整快照，而不触碰承载渲染后系统提示词的 `system/message` 节点。

## 审批请求

`ApprovalRequest` 以足够精确的方式标识 agent 和工具操作，以便路由和审计该问题。它有意省略工具参数：应答者通过 `callId` 将提示附加到已流式输出的工具调用上，而非渲染另一份可能漂移的副本。可选的 `displayReason` 向界面传递请求方提供的本地化字符串；`reason` 仍是审计文本。

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

## 分发与审计

`ctx.approval.request(req)` 要求发起请求的会话处于一个尚未结束的轮次内。它追加 `approval/asked`，获取一个结果，追加对应的 `approval/decided`，然后以该结果完成。`never` 策略在服务内部、waterfall 分发之前强制执行，因此即使后来以 `prepend` 注册的应答者也无法绕过它。应答者在负责处理该请求时返回结果，否则调用 `next()` 委托；第一个应答占据唯一的决策槽位。

审计事件仅写入日志，不进入模型 transcript（文本记录）。模型可见的行为是调用方派生的工具结果与当前运行时上下文快照。服务 dispose（资源释放）时会移除其上下文贡献；应答者监听器独立地通过 effect 绑定到其所属插件。

宿主协调器可以查询脱离实时对象的待答请求身份，并拒绝准确的路由请求，而不代替用户审批。拒绝与普通答复共用唯一终态：先在原 Session 记录审计，再撤下卡片，并要求持久确认。已失效的捕获路由返回明确拒绝；仅权限策略变化不撤销已展示的提问。冷恢复只核对保留的原请求身份，在原轮次结束后使用 `approval/interrupted-rejected`，不启动模型、不伪造轮次，也不改变已有终态。

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md) · [Session](session.zh.md)

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

Types: [Agent](core.zh.md) · [Scoped](scope.zh.md)

Source: [`packages/interaction/user-approval/src/types.ts`](../../packages/interaction/user-approval/src/types.ts)
<!-- END GENERATED cordis-surface -->
