/** Public Agent Teams identities, durable records, and service request values. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContinuablePresetBinding } from '@deepseek-ai/dsh-subagent'

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

/** Stable identity of one technical execution of a Task request. */
export type TeamTaskAttemptId = Branded<'TeamTaskAttemptId'>

/**
 * Brand one generated Task attempt id.
 * @param id - unique attempt identity within its Team.
 * @returns the same string branded as an attempt identity.
 */
export function TeamTaskAttemptId(id: string): TeamTaskAttemptId {
  return id as TeamTaskAttemptId
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

/** Durable teammate lifecycle. */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed' | 'retiring' | 'retired'

/** Original version-two member record retained verbatim for released Session logs. */
export interface TeamMemberLegacySnapshot {
  readonly id: SessionId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly context: 'fresh' | 'fork'
  readonly phase: 'provisioning' | 'active' | 'failed'
  readonly error?: string
}

/** Whole durable value reconstructed from either member event generation. */
export interface TeamMemberSnapshot {
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

/** Current runtime-enriched roster row. */
export interface TeamMemberView {
  readonly id: SessionId
  readonly name: string
  readonly role: 'lead' | 'teammate'
  readonly status: 'running' | 'inactive' | 'provisioning' | 'failed' | 'retiring' | 'retired'
  readonly description?: string
  readonly provider?: string
  readonly context?: 'fresh' | 'fork'
  readonly preset?: ContinuablePresetBinding
  readonly model?: string
  readonly diagnostics: string[]
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
}

/** Exact accepted prerequisite revision observed when an Attempt began. */
export interface TeamTaskInputRevision {
  readonly taskId: TeamTaskId
  readonly revision: number
}

/** Submitted work kept separately from the mutable Task description. */
export interface TeamTaskResult {
  readonly summary: string
  readonly artifacts: string[]
}

/** One execution of the same Task request; quality rework creates a new Task instead. */
export interface TeamTaskAttemptSnapshot {
  readonly id: TeamTaskAttemptId
  readonly ownerId: SessionId
  readonly status: 'running' | 'submitted' | 'accepted' | 'rejected' | 'cancelled'
  readonly inputs: TeamTaskInputRevision[]
  readonly result?: TeamTaskResult
  readonly reason?: string
}

/** Review and validity facts paired with one current Task snapshot. */
export interface TeamManagedTaskState {
  readonly attempts: TeamTaskAttemptSnapshot[]
  readonly validity: 'none' | 'valid' | 'stale'
  readonly origin?: { readonly kind: 'rework'; readonly taskId: TeamTaskId; readonly reason: string }
  readonly replacedByTaskId?: TeamTaskId
}

/** Atomic update of one managed Task and its result/attempt facts. */
export interface TeamManagedTaskUpdate {
  readonly task: TeamTaskSnapshot
  readonly review: TeamManagedTaskState
}

/** Client/model view of an Attempt without exposing member Session identifiers. */
export interface TeamTaskAttemptView {
  readonly id: TeamTaskAttemptId
  readonly ownerName?: string
  readonly status: TeamTaskAttemptSnapshot['status']
  readonly inputs: TeamTaskInputRevision[]
  readonly result?: TeamTaskResult
  readonly reason?: string
}

/** Optional review detail on Tasks created by the managed Task writer. */
export interface TeamTaskReviewView {
  readonly attempts: TeamTaskAttemptView[]
  readonly validity: TeamManagedTaskState['validity']
  readonly origin?: NonNullable<TeamManagedTaskState['origin']>
  readonly replacedByTaskId?: TeamTaskId
}

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
  readonly writeScopeWarnings: string[]
  readonly review?: TeamTaskReviewView
}

/** Point-in-time roster and task-board projection returned to browser clients. */
export interface TeamView {
  readonly members: TeamMemberView[]
  readonly tasks: TeamTaskView[]
}

/** Client-visible change counter; Team records remain in the Host projection. */
export interface TeamActivitySignal {
  readonly revision: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    agentTeamActivity: TeamActivitySignal
  }

  interface SessionProjectionStateMap {
    agentTeamActivity: TeamActivitySignal
  }
}

/** One peer message retained until its target Session records it. */
export interface TeamMessageSnapshot {
  readonly id: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
  readonly targetId: SessionId
  readonly content: ContentBlock[]
}

