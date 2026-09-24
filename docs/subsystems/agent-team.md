# Agent Teams

English | [中文](agent-team.zh.md)

Types shared by the experimental implicit-root Team domain, model tools, and host adapters. The [Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) owns identity, mailbox, task, and shared-checkout decisions; this page records the literal durable forms from [`packages/experimental/agent-team/src/types.ts`](../../packages/experimental/agent-team/src/types.ts).

## Identity and roster

`TeamId` is the root `SessionId` under a distinct [brand](core.md#branded-ids). `TeamTaskId` is Team-local and monotonically allocated as `task-<n>`; `TeamMessageId` is globally random. A teammate's Session id remains its persistent identity, while `name` is an immutable model/UI label.

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

Every member starts in `provisioning` and becomes `active` or `failed`. An active member may then move through `retiring` to `retired`; pending assignments and undelivered Team messages block that transition. Version-two `team/member` records retain the original fields, while `team/member/configured` carries Preset bindings and retirement without rewriting them. Roster `running`/`inactive` status is derived separately and never rewrites a member record.

## Durable mailbox

The Lead Session first stores the complete queued message. A target receipt is acknowledged only after its pending inbox item or recorded user message is durable, leaving queued-minus-delivered as the recovery mailbox.

The released `team/message/queued` event remains unlinked. A new `team/message/queued-task` event can name one existing Task without changing delivery; the sender or recipient must own that Task unless the sender is the Lead. `listLeadMessages` and the Lead-only Remote return complete text plus the stored content JSON in newest-first pages. Teammates cannot read messages exchanged by others.

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

Every message attempts Steer delivery. A running target receives it at the nearest step boundary; an inactive target starts a turn if loaded or cold-resumes otherwise. Scheduling is not stored in the durable record because callers cannot select another mode.

The target Session keeps message identity and sender attribution on both the pending inbox item and the eventual user message. Folding that source across inbox and history is the target-side de-duplication key; the model-visible framing repeats the id and sender.

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

## Shared task DAG

Every task event stores a complete snapshot. `revision` is the compare-and-set value and increments by one per mutation. `blockedBy` edges must name non-deleted tasks and keep the graph acyclic. `writeScopes` are normalized advisory path prefixes rather than locks.

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

`pending` is unstarted or released, `in_progress` carries an owner, and `deleted` is a retained tombstone. For newly created managed Tasks, `completed` satisfies blockers only after Lead acceptance of a separate result. `team/task/managed` stores a Task snapshot together with its Attempt history and result validity; a single event can mark accepted descendants stale when a quality rework creates a new Task ID. It does not invent dependency edges or replace the Task DAG with a Session graph. Released version-two `team/task` events remain readable with their original completion rule. Views add owner name, readiness, write-scope warnings, and optional review detail without changing the durable snapshot.

The service accepts `SubmitTeamTaskResultRequest` from the exact owner with `taskId`, `expectedRevision`, `attemptId`, and a `TeamTaskResult` (`summary` plus artifact references). `AcceptTeamTaskResultRequest` carries the same Task/Attempt CAS identities and requires the Lead. `ReworkTeamTaskRequest` requires the Lead, the old Task revision, a reason, and an explicit `blockedBy` list for the new Task. The old Task and accepted descendants retain their history; no replacement dependency is silently inferred.

## Replay

`foldTeam()` replays one root Session into the roster, task board, and queued-minus-delivered mailbox that every Team operation reads. It selects records by `TeamId`, so events inherited by an ordinary fork retain the ancestor id and never enter the new root's state. Session event `seq` and `time` remain the ordering and timing record; Team snapshots do not duplicate them. Roster and task reads reach callers as views; pending mail stays internal to delivery and recovery. The package [README](../../packages/experimental/agent-team/README.md) owns operation, authorization, recovery, and limit behavior.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.md)

Source: [`packages/experimental/agent-team/src/index.ts`](../../packages/experimental/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
