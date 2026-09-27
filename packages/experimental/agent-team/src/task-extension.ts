/** Host-only interface for one optional product Task writer over the native Board. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  CreateTeamTaskRequest,
  TeamExtensionRecordPlan,
  TeamExtensionRecordSnapshot,
  TeamTaskTransactionPlan,
  TeamTaskTransactionSnapshot,
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
  /** Additional model tools supplied by this extension as Team capabilities. */
  readonly teamToolNames?: readonly string[]
  /** Additional extension tools admitted during member standby; execution still checks product policy. */
  readonly standbyToolNames?: readonly string[]
  /** Optional product offer summary appended to a controlled member's release result. */
  claimableTaskIds?(caller: Agent): readonly TeamTaskId[]
  /**
   * Validate a proposed member group against extension-owned policy while the
   * native roster creation transaction is locked. Throw to reject creation.
   * @param caller - exact live Team Lead creating the member.
   * @param group - optional proposed group name.
   */
  validateMemberGroup?(caller: Agent, group: string | undefined): void
  /**
   * Whether this exact member currently owns a running product Attempt.
   * Controlled Team tool admission fails closed when this callback is absent.
   * @param caller - exact live Team member.
   * @returns whether non-standby tools may be used.
   */
  hasRunningAttempt?(caller: Agent): boolean
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
