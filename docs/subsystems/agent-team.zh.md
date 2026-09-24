# Agent Teams

[English](agent-team.md) | 中文

实验性隐式 Root Team 领域、模型工具与宿主适配器共享的类型。[Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责身份、mailbox、task 与共享 checkout 决策；本页记录 [`packages/experimental/agent-team/src/types.ts`](../../packages/experimental/agent-team/src/types.ts) 中的字面持久形式。

## 身份与 roster

`TeamId` 是具有独立[品牌](core.zh.md#branded-ids)的 Root `SessionId`。`TeamTaskId` 在 Team 内按 `task-<n>` 单调分配；`TeamMessageId` 是全局随机值。teammate 的 Session id 始终是持久身份，而 `name` 是不可变的模型／UI 标签。

```ts type-equiv
/** Whole durable value reconstructed from either member event generation. */
interface TeamMemberSnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  /** Explicit child composition; absent when the member inherits the Lead preset. */
  readonly preset?: ContinuablePresetBinding
  readonly phase: TeamMemberPhase
  readonly error?: string
}
```

每个 member 都从 `provisioning` 开始，随后成为 `active` 或 `failed`。active 成员还可经 `retiring` 转为 `retired`；未完成的分配任务和未投递的 Team 消息会阻止该转换。第二版 `team/member` 记录保留原字段，`team/member/configured` 承载 Preset 绑定与退队，不改写旧记录。roster 的 `running`／`inactive` 状态单独派生，绝不重写成员记录。

## 持久 mailbox

Lead Session 首先存储完整 queued message。只有 target 的 pending inbox 条目或已记录用户消息完成持久化，才会写入独立 acknowledgement event，queued-minus-delivered 因而构成恢复 mailbox。

已发布的 `team/message/queued` 事件保持不关联 Task。新的 `team/message/queued-task` 事件可指向一个真实 Task，而不改变投递；除 Lead 外，发送方或接收方必须是该 Task 的 owner。`listLeadMessages` 与仅 Lead 可用的 Remote 按最新消息优先分页返回全文和持久化内容 JSON。teammate 不能读取其他成员之间的消息。

```ts type-equiv
/** One peer message retained until its target Session records it. */
interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}
```

每条消息都会尝试 Steer 投递。running target 在最近的步骤边界收到消息，inactive target 在已加载时启动一个轮次，否则冷恢复。调用方不能选择其他模式，因此持久记录不存储调度方式。

target Session 会在 pending inbox 条目和最终用户消息上保留消息身份与发送者归因。跨 inbox 与历史折叠该 source 构成 target 侧去重键；模型可见的 framing 会重复 id 和发送者。

```ts type-equiv
/** Source retained by the target Session for durable mailbox de-duplication. */
interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}
```

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
}
```

`pending` 表示尚未开始或已经释放，`in_progress` 携带 owner，`deleted` 是保留的 tombstone。新建的受控 Task 只有在 Lead 验收独立提交的结果后，`completed` 才满足 blocker。`team/task/managed` 同时存储 Task 快照、Attempt 历史与结果有效性；质量重做创建新 Task ID 时，一条事件可将已验收的下游结果原子标为过期。它不发明依赖边，也不把 Task DAG 改成 Session 图。既有第二版 `team/task` 事件仍按原完成规则读取。view 会添加 owner name、readiness、write-scope 警告与可选的验收详情，而不改变持久快照。

服务仅接受当前 Owner 的 `SubmitTeamTaskResultRequest`，其中包含 `taskId`、`expectedRevision`、`attemptId`，以及由 `summary` 和产物引用组成的 `TeamTaskResult`。`AcceptTeamTaskResultRequest` 携带相同的 Task/Attempt CAS 身份，仅 Lead 可调用。`ReworkTeamTaskRequest` 也仅限 Lead，须给出旧 Task 修订、理由及新 Task 显式的 `blockedBy` 列表。旧 Task 与已验收的下游都保留历史；不会暗自推断替换依赖。

## 回放

`foldTeam()` 把一个 Root Session 回放成每个 Team 操作所读取的 roster、任务板与 queued-minus-delivered mailbox。它按 `TeamId` 选取记录，因此普通 fork 继承的 event 保留 ancestor id，绝不会进入新 Root 的状态。Session event 的 `seq` 与 `time` 继续负责顺序和时间记录，Team snapshot 不再重复保存它们。roster 与 task 读取以 view 形式到达调用方，而 pending 邮件仅供投递与恢复内部使用。包 [README](../../packages/experimental/agent-team/README.zh.md)负责 operation、authorization、recovery 和限制行为。

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
 * @returns the active roster row.
 */
async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>

/**
 * Retire one teammate after its unfinished tasks and pending Team mail have been resolved.
 * The member name and Session history remain durable; in-flight Team commands lose admission.
 * @param caller - exact live Team Lead.
 * @param targetName - member name from the roster.
 * @returns the retired roster row after execution teardown.
 */
async retireTeammate(caller: Agent, targetName: string): Promise<TeamMemberView>

/**
 * Queue one durable peer message, then attempt immediate delivery.
 * @param caller - exact live sending Team member.
 * @param request - target name, content, and pre-queue cancellation.
 * @returns durable message identity and immediate-delivery observation.
 */
async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>

/**
 * Read complete peer-message bodies from the authoritative Lead Session, newest first.
 * This is a Lead-only observation; teammates cannot inspect third-party messages.
 * @param caller - exact live Team Lead used for authorization.
 * @param before - oldest id from a prior page, excluded from this older page.
 * @param limit - bounded page size from 1 through 100; defaults to 50.
 * @returns a stable message-id cursor and detached message content.
 */
listLeadMessages(caller: Agent, before?: TeamMessageId, limit: number = 50): TeamMessagePage

/**
 * Read a Lead-only browser page of the same mailbox records used by delivery and recovery.
 * @param agent - exact live Lead used for authorization.
 * @param before - oldest message id from a prior page, excluded from this page.
 * @returns newest-first messages and an optional older-page cursor.
 */
@Remote('messages') remoteMessages(agent: Agent, before?: TeamMessageId): TeamMessagePage

/**
 * Create one unowned pending task in the Team Lead log.
 * @param caller - exact live Team member creating the task.
 * @param request - task text, blockers, and advisory write scopes.
 * @returns the revision-one task view.
 */
async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>

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
 * Submit the caller-owned current Attempt for Lead review without satisfying Task blockers.
 * @param caller - exact live Task owner.
 * @param request - Task/Attempt CAS identities and separate result content.
 * @returns the submitted Task view.
 */
async submitTaskResult(caller: Agent, request: SubmitTeamTaskResultRequest): Promise<TeamTaskView>

/**
 * Mark the exact submitted Attempt accepted and release its dependent Tasks.
 * @param caller - exact live Team Lead.
 * @param request - Task revision and submitted Attempt identity.
 * @returns the completed Task view.
 */
async acceptTaskResult(caller: Agent, request: AcceptTeamTaskResultRequest): Promise<TeamTaskView>

/**
 * Reject quality work into a new Task ID while retaining the old result and marking dependent results stale.
 * @param caller - exact live Team Lead.
 * @param request - old Task revision, reason, and explicit replacement prerequisites.
 * @returns the new pending Task view; it is not automatically dispatched.
 */
async reworkTask(caller: Agent, request: ReworkTeamTaskRequest): Promise<TeamTaskView>

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

/**
 * Read the current roster and non-deleted task board through the generated Remote API.
 * @param agent - exact live Team member used as the authority credential.
 * @returns detached current roster and task views.
 */
@Remote('view') remoteView(agent: Agent): TeamView
```

Types: [Agent](core.zh.md)

Source: [`packages/experimental/agent-team/src/index.ts`](../../packages/experimental/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
