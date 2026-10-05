/** Public Agent Teams identities, durable records, and service request values. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { Agent, AgentInput } from '@deepseek-ai/dsh-agent/types'
import type { TeamLeadSeat } from './lead-seat.ts'

/** One execution generation, with the immutable roster address kept separate. */
export interface TeamMemberExecution {
  readonly memberId: SessionId
  readonly executionId: SessionId
  readonly generation: number
}

/** Identifies the implicit team rooted at one top-level Session. */
export type TeamId = Branded<'TeamId'>

/**
 * Brand one root Session identity as its implicit Team identity.
 * @param id - Root Session identity.
 * @returns the same string branded as a Team identity.
 */
export function TeamId(id: SessionId | string): TeamId {
  return id as TeamId
}

/** Stable identifier for one task in a Team. */
export type TeamTaskId = Branded<'TeamTaskId'>

/**
 * Brand a validated task id.
 * @param id - Team-local task identity.
 * @returns the same string branded as a Team task identity.
 */
export function TeamTaskId(id: string): TeamTaskId {
  return id as TeamTaskId
}

/** Stable identifier for one durable peer message. */
export type TeamMessageId = Branded<'TeamMessageId'>

/**
 * Brand a generated peer-message id.
 * @param id - Durable mailbox message identity.
 * @returns the same string branded as a Team message identity.
 */
export function TeamMessageId(id: string): TeamMessageId {
  return id as TeamMessageId
}

/** Opaque identity of one registered Host Lead transition. */
export type TeamLeadOperationId = Branded<'TeamLeadOperationId'>

/** Brand a validated Host transition identity.
 * @param id - generated or validated operation identifier.
 * @returns the same string as a native Lead operation identity.
 */
export function TeamLeadOperationId(id: string): TeamLeadOperationId {
  return id as TeamLeadOperationId
}

/** Native transition phases; product material remains in its separate extension record. */
export type TeamLeadCoordinationPhase = 'requested' | 'frozen' | 'safe' | 'prepared' | 'committed'
  | 'ready' | 'cancelled' | 'failed'

/** One registered coordinator's durable admission state. */
export interface TeamLeadCoordination {
  readonly coordinatorId: string
  readonly operationId: TeamLeadOperationId
  readonly previousTerm: number
  readonly previousExecutionId: SessionId
  readonly phase: TeamLeadCoordinationPhase
}

/** Optional native control accompanying a coordinator-owned extension record. */
export interface TeamLeadTransition {
  readonly operationId: TeamLeadOperationId
  readonly previousTerm: number
  readonly previousExecutionId: SessionId
  readonly phase: Exclude<TeamLeadCoordinationPhase, 'committed'>
}

/** Durable teammate lifecycle. */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed' | 'retiring' | 'retired'

/** Client-safe declared composition identity retained by a Team member. */
export interface TeamPresetBinding {
  readonly id: string
  readonly revision: string
}

/** Released version-two member value retained for existing Session logs. */
export interface TeamMemberLegacySnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: 'provisioning' | 'active' | 'failed'
  readonly error?: string
}

