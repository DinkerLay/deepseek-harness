# Agent Teams

[English](agent-team.md) | 中文

实验性隐式 Root Team 领域、模型工具与宿主适配器共享的类型。[Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责身份、mailbox、task 与共享 checkout 决策；本页记录 [`packages/experimental/agent-team/src/types.ts`](../../packages/experimental/agent-team/src/types.ts) 中的持久与客户端可见形式。

## 身份与 roster

可选的稳定 Lead 席位用 `TeamLeadBinding` 保存执行 id、连续任期、Preset id 和声明修订。`TeamLeadSeat` 也表示第一任锚点，其 Preset 字段可能缺席。`LeadExecutionProvider` 准备锚点并提供当前就绪判断；拥有者获得 `LeadExecutionHandle`，用于创建普通候选、按准确修订冷准备，以及不唤醒的输入保留。此能力本身不实现产品交接流程。[包实现说明](../../packages/experimental/agent-team/README.zh.md#understand-the-implementation)负责身份及生命周期行为。

`TeamId` 是具有独立[品牌](core.zh.md#branded-ids)的 Root `SessionId`。`TeamTaskId` 在 Team 内按 `task-<n>` 单调分配；`TeamMessageId` 是全局随机值。teammate 最初的 Session id 始终是持久成员身份，而 `name` 是不可变的模型／UI 标签。`TeamMemberExecution` 将此地址与当前执行 id、连续代次分开，不改写历史作者。

可选的 `TeamMemberExecutionProvider` 提供不唤醒的锚点恢复和有界参考资料。其 `TeamMemberExecutionHandle` 限制单个成员的工作准入、保存拥有者的进度，并确认尚未使用的候选执行。原生提交和解除限制先通过接续服务占住旧执行，再进行串行状态核对；只读阻塞查询回调不得递归占用同一执行。注册拥有者也能在成员尚未存在时记录组队意图。这些记录均使用原生 Team 日志；显式槽位转移只更新当前 Profile 关联，不改写最初应用目标。接续资料的来源标记不授予权限。

休眠来源使用独占的存储输入保管，不挂载 Preset。`TeamMemberBlockerReader` 接收实际执行 id，并在这条路径上接收独立存储快照。不能用没有活着的 Agent 推断工作已经结清。已登记来源丢失、外部效果未确定或写盘确认失败均阻止解除准入；正常接续恢复仍保留 Preset 校验。

```ts type-equiv
/** Whole durable value written on every teammate lifecycle change. */
interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  /** Optional durable collaboration group; not the member's immutable address. */
  readonly group?: string
  /** Explicit composition captured for creation and cold recovery; omission inherits the Lead preset. */
  readonly preset?: TeamPresetBinding
  /** Profile role that provisioned this member; immutable with the member identity. */
  readonly slotId?: string
  readonly phase: TeamMemberPhase
  readonly error?: string
}
```

每个 member 都从 `provisioning` 开始，并到达 `active` 或 `failed`。结算任务与消息后，Lead 可将 active 或 failed 成员经 `retiring` 转为 `retired`；Session 与不可变名字仍保留。已配置成员的 Preset id 和声明修订值在创建与冷恢复之间保持不变。roster 的 `running`／`inactive` 状态单独派生，绝不会重写该记录。

产品组合可以在开放 Team 工具前持久写入不可变的受控模式记录；官方组合不写此记录。受控 Team 在重启后保留指定的 Task 写入方、权限表修订和可选的普通消息上限，并在入队前拒绝成员间直接消息。已发布的成员工具上限字段只保留在持久定义中。

用户管理的组成记录另外跟踪动态、应用中或固定的成员策略。官方 Team 没有这条记录时保持动态。应用中持久保存产品目标并阻止普通成员增减；固定状态拒绝模型增员或退队。原生 Lead 日志还保留 Profile 关联和可选槽位 id，冷恢复不需要第二份成员表。

```ts type-equiv
/** Retired tool-limit fields retained only to describe released persistent records. */
interface TeamMemberToolLimit {
  /** Optional allowlist over inherited, Preset-local, and Team-scoped member tools. */
  readonly allow?: readonly string[]
  /** Optional denylist; denial wins over an allowlist. */
  readonly deny?: readonly string[]
}
```

```ts type-equiv
/** Immutable root-Session policy for a controlled Team, persisted before Team tools are admitted. */
interface TeamControlledMode {
  /** Controlled collaboration admits only the configured product Task writer. */
  readonly kind: 'controlled'
  /** Stable extension writer identity required for every controlled Task mutation. */
  readonly requiredTaskExtensionId: string
  /** Stable name of the product's preconfigured group-permission table. */
  readonly permissionTableId: string
  /** Fingerprint of the exact permission-table revision chosen for this Team. */
  readonly permissionRevision: string
  /** Optional per-Team UTF-8 byte cap for ordinary member messages. */
  readonly maxOrdinaryMessageBytes?: number
  /** Retired field retained for the released persistence definition; runtime neither reads nor writes it. */
  readonly memberToolLimit?: TeamMemberToolLimit | undefined
}
```

## Lead 协调

独立的 `TeamLeadCoordinatorHandle` 拥有原生过渡记录，但不获得模型 Lead 身份。同步记录规划器与 Profile 应用共用 Team 锁，并在写入事件前捕获产品事实。只读 `measureMaterial(anchor, notice)` 返回 `TeamLeadMaterialSize`，其中 `bytes` 是包含发送者封装的收件箱 JSON 完整字节数，`maxBytes` 是部署上限；它校验事实资料的发送者及目标所有权，但即使内容超长也不写入或预留容量。原生记录与提交通道独立重核限额。可选的 `leadTransition` 元数据控制冻结写入和就绪；产品数据仍保存在协调器自己的扩展命名空间中。现任 Lead 冻结时，成员仍可提交工作。

`runAtSafePoint` 在等待空闲之前检查产品阻塞项，通过维护任务占住实际现任执行后再次检查。维护回调结束时，其 `TeamLeadSafePointHandle` 即失效；恢复后仅有持久安全点记录，不代表已重新获得实时占用。绑定的 Task 写入方生成自己的释放审计，原子 Lead 事务同时变更席位、全部已准备的 Lead Task 修订、排队材料和独立协调器记录。重试比较已记录的完整效果，并要求持久刷新成功；来源保留与就绪仍使用下方的邮箱回执。

`TeamLeadCoordinatorCommit.validate` 可在首次提交前、锁内同步检查独立的当前设置和原生事实。它不能进入另一条 Team 操作；抛错时席位和 Task 释放均不变。确认已记录的提交时，不再针对后来的设置重跑检查。

## 持久 mailbox

Lead Session 首先存储完整 queued message。只有 target 的 pending inbox 条目或已记录用户消息完成持久化，才会写入独立 acknowledgement event。退队前，Lead 可说明原因并取消无法投递的消息。恢复 mailbox 是 queued-minus-delivered-minus-cancelled。

```ts type-equiv
/** One mailbox item retained until its target Session records it. */
interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
  /** Host-recorded author attribution per content block; omitted blocks carry no added authority. */
  readonly contentParts?: readonly ('sender' | 'fact')[]
  /** Actual sender's server-validated Lead term; only the anchor's implicit initial seat can omit it. */
  readonly senderTerm?: number
  /** Per-block authority, independent of the sender who relays unchanged requirements. */
  readonly contentAuthors?: readonly (TeamContentAuthor | null)[]
  /** Present only for non-authorizing transfer of the original identified input. */
  readonly transfer?: TeamInputTransfer
}
```

```ts type-equiv
/** Lead-authorized cancellation of one undelivered Team message. */
interface TeamMessageCancellation {
  readonly messageId: TeamMessageId
  readonly targetId: SessionId
  readonly reason: string
}
```

普通 peer 消息尝试 Steer 投递：运行中的 target 在最近的步骤边界收到消息，空闲 target 启动或冷恢复。原生 Lead 转交则保留原输入 id、来源、有效／原请求队列和唤醒意图。内部队列 key 还包含来源捕获事实的序号，取消或第二次换任不会抵扣此前的回执。拥有者协调器预投递不唤醒；队列和实际执行／任期回执都取得持久确认后，才能清理来源。这些条目沿用同一 mailbox 顺序，不另建 inbox 或日志。只有新 input-queued 事件能携带 `TeamInputTransfer`，普通 peer 与扩展通知类型将它排除。

target Session 会在 pending inbox 条目和最终用户消息上保留消息身份与发送者归因。跨 inbox 与历史折叠该 source 构成 target 侧去重键；模型可见的 framing 会重复 id 和发送者。

```ts type-equiv
/** Source retained by the target Session for durable mailbox de-duplication. */
interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  /** Attribution aligned with the delivered blocks, including system framing. */
  readonly contentParts?: readonly ('sender' | 'fact')[]
  readonly senderTerm?: number
  readonly contentAuthors?: readonly (TeamContentAuthor | null)[]
}
```

`TeamContentAuthor` 为未改写的文字块记录实际执行 id 与其合法任期。当前发送者转派旧 Lead 的要求，不会成为该要求的作者。系统 framing、非文字块和引用资料的作者条目为空；产品先核对原 Task 指派记录，才把旧要求当作指令。`TeamLeadContext` 只读锚点、脱离原状态的席位、可选的在线执行和就绪状态，不授予操作权限，也不悄悄激活离线执行。

## 共享任务 DAG

每条 task event 都存储完整快照。`revision` 是 compare-and-set 值，每次变更递增 1。`blockedBy` edge 必须指向未删除任务，并维持无环图。`writeScopes` 是规范化的提示性路径前缀，不是锁。

```ts type-equiv
/** Whole durable task snapshot; every mutation increments {@link revision}. */
interface TeamTaskSnapshot {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly ownerId?: SessionId
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  /** Monotonic marker: a completed result can no longer satisfy downstream prerequisites. */
  readonly resultUnavailable?: true
  /** Product-owned persistent scheduling closure, independent of execution status. */
  readonly dispatchBlocked?: true
}
```

`pending` 表示尚未开始或已经释放，`in_progress` 携带 owner，`completed` 满足 blocker，`deleted` 是保留的 tombstone。view 会添加 owner name、readiness 和 write-scope 重叠警告，但不会改变持久快照。可选的 `dispatchBlocked` 标记使 readiness 为 false，但不取代执行状态。注册的 Task 写入方拥有具体控制规则并分类排队工作输入；原生运行时在投递和领取输入前使用相同准入判断，普通协调输入仍独立处理。

可选的 Host 写入方能在一条 `team/task/transaction` 事件中提交多个原生 Task 快照和 mailbox 通知。注册的写入方在 Team 事务锁内取得脱离原状态的 Board 快照；每个现有 Task 必须匹配其上一修订，新分配的数字 id 必须连续。它也能在同一锁内返回已有 Task，而不追加事件。原生投影校验最终 DAG，并折叠 Task 值与通知。扩展拥有同一事件中的 JSON 字符串，可为验收详情单独注册投影，但不能取代原生 Board。

```ts type-equiv
/** One new or next-revision Task written by an optional Team extension. */
interface TeamTaskTransactionUpdate {
  /** Null creates a new Task; otherwise the current revision must match. */
  readonly previousRevision: number | null
  readonly task: TeamTaskSnapshot
}
```

```ts type-equiv
/** Detached native Team state available to one synchronous extension planner. */
interface TeamTaskTransactionSnapshot {
  readonly tasks: readonly TeamTaskSnapshot[]
  readonly members: readonly TeamMemberSnapshot[]
  readonly composition?: TeamCompositionState
  readonly nextTaskNumber: number
}
```

```ts type-equiv
/** Atomic native Task updates with opaque extension-owned JSON. */
interface TeamTaskTransactionWritePlan {
  readonly updates: readonly TeamTaskTransactionUpdate[]
  readonly dataJson: string
  /** Durable Team messages enqueued atomically with the Task updates. */
  readonly notices?: readonly TeamExtensionNotice[]
  /** Host-only opt-in for factual notices to the Lead itself; omitted preserves normal self-message rejection. */
  readonly allowLeadSelfNotices?: boolean
}
```

```ts type-equiv
/** Return an earlier committed Task result without appending an event. */
interface TeamTaskTransactionExistingPlan {
  readonly existingTaskIds: readonly TeamTaskId[]
}
```

```ts type-equiv
/** A new atomic write or an existing result selected under the same Team lock. */
type TeamTaskTransactionPlan = TeamTaskTransactionWritePlan | TeamTaskTransactionExistingPlan
```

<a id="web-projection"></a>

## Web 投影

Lead Session 通过 `SessionProjectionMap.agentTeam` 发布持久 roster 行与未删除任务视图。`failure` 在最后有效状态旁报告被拒绝的持久记录。成员活动来自 Session 状态；模型标签来自各成员的 `modelSelection` 投影。

```ts type-equiv
/** One durable roster row published through the `agentTeam` Session projection. */
interface TeamMemberProjection {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  /** Durable lifecycle; the Lead row is always `active`. Turn activity comes from Session status. */
  readonly phase: TeamMemberPhase
  readonly group?: string
  readonly preset?: TeamPresetBinding
  readonly slotId?: string
  readonly error?: string
  /** Controlled-only state derived from durable input delivery receipts. */
  readonly executionStarted?: boolean
  /** Current execution after renewal; historical member id and authors are unchanged. */
  readonly execution?: TeamMemberExecution
  /** The current member execution is held by an unfinished Host operation. */
  readonly executionHeld?: boolean
}
```

```ts type-equiv
/** Runtime-enriched task view returned to tools and hosts. */
interface TeamTaskView {
  readonly id: TeamTaskId
  readonly revision: number
  readonly subject: string
  readonly description: string
  readonly status: TeamTaskStatus
  readonly blockedBy: TeamTaskId[]
  readonly writeScopes: string[]
  readonly ownerName?: string
  readonly ready: boolean
  readonly resultUnavailable?: true
  readonly dispatchBlocked?: true
  readonly writeScopeWarnings: string[]
}
```

```ts type-equiv
/**
 * Durable Team state published to browser clients through the Lead Session's
 * `agentTeam` projection. `failure` names the first rejected persisted Team
 * record; members and tasks then stay at the last valid state.
 */
interface TeamProjection {
  /** Present after the first native seat transaction; no product transition phase is embedded here. */
  readonly lead?: import('./lead-seat.ts').TeamLeadBinding
  readonly members: TeamMemberProjection[]
  readonly tasks: TeamTaskView[]
  /** Absent for an untouched official Team, which remains dynamic. */
  readonly composition?: TeamCompositionView
  readonly failure?: string
}
```

## 回放

`agentTeam` Session 投影把一个 Root Session 回放成每个 Team 操作所读取的 roster、任务板与 queued-minus-delivered mailbox。它按 `TeamId` 选取记录，因此普通 fork 继承的 event 保留 ancestor id，绝不会进入新 Root 的状态。Session event 的 `seq` 与 `time` 继续负责顺序和时间记录，Team snapshot 不再重复保存它们。roster 与 task 读取以 view 形式到达调用方，而 pending 邮件仅供投递与恢复内部使用。包 [README](../../packages/experimental/agent-team/README.zh.md)负责 operation、authorization、recovery 和限制行为。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentteams--teamservice"></a>

### `ctx.agentTeams` — `TeamService`

Agent Teams service backed by the exact live Lead Session log.

```ts cordis-catalog
/**
 * Resolve one exact live Agent's Team role.
 * @param agent - exact live Agent used as the authority credential.
 * @returns its root, Team identity, role, and model-facing name.
 */
membership(agent: Agent): TeamMembership

/** Resolve a stable member address without loading or waking its execution.
 * @param agent - exact live Team reader, including its dormant anchor.
 * @param memberId - immutable roster address.
 * @returns detached current binding, or undefined for an unknown member.
 */
memberExecution(agent: Agent, memberId: import('@deepseek-ai/dsh-session').SessionId): TeamMemberExecution | undefined

/** Resolve a recorded teammate execution without conferring current write authority.
 * @param agent - exact live Team reader, including its dormant anchor.
 * @param executionId - actual current or historical Session identity.
 * @returns detached recorded binding, or undefined for a foreign execution.
 */
memberExecutionBySession(agent: Agent, executionId: import('@deepseek-ai/dsh-session').SessionId): TeamMemberExecution | undefined

/** Install the optional Host owner of teammate execution replacement and input custody.
 * @param provider - product-owned namespace and quiet anchor restoration.
 * @returns disposable native admission and binding operations; no model tool is added.
 */
installMemberExecutions(provider: TeamMemberExecutionProvider): TeamMemberExecutionHandle

/** Install one authenticated Host owner of ordinary Lead execution preparation.
 * @param provider - stable anchor activation, without driving its model.
 * @returns an owner-scoped creation and cold-activation capability; no seat authority is granted.
 */
installLeadExecutions(provider: LeadExecutionProvider): LeadExecutionHandle

/** Install the independent Host-only owner of native Lead coordination.
 * @param coordinator - registered opaque namespace, distinct from the Task writer.
 * @returns owned durable records, safe-point occupation and atomic seat commit.
 */
installLeadCoordinator(coordinator: TeamLeadCoordinator): TeamLeadCoordinatorHandle

/** Read the stable Team host and committed execution independently of operation authority.
 * @param agent - exact live Team member, dormant host or marked execution.
 * @returns the current seat, optional live execution, and execution readiness.
 */
leadContext(agent: Agent): import('./types.ts').TeamLeadContext

/** Verify recorded current or historical Lead authorship without granting current authority.
 * @param agent - exact live Team reader.
 * @param executionId - actual recorded author.
 * @param term - recorded author term, or omitted to infer the anchor's implicit initial seat.
 * @returns whether the native seat history validates that author.
 */
isLeadAuthor(agent: Agent, executionId: import('@deepseek-ai/dsh-session').SessionId, term?: number): boolean

/** Read the stable seat through an exact live Team caller, including its dormant host.
 * @param agent - exact live anchor, member or current execution.
 * @returns detached native seat identity; no activation or write occurs.
 */
leadSeat(agent: Agent): import('./lead-seat.ts').TeamLeadSeat

/**
 * Read the immutable controlled-mode binding, if this Team opted in.
 * @param agent - exact live Team caller.
 * @returns the durable controlled-mode binding, or undefined for an official Team.
 */
controlledMode(agent: Agent): TeamControlledMode | undefined

/**
 * Read the durable Team composition policy; an untouched Team is dynamic.
 * @param agent - exact live Team member whose root owns the policy.
 * @returns a detached current policy value.
 */
composition(agent: Agent): TeamCompositionState

/**
 * Read one detached Team snapshot while native roster and Task writes are serialized.
 * @param caller - exact live Lead.
 * @param read - bounded Host callback that must not enter another Team transaction.
 * @returns the callback result from the same locked roster cut.
 */
async readCompositionLocked<T>( caller: Agent, read: (snapshot: TeamCompositionSnapshot) => T | Promise<T>, ): Promise<T>

/**
 * Commit one Host-authored composition transition under the native Team lock.
 * Model tools do not expose this method. The builder may decline with undefined.
 * @param caller - exact live Lead used for the native Team identity.
 * @param build - Host planner that checks its own policy against a detached current snapshot.
 * @returns the committed policy, or the unchanged policy after a declined plan.
 */
async commitComposition( caller: Agent, build: (snapshot: TeamCompositionSnapshot) => TeamCompositionTransition | undefined | Promise<TeamCompositionTransition | undefined>, ): Promise<TeamCompositionState>

/**
 * Read the configured teammate Preset used when a spawn request omits one.
 * @returns configured Preset id, or undefined to inherit the Lead.
 */
defaultMemberPresetId(): string | undefined

/**
 * Read product-owned next-action hints after a controlled member releases work.
 * @param agent - exact live Team member.
 * @returns text supplied by the installed extension without Team interpretation.
 */
releaseHints(agent: Agent): readonly string[]

/**
 * List the runtime-enriched roster visible to one Team member.
 * @param agent - exact live Team member.
 * @returns Lead and teammate rows in creation order.
 */
listMembers(agent: Agent): TeamMemberView[]

/**
 * Create one named, continuable direct child of the Team Lead.
 * @param caller - exact live Lead Agent.
 * @param request - immutable name, description, prompt, context mode, provider, and cancellation.
 * Controlled Teams replace the prompt and require fresh context.
 * @returns the active roster row.
 */
async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>

/**
 * Retire a teammate after its assignments and pending messages are settled.
 * The member name and Session history remain available for audit.
 * @param caller - exact live Lead Agent.
 * @param targetName - immutable teammate name.
 * @param applicationId - matching in-progress user application, absent for an ordinary dynamic Team.
 * @param memberOperationId - the registered Host operation holding this member, absent for ordinary retirement.
 * @returns the retired roster row.
 */
async retireTeammate(caller: Agent, targetName: string, applicationId?: string, memberOperationId?: string): Promise<TeamMemberView>

/**
 * Queue one durable peer message, then attempt immediate delivery.
 * @param caller - exact live sending Team member.
 * @param request - target name, content, and pre-queue cancellation.
 * @returns durable message identity and immediate-delivery observation.
 */
async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>

/**
 * Cancel a teammate's undelivered messages before retiring an unavailable member.
 * @param caller - exact live Lead Agent.
 * @param targetName - immutable teammate name.
 * @param reason - durable explanation for cancellation.
 * @param expectedIds - exact previewed pending set; retries confirm the same cancelled identities without touching later mail.
 * @returns ids of messages cancelled by this call.
 */
async cancelPendingMessages(caller: Agent, targetName: string, reason: string, expectedIds?: readonly TeamMessageId[]): Promise<readonly TeamMessageId[]>

/**
 * Create one unowned pending task in the Team Lead log.
 * @param caller - exact live Team member creating the task.
 * @param request - task text, blockers, and advisory write scopes.
 * @returns the revision-one task view.
 */
async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Install one product Task writer while retaining the native Team Board and Session log.
 * @param writer - create/update policy and stable extension event identifier.
 * @returns an effect-owned transaction capability and disposer.
 */
installTaskExtension(writer: TeamTaskExtension): TeamTaskExtensionHandle

/**
 * Return one task, including a deleted tombstone.
 * @param caller - exact live Team member reading the task.
 * @param id - Team-local task identity.
 * @returns the latest task value and derived readiness diagnostics.
 */
getTask(caller: Agent, id: TeamTaskId): TeamTaskView

/**
 * List current non-deleted tasks in numeric creation order.
 * @param caller - exact live Team member reading the board.
 * @returns detached current task views.
 */
listTasks(caller: Agent): TeamTaskView[]

/**
 * Compare-and-set one authorized task transition.
 * @param caller - exact live Team member authorizing the mutation.
 * @param request - task identity, expected revision, action, and action fields.
 * @returns the committed next task revision.
 */
async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView>

/**
 * Wait for the next Team-domain or member-status change.
 * @param caller - exact live Team member waiting for activity.
 * @param timeoutMs - bounded wait duration from ten seconds through one hour.
 * @param signal - caller cancellation for the wait only.
 * @returns one observed change or a timeout result.
 */
async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>

/**
 * Interrupt one live teammate turn without clearing its pending inbox.
 * @param caller - exact live Lead Agent.
 * @param targetName - durable teammate name.
 * @returns the target status sampled before cancellation.
 */
interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' }

/**
 * Resolve a caller without throwing, used by scoped-tool installation and observers.
 * @param agent - candidate exact live Agent.
 * @returns Team membership, or undefined for non-Team subagents and stale identities.
 */
tryMembership(agent: Agent): TeamMembership | undefined
```

Types: [Agent](core.zh.md) · [SessionId](core.zh.md)

Source: [`packages/experimental/agent-team/src/index.ts`](../../packages/experimental/agent-team/src/index.ts)

<a id="agent-team-events"></a>

### `agent-team/*` events

<a id="agent-teamconfirmed--parallel"></a>

#### `agent-team/confirmed` — parallel

A coordinated native Team checkpoint was durably confirmed; observers refresh runtime admission.

```ts cordis-catalog
/** A coordinated native Team checkpoint was durably confirmed; observers refresh runtime admission.
 * @mode parallel
 * @param anchor - exact stable Team journal owner after successful confirmation.
 */
'agent-team/confirmed'(anchor: Agent): void
```

Types: [Agent](core.zh.md)

Source: [`packages/experimental/agent-team/src/index.ts`](../../packages/experimental/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
