# Agent Teams

English | [中文](agent-team.zh.md)

Types shared by the experimental implicit-root Team domain, model tools, and host adapters. The [Agent Teams Agent Note](../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) owns identity, mailbox, task, and shared-checkout decisions; this page records the durable and client-visible forms from [`packages/experimental/agent-team/src/types.ts`](../../packages/experimental/agent-team/src/types.ts).

## Identity and roster

The optional stable Lead seat keeps `TeamLeadBinding` with an execution id, contiguous term, Preset id and declaration revision. `TeamLeadSeat` also describes the initial anchor at term one, whose Preset fields may be absent. A `LeadExecutionProvider` prepares the anchor and supplies current readiness; its owner receives a `LeadExecutionHandle` for ordinary candidate creation, exact-revision cold preparation and non-waking input custody. This capability does not itself implement a product transition workflow. The [package implementation](../../packages/experimental/agent-team/README.md#understand-the-implementation) owns identity and lifecycle behavior.

`TeamId` is the root `SessionId` under a distinct [brand](core.md#branded-ids). `TeamTaskId` is Team-local and monotonically allocated as `task-<n>`; `TeamMessageId` is globally random. A teammate's Session id remains its persistent identity, while `name` is an immutable model/UI label.

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

Every member starts in `provisioning` and reaches `active` or `failed`. The Lead can move an active or failed member through `retiring` to `retired` after settling assignments and mail; the Session and immutable name remain. A configured member retains its Preset id and declaration revision across creation and cold continuation. Roster `running`/`inactive` status is derived separately and never rewrites this record.

A product composition may persist one immutable controlled-mode record before opening Team tools. The official composition leaves it absent. A controlled Team keeps its required Task writer, permission-table revision, and optional ordinary-message limit across restarts; member-to-member direct messages are rejected before queueing. The released member-tool-limit fields remain in the persistence definition only.

A user-managed composition record separately tracks dynamic, applying, or fixed roster policy. The official Team remains dynamic without this record. Applying persists an opaque product target and blocks ordinary member changes; fixed rejects model-driven member creation and retirement. The native Lead log also retains the Profile association and the optional slot id, so cold recovery does not need a second member store.

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

## Lead coordination

An independent `TeamLeadCoordinatorHandle` owns native transition records without acquiring a model Lead role. Its synchronous record builder runs under the same Team lock as Profile application and captures product facts immediately before the event. Read-only `measureMaterial(anchor, notice)` returns `TeamLeadMaterialSize` with complete sender-framed inbox JSON `bytes` and deployment `maxBytes`; it enforces factual sender/target ownership but neither writes nor reserves capacity, even for oversized content. Native record and commit admission independently recheck limits. The optional `leadTransition` metadata controls frozen writes and readiness; product data stays in the coordinator's separate extension namespace. Members can still commit their work while the incumbent Lead is frozen.

`runAtSafePoint` checks the product's blockers before waiting for idle and again after it occupies the actual incumbent execution through maintenance. Its `TeamLeadSafePointHandle` expires when that maintenance callback ends; a persisted safe record does not establish a new live occupation after recovery. The bound Task writer generates its own release audit, and the atomic Lead transaction changes the seat, every prepared Lead Task revision, queued material and independent coordinator record together. Retries compare the recorded effects and require a successful durable flush; source custody and readiness still use the mailbox receipts below.

`TeamLeadCoordinatorCommit.validate` optionally checks detached current settings and native facts synchronously under the lock before a fresh commit. It cannot enter another Team operation; throwing leaves the seat and Task releases unchanged. Confirming an already-recorded commit does not rerun the check against later settings.

## Durable mailbox

The Lead Session first stores the complete queued message. A target receipt is acknowledged only after its pending inbox item or recorded user message is durable. The Lead can cancel undelivered messages with a reason before retiring an unavailable member. The recovery mailbox is queued-minus-delivered-minus-cancelled.

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

Ordinary peer messages attempt Steer delivery: a running target receives one at its nearest step boundary, and an inactive target starts or cold-resumes. Native Lead transfers instead retain the original input id, source, effective/requested queue and wake intent. Their internal queue key also identifies the source-held capture sequence, so cancellation and a second seat change cannot consume an earlier receipt. The owning coordinator preloads without waking; its queue and actual execution/term receipt must both be durably confirmed before source cleanup. These items use the same mailbox order, not a second inbox or journal. Only the new input-queued event can contain `TeamInputTransfer`; ordinary peer and extension-notice types exclude it.

The target Session keeps message identity and sender attribution on both the pending inbox item and the eventual user message. Folding that source across inbox and history is the target-side de-duplication key; the model-visible framing repeats the id and sender.

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

`TeamContentAuthor` records an actual execution id and its lawful term for an unchanged text block. Relaying an older Lead's requirement does not make the current sender its author. System framing, non-text blocks and reference facts carry null author entries; the product checks original Task-assignment records before treating an old requirement as an instruction. `TeamLeadContext` only reads the anchor, detached seat, optional live execution and readiness; it never grants operation authority or silently activates a cold execution.

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
  /** Monotonic marker: a completed result can no longer satisfy downstream prerequisites. */
  readonly resultUnavailable?: true
}
```

`pending` is unstarted or released, `in_progress` carries an owner, `completed` satisfies blockers, and `deleted` is a retained tombstone. Views add owner name, readiness, and write-scope overlap warnings without changing the durable snapshot.

An optional Host writer can submit several native Task snapshots and mailbox notices in one `team/task/transaction` event. The registered writer receives a detached Board snapshot under the Team transaction lock; each existing Task must match its previous revision, and newly allocated numeric ids are sequential. It can also return existing Tasks under that lock without appending an event. The native projection validates the final DAG and folds Task values plus notices. The extension owns the JSON string in the same event and may register a separate projection for its review details; it cannot replace the native Board.

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

## Web projection

The Lead Session publishes `SessionProjectionMap.agentTeam` with durable roster rows and non-deleted task views. `failure` reports a rejected persisted record beside the last valid state. Member activity comes from Session status; model labels come from each member's `modelSelection` projection.

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

## Replay

The `agentTeam` Session projection replays one root Session into the roster, task board, and queued-minus-delivered mailbox that every Team operation reads. It selects records by `TeamId`, so events inherited by an ordinary fork retain the ancestor id and never enter the new root's state. Session event `seq` and `time` remain the ordering and timing record; Team snapshots do not duplicate them. Roster and task reads reach callers as views; pending mail stays internal to delivery and recovery. The package [README](../../packages/experimental/agent-team/README.md) owns operation, authorization, recovery, and limit behavior.

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
 * @returns the retired roster row.
 */
async retireTeammate(caller: Agent, targetName: string, applicationId?: string): Promise<TeamMemberView>

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
 * @returns ids of messages cancelled by this call.
 */
async cancelPendingMessages(caller: Agent, targetName: string, reason: string): Promise<readonly TeamMessageId[]>

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

Types: [Agent](core.md) · [SessionId](core.md)

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

Types: [Agent](core.md)

Source: [`packages/experimental/agent-team/src/index.ts`](../../packages/experimental/agent-team/src/index.ts)
<!-- END GENERATED cordis-surface -->