/** Whole durable value written on every teammate lifecycle change. */
export interface TeamMemberSnapshot {
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

/** Current runtime-enriched roster row. */
export interface TeamMemberView {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: 'running' | 'inactive' | 'provisioning' | 'failed' | 'retiring' | 'retired'
  readonly description?: string
  readonly provider?: string
  readonly context?: 'fresh' | 'fork'
  readonly group?: string
  readonly preset?: TeamPresetBinding
  readonly slotId?: string
  readonly model?: string
  readonly diagnostics: string[]
  /** Controlled-only receipt-derived execution state; not a durable member field. */
  readonly executionStarted?: boolean
  /** Present after execution renewal; id remains the stable original member address. */
  readonly execution?: TeamMemberExecution
}

/** Durable task lifecycle. */
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

/** Whole durable task snapshot; every mutation increments {@link revision}. */
export interface TeamTaskSnapshot {
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

/** One new or next-revision Task written by an optional Team extension. */
export interface TeamTaskTransactionUpdate {
  /** Null creates a new Task; otherwise the current revision must match. */
  readonly previousRevision: number | null
  readonly task: TeamTaskSnapshot
}

/** Detached native Team state available to one synchronous extension planner. */
export interface TeamTaskTransactionSnapshot {
  readonly tasks: readonly TeamTaskSnapshot[]
  readonly members: readonly TeamMemberSnapshot[]
  readonly composition?: TeamCompositionState
  readonly nextTaskNumber: number
}

/** Opaque extension record, independent of any Task mutation. */
export interface TeamExtensionRecord {
  readonly recordId: string
  readonly dataJson: string
}

/** Detached Team state and this writer's durable records under the Team lock. */
export interface TeamExtensionRecordSnapshot extends TeamTaskTransactionSnapshot {
  readonly records: readonly TeamExtensionRecord[]
}

/** One new record, optionally enqueueing notices in the same event. */
export interface TeamExtensionRecordWritePlan extends TeamExtensionRecord {
  readonly notices?: readonly TeamExtensionNotice[]
  readonly affectsComposition?: true
}

/** Return an earlier record without appending another event. */
export interface TeamExtensionRecordExistingPlan {
  readonly existingRecordId: string
}

/** Decline a now-inapplicable notification after inspecting the current locked Team state. */
export interface TeamExtensionRecordNoopPlan { readonly skip: true }

/** Synchronous extension-record decision under the native Team lock. */
export type TeamExtensionRecordPlan = TeamExtensionRecordWritePlan | TeamExtensionRecordExistingPlan
  | TeamExtensionRecordNoopPlan

/** Atomic native Task updates with opaque extension-owned JSON. */
export interface TeamTaskTransactionWritePlan {
  readonly updates: readonly TeamTaskTransactionUpdate[]
  readonly dataJson: string
  /** Durable Team messages enqueued atomically with the Task updates. */
  readonly notices?: readonly TeamExtensionNotice[]
  /** Host-only opt-in for factual notices to the Lead itself; omitted preserves normal self-message rejection. */
  readonly allowLeadSelfNotices?: boolean
}

/** Return an earlier committed Task result without appending an event. */
export interface TeamTaskTransactionExistingPlan {
  readonly existingTaskIds: readonly TeamTaskId[]
}

/** A new atomic write or an existing result selected under the same Team lock. */
export type TeamTaskTransactionPlan = TeamTaskTransactionWritePlan | TeamTaskTransactionExistingPlan

/** Runtime-enriched task view returned to tools and hosts. */
export interface TeamTaskView {
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

/** One durable roster row published through the `agentTeam` Session projection. */
export interface TeamMemberProjection {
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

/**
 * Durable Team state published to browser clients through the Lead Session's
 * `agentTeam` projection. `failure` names the first rejected persisted Team
 * record; members and tasks then stay at the last valid state.
 */
export interface TeamProjection {
  /** Present after the first native seat transaction; no product transition phase is embedded here. */
  readonly lead?: import('./lead-seat.ts').TeamLeadBinding
  readonly members: TeamMemberProjection[]
  readonly tasks: TeamTaskView[]
  /** Absent for an untouched official Team, which remains dynamic. */
  readonly composition?: TeamCompositionView
  readonly failure?: string
}

/** Durable user-managed association, independent of whether the Team is locked. */
export interface TeamProfileAssociation {
  readonly id: string
  readonly version: number
  readonly modified: boolean
}

/** One recoverable Profile application; targetJson belongs to the outer product. */
export interface TeamCompositionApplication {
  readonly id: string
  readonly profileId: string
  readonly profileVersion: number
  readonly targetJson: string
  readonly retiringMemberIds: readonly SessionId[]
  readonly previousPhase: 'dynamic' | 'fixed'
  readonly changed: boolean
  readonly diagnostic?: string
}

/** Native Team composition policy folded from the Lead Session. */
export interface TeamCompositionState {
  readonly phase: 'dynamic' | 'applying' | 'fixed'
  readonly profile?: TeamProfileAssociation
  readonly application?: TeamCompositionApplication
  /** Last successfully applied target; only the owning product interprets this JSON. */
  readonly appliedTargetJson?: string
  /** Current Profile-slot associations after explicit member changes; the original applied target remains unchanged. */
  readonly slotBindings?: readonly TeamProfileSlotBinding[]
}

/** One Profile slot's current member, including a retained historical member until explicitly replaced. */
export interface TeamProfileSlotBinding {
  readonly slotId: string
  readonly memberId: SessionId
}

/** Detached native state offered to an authenticated Host composition operation under the Team lock. */
export interface TeamCompositionSnapshot {
  readonly composition: TeamCompositionState
  readonly members: readonly TeamMemberSnapshot[]
  readonly tasks: readonly TeamTaskSnapshot[]
  readonly maxMembers: number
  readonly maxActiveMembers: number
}

/** Client-safe portion of native composition policy. */
export interface TeamCompositionView {
  readonly phase: TeamCompositionState['phase']
  readonly profile?: TeamProfileAssociation
  readonly application?: Pick<TeamCompositionApplication, 'id' | 'profileId' | 'profileVersion' | 'diagnostic'>
}

/** Host-only transition proposed under the Team lock. */
export type TeamCompositionTransition =
  | { readonly kind: 'begin'
    readonly applicationId: string
    readonly profileId: string
    readonly profileVersion: number
    readonly targetJson: string
    readonly retiringMemberIds: readonly SessionId[]
    readonly previousPhase: 'dynamic' | 'fixed' }
  | { readonly kind: 'target'; readonly applicationId: string; readonly targetJson: string }
  | { readonly kind: 'diagnostic'; readonly applicationId: string; readonly message: string }
  | { readonly kind: 'finish'; readonly applicationId: string }
  | { readonly kind: 'stop'; readonly applicationId: string }
  | { readonly kind: 'lock' }
  | { readonly kind: 'unlock' }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Durable roster and non-deleted task board of the Team rooted at the projected Session. */
    agentTeam: TeamProjection
  }
}

/** Read-only stable Team and current execution; this value grants no collaboration authority or activation. */
export interface TeamLeadContext {
  readonly anchor: Agent
  /** Detached value of the committed current seat, independent of readiness. */
  readonly seat: TeamLeadSeat
  /** Exact loaded matching execution; omitted when cold or invalid, without invoking a resolver. */
  readonly execution?: Agent
  /** Whether the committed execution is loaded and its registered owner permits consuming input. */
  readonly ready: boolean
}

/** Server-recorded authorship of one unchanged Lead-authored content block. */
export interface TeamContentAuthor {
  readonly executionId: SessionId
  readonly term: number
}

/** Native queue custody for one source-held input; the original message remains unchanged. */
export interface TeamInputTransfer {
  /** Original source Session; it is not a claimed new sender. */
  readonly sourceExecutionId: SessionId
  /** Source's own persisted capture fact; later capture of the same input gets another queue key. */
  readonly heldSeq: SessionSeq
  /** Unmodified input, including original message id/source and effective/requested queue plus wake intent. */
  readonly input: AgentInput
}

/** Sole native acknowledgement of one queue item's actual Lead recipient. */
export interface TeamLeadDeliveryReceipt {
  readonly messageId: TeamMessageId
  readonly targetId: SessionId
  readonly executionId: SessionId
  readonly term: number
}

/** One mailbox item retained until its target Session records it. */
export interface TeamMessageSnapshot {
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

/** Ordinary peer snapshot; only native input-queued facts may hold transferred AgentInput. */
export type TeamPeerMessageSnapshot = Omit<TeamMessageSnapshot, 'transfer'>

/** Extension-only admission hint stripped before a Team notice is persisted. */
export interface TeamExtensionNotice extends TeamPeerMessageSnapshot {
  /** Count the complete delivered content against a controlled Team's ordinary-message limit. */
  readonly ordinaryMessageLimit?: true
}

/** Lead-authorized cancellation of one undelivered Team message. */
export interface TeamMessageCancellation {
  readonly messageId: TeamMessageId
  readonly targetId: SessionId
  readonly reason: string
}

/** Source retained by the target Session for durable mailbox de-duplication. */
export interface TeamMessageSource {
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

/** Retired tool-limit fields retained only to describe released persistent records. */
export interface TeamMemberToolLimit {
  /** Optional allowlist over inherited, Preset-local, and Team-scoped member tools. */
  readonly allow?: readonly string[]
  /** Optional denylist; denial wins over an allowlist. */
  readonly deny?: readonly string[]
}

/** Immutable root-Session policy for a controlled Team, persisted before Team tools are admitted. */
export interface TeamControlledMode {
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

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-message': TeamMessageSource
  }
}

/** Team-service deployment limits. */
export interface Config {
  /** Initial delay between controlled-mail receipt retries; successive attempts multiply it. */
  readonly messageRetryDelayMs?: number
  /** Maximum same-process retries before a durable Lead warning. */
  readonly maxMessageRetries?: number
  /** Product opt-in; requires an ordinary-message byte cap. Official Teams leave this unset. */
  readonly controlledMode?: Omit<TeamControlledMode, 'memberToolLimit' | 'maxOrdinaryMessageBytes'>
    & {
      /** Required UTF-8 byte cap for ordinary member messages in a new controlled Team. */
      readonly maxOrdinaryMessageBytes: number
    } | undefined
  /** Optional product default for members without an explicit Preset; official Teams inherit the Lead. */
  readonly defaultMemberPresetId?: string
  /** Maximum immutable teammate names retained by one Team. */
  readonly maxMembers?: number
  /** Maximum provisioning, active, or retiring teammates in one Team. */
  readonly maxActiveMembers?: number
  /** Maximum non-deleted tasks retained by one Team. */
  readonly maxTasks?: number
  /** Maximum queued messages without delivery or cancellation for one target member. */
  readonly maxPendingMessagesPerMember?: number
  /** Maximum UTF-8 bytes in one extension-owned Task transaction payload. */
  readonly maxTaskExtensionBytes?: number
  /** Maximum UTF-8 bytes in one complete sender-framed delivery. */
  readonly maxMessageBytes?: number
  /** Maximum milliseconds allowed for Team-owned runtime disposal. */
  readonly disposalTimeoutMs?: number
}

/** Input for creating one durable teammate. */
export interface SpawnTeammateRequest {
  readonly name: string
  /** Host-reserved creation identity for retryable controlled provisioning; model tools do not expose it. */
  readonly reservedMemberId?: SessionId
  /** Required in the official Team; controlled Teams derive a label from the selected Preset. */
  readonly description?: string
  readonly group?: string
  readonly prompt: ContentBlock[]
  readonly context: 'fresh' | 'fork'
  readonly provider: string
  /** Declared Preset to bind instead of inheriting the Lead composition. */
  readonly presetId?: string
  /** Expected declaration revision for a Profile slot; mismatch rejects before creation. */
  readonly expectedPresetRevision?: string
  /** Only a matching in-progress application may create a member while applying. */
  readonly applicationId?: string
  readonly slotId?: string
  readonly signal: AbortSignal
}

/** Result after one teammate reaches a durable active or failed edge. */
export interface SpawnTeammateResult {
  readonly member: TeamMemberView
}

/** Input for one durable peer message. */
export interface SendTeamMessageRequest {
  readonly target: string
  readonly content: ContentBlock[]
  readonly signal: AbortSignal
}

/** Result after a peer message enters the durable mailbox. */
export interface SendTeamMessageResult {
  readonly messageId: TeamMessageId
  readonly status: 'accepted' | 'queued'
}

/** Input for creating one shared task. */
export interface CreateTeamTaskRequest {
  readonly subject: string
  readonly description: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
}

/** Supported task mutation actions. */
export type TeamTaskAction =
  | 'claim'
  | 'release'
  | 'edit'
  | 'set_dependencies'
  | 'complete'
  | 'reopen'
  | 'reassign'
  | 'delete'

/** Compare-and-set mutation of one shared task. */
export interface UpdateTeamTaskRequest {
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly action: TeamTaskAction
  readonly subject?: string
  readonly description?: string
  readonly blockedBy?: readonly TeamTaskId[]
  readonly writeScopes?: readonly string[]
  readonly owner?: string
}

/** Result of waiting for Team activity. */
export interface TeamWaitResult {
  readonly timedOut: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Immutable controlled-mode policy written before a new Lead can use Team tools. */
    'team/mode': { version: 1; teamId: TeamId; mode: TeamControlledMode }
    /** User-managed composition policy, persisted before the next roster mutation. */
    'team/composition': { version: 1; teamId: TeamId; transition: TeamCompositionTransition }
    /** Whole teammate lifecycle value, stored only in the Team Lead Session. */
    'team/member': { version: 2; teamId: TeamId; member: TeamMemberLegacySnapshot }
    /** Explicit-Preset or extended-lifecycle member value, without changing the released version-two event. */
    'team/member/configured': { version: 3; teamId: TeamId; member: TeamMemberSnapshot }
    /** Whole shared-task value, stored only in the Team Lead Session. */
    'team/task': { version: 2; teamId: TeamId; task: TeamTaskSnapshot }
    /** One atomic Task update batch and extension record in the Lead Session. */
    'team/task/transaction': {
      version: 1
      teamId: TeamId
      updates: TeamTaskTransactionUpdate[]
      extension: { id: string; dataJson: string }
      notices?: TeamPeerMessageSnapshot[]
    }
    /** One opaque extension record and optional Team notices, without a Task update. */
    'team/extension': {
      version: 1
      teamId: TeamId
      extension: { id: string; recordId: string; dataJson: string }
      notices?: TeamPeerMessageSnapshot[]
      /** A product permission-table change invalidates any associated Profile. */
      affectsComposition?: true
      /** Native admission accompanying an independently owned coordinator record. */
      leadTransition?: TeamLeadTransition
      /** Registered owner and term of an opaque coordination record, including non-transition material. */
      coordinatorOperation?: { readonly operationId: TeamLeadOperationId; readonly previousTerm: number }
    }
    /** Durable mailbox enqueue, stored before delivery is attempted. */
    'team/message/queued': { version: 2; teamId: TeamId; message: TeamPeerMessageSnapshot }
    /** Source-held input admitted into the same native mailbox under a capture-specific key. */
    'team/message/input-queued': { version: 1; teamId: TeamId; message: TeamMessageSnapshot & { readonly transfer: TeamInputTransfer } }
    /** Sole receipt for a controlled logical Lead target and its actual execution. */
    'team/message/lead-delivered': { version: 1; teamId: TeamId } & TeamLeadDeliveryReceipt
    /** Durable acknowledgement that the target Session recorded the message. */
    'team/message/delivered': {
      version: 2
      teamId: TeamId
      messageId: TeamMessageId
      targetId: SessionId
    }
    /** Lead-authorized cancellation of pending messages for one teammate. */
    'team/message/cancelled': {
      version: 3
      teamId: TeamId
      targetId: SessionId
      messageIds: TeamMessageId[]
      reason: string
    }
  }
}