/** Task-linked peer message; the older unlinked queue event remains unchanged. */
export interface TeamLinkedMessageSnapshot extends TeamMessageSnapshot {
  readonly taskId: TeamTaskId
}

/** Lead-only monitor row derived from the authoritative queued and delivered events. */
export interface TeamMessageView {
  readonly id: TeamMessageId
  readonly senderName: string
  readonly targetName: string
  /** Complete text blocks in sender order. */
  readonly text: string
  /** Lossless persisted JSON for non-text content and exact audit. */
  readonly contentJson: string
  readonly hasNonText: boolean
  readonly time: number
  readonly status: 'queued' | 'delivered'
  readonly taskId?: TeamTaskId
}

/** Newest-first window of the Lead's complete Team mailbox history. */
export interface TeamMessagePage {
  readonly messages: TeamMessageView[]
  readonly total: number
  readonly nextCursor?: TeamMessageId
}

/** Source retained by the target Session for durable mailbox de-duplication. */
export interface TeamMessageSource {
  readonly kind: 'team-message'
  readonly teamId: TeamId
  readonly messageId: TeamMessageId
  readonly senderId: SessionId
  readonly senderName: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'team-message': TeamMessageSource
  }
}

/** Team-service deployment limits. */
export interface Config {
  /** Maximum immutable teammate names retained by one Team. */
  readonly maxMembers?: number
  /** Maximum non-deleted tasks retained by one Team. */
  readonly maxTasks?: number
  /** Maximum queued-minus-delivered messages for one target member. */
  readonly maxPendingMessagesPerMember?: number
  /** Maximum UTF-8 bytes in one complete sender-framed delivery. */
  readonly maxMessageBytes?: number
  /** Maximum milliseconds allowed for Team-owned runtime disposal. */
  readonly disposalTimeoutMs?: number
}

/** Input for creating one durable teammate. */
export interface SpawnTeammateRequest {
  readonly name: string
  readonly description: string
  readonly prompt: ContentBlock[]
  readonly context: 'fresh' | 'fork'
  readonly provider: string
  /** Explicit declared Agent Preset; omission retains native inherited-composition behavior. */
  readonly presetId?: string
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
  /** Optional existing Task that the sender or recipient owns; Lead may link any Team Task. */
  readonly taskId?: TeamTaskId
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

/** Owner submission of the exact running Attempt for Lead review. */
export interface SubmitTeamTaskResultRequest {
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly attemptId: TeamTaskAttemptId
  readonly result: TeamTaskResult
}

/** Lead acceptance of the exact submitted Attempt. */
export interface AcceptTeamTaskResultRequest {
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly attemptId: TeamTaskAttemptId
}

/** Lead quality rejection: supersede the old Task with a new Task ID. */
export interface ReworkTeamTaskRequest {
  readonly taskId: TeamTaskId
  readonly expectedRevision: number
  readonly reason: string
  readonly blockedBy: readonly TeamTaskId[]
}

/** Result of waiting for Team activity. */
export interface TeamWaitResult {
  readonly timedOut: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole teammate lifecycle value, stored only in the Team Lead Session. */
    'team/member': { version: 2; teamId: TeamId; member: TeamMemberLegacySnapshot }
    /** Versioned member configuration and retirement without changing released member records. */
    'team/member/configured': { version: 3; teamId: TeamId; member: TeamMemberSnapshot }
    /** Whole shared-task value, stored only in the Team Lead Session. */
    'team/task': { version: 2; teamId: TeamId; task: TeamTaskSnapshot }
    /** Atomic managed Task records; released version-two Task events remain unchanged. */
    'team/task/managed': { version: 1; teamId: TeamId; updates: TeamManagedTaskUpdate[] }
    /** Durable mailbox enqueue, stored before delivery is attempted. */
    'team/message/queued': { version: 2; teamId: TeamId; message: TeamMessageSnapshot }
    /** Task-associated Team message, additive to the released unlinked queue event. */
    'team/message/queued-task': { version: 3; teamId: TeamId; message: TeamLinkedMessageSnapshot }
    /** Durable acknowledgement that the target Session recorded the message. */
    'team/message/delivered': {
      version: 2
      teamId: TeamId
      messageId: TeamMessageId
      targetId: SessionId
    }
  }
}
