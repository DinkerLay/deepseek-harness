/** Host-only interface for one optional product Task writer over the native Board. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentInput } from '@deepseek-ai/dsh-agent'
import type { TeamExecutionMaintenanceRequest, TeamExecutionMaintenanceScope } from './execution-maintenance-types.ts'
import type { SubagentSettlementNoticeFacts } from '@deepseek-ai/dsh-subagent'
import type {
  CreateTeamTaskRequest,
  TeamExtensionRecordPlan,
  TeamExtensionRecordSnapshot,
  TeamTaskTransactionPlan,
  TeamTaskTransactionSnapshot,
  TeamTaskTransactionUpdate,
  TeamTaskId,
  TeamTaskView,
  UpdateTeamTaskRequest,
} from './types.ts'

/** Synchronous planner called under the native Team transaction lock. */
export type TeamTaskTransactionBuilder = (snapshot: TeamTaskTransactionSnapshot) => TeamTaskTransactionPlan

/** Synchronous record planner called under the same native Team transaction lock. */
export type TeamExtensionRecordBuilder = (snapshot: TeamExtensionRecordSnapshot) => TeamExtensionRecordPlan

/** Native commit capability held only by the registered extension. */
export interface TeamTaskExtensionHandle {
  /** Check generic JSON and the actual configured extension byte limit without IO or publication.
   * @param dataJson - exact opaque JSON a planner intends to persist.
   * @throws when this capability is stale, JSON is invalid, or its UTF-8 representation exceeds the limit.
   */
  validateDataJson(dataJson: string): void
  /** Inspect durability without IO or granting Task write authority.
   * @param anchor - exact live controlled Team journal owner.
   * @returns whether its extension records have a confirmed native checkpoint.
   */
  recordsConfirmed(anchor: Agent): boolean
  /** Stop only an exact execution/turn and own original input while its existing controller closes run/claim.
   * @param caller - exact current Lead; products authenticate user or model initiation separately.
   * @param request - exact execution and synchronous product ownership check; a Lead target must be this live caller.
   * @param signal - caller cancellation, forwarded through owned cleanup.
   * @param callback - quiet live or exclusively stored source; do not retain or reuse its capability.
   * @returns callback result after original custody and scope handback settle; changed or unloaded Lead authority rejects.
   */
  withExecutionMaintenance<T>(caller: Agent, request: TeamExecutionMaintenanceRequest, signal: AbortSignal,
    callback: (scope: TeamExecutionMaintenanceScope) => Promise<T>): Promise<T>
  /** Read a detached native cut without granting its dormant anchor Lead authority.
   * @param anchor - exact live stable Team journal owner.
   * @param read - synchronous registered-writer observer; it must not enter another transaction.
   * @returns the observer's result under the native Team lock.
   */
  read<T>(anchor: Agent, read: (snapshot: TeamTaskTransactionSnapshot) => T): Promise<T>
  /**
   * Commit one Task batch and opaque extension record in the Lead Session.
   * An existing result returns without another event.
   * @param caller - exact live Team member authorizing this operation.
   * @param build - synchronous planner receiving a detached current Board snapshot.
   * @returns native Task views after the event has been flushed.
   */
  commit(caller: Agent, build: TeamTaskTransactionBuilder): Promise<TeamTaskView[]>
  /** Commit an opaque record and optional notices without changing a Task. */
  commitRecord(caller: Agent, build: TeamExtensionRecordBuilder): Promise<{ recordId: string; committed: boolean }>
  /** Remove the extension and restore the default native Task writer. */
  dispose(): void
}

/** Product writer selected for native create/update calls while installed. */
export interface TeamTaskExtension {
  /** Stable identifier stored with each extension-owned Task event. */
  readonly id: string
  /** Require an explicitly successful checkpoint before returning effects or delivering notices.
   * Pending same-process retries and reads confirm that checkpoint first; omission preserves official behavior.
   */
  readonly requireDurableAcknowledgement?: boolean
  /** Identify current work from this writer's authoritative review/notice facts, including older queued assignments.
   * @param anchor - exact stable Team host, not a model author.
   * @param input - original identified input and attribution; undefined classification is ordinary coordination.
   * @returns associated Task and current-work identity, or undefined for non-work input.
   */
  classifyInput?(anchor: Agent, input: AgentInput): { readonly taskId: TeamTaskId; readonly current: boolean } | undefined
  /** Validate prepared Lead releases and generate this writer's atomic product audit.
   * @param anchor - stable Team journal owner, not a model author.
   * @param snapshot - detached native state while the Team transaction is locked.
   * @param releases - exact prepared next revisions of every running Lead-owned Task.
   * @returns opaque writer-owned JSON committed with the releases and seat change.
   */
  planLeadRelease?(anchor: Agent, snapshot: TeamTaskTransactionSnapshot,
    releases: readonly TeamTaskTransactionUpdate[]): string
  /** Optional product-owned next-action hints appended to a controlled member's release result. */
  releaseHints?(caller: Agent): readonly string[]
  /**
   * Validate a proposed member group against extension-owned policy while the
   * native roster creation transaction is locked. Throw to reject creation.
   * @param caller - exact live Team Lead creating the member.
   * @param group - optional proposed group name.
   */
  validateMemberGroup?(caller: Agent, group: string | undefined): void
  /**
   * Read product work and durable Lead notices after one controlled member Activation.
   * Absence or an undecidable result preserves the native settlement notice.
   * @param facts - durable child-log interval captured before the child Agent was released.
   * @returns whether this product's work is covered or still needs a Lead reminder.
   */
  assessSettlementNotice?(facts: SubagentSettlementNoticeFacts): 'send' | 'suppress' | undefined
    | Promise<'send' | 'suppress' | undefined>
  /**
   * Read this member's processed but unsubmitted Task assignments after its Session log is flushed.
   * @param facts - settled child identity and log interval.
   * @returns Task ids, or an empty list when no processed work remains.
   */
  unsubmittedTaskIds?(facts: SubagentSettlementNoticeFacts): readonly TeamTaskId[] | Promise<readonly TeamTaskId[]>
  /**
   * Handle native Task creation without writing a version-two Task event.
   * @param caller - exact live Team member.
   * @param request - native Task creation input.
   * @param handle - registered atomic commit capability.
   * @returns committed native Task view.
   */
  create(caller: Agent, request: CreateTeamTaskRequest, handle: TeamTaskExtensionHandle): Promise<TeamTaskView>
  /**
   * Handle native Task updates so old model tools cannot bypass product rules.
   * @param caller - exact live Team member.
   * @param request - native Task update input.
   * @param handle - registered atomic commit capability.
   * @returns committed native Task view.
   */
  update(caller: Agent, request: UpdateTeamTaskRequest, handle: TeamTaskExtensionHandle): Promise<TeamTaskView>
}
