/** Host-only interface for one optional product Task writer over the native Board. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  CreateTeamTaskRequest,
  TeamTaskTransactionPlan,
  TeamTaskTransactionSnapshot,
  TeamTaskView,
  UpdateTeamTaskRequest,
} from './types.ts'

/** Synchronous planner called under the native Team transaction lock. */
export type TeamTaskTransactionBuilder = (snapshot: TeamTaskTransactionSnapshot) => TeamTaskTransactionPlan

/** Native commit capability held only by the registered extension. */
export interface TeamTaskExtensionHandle {
  /**
   * Commit one Task batch and opaque extension record in the same Lead Session event.
   * @param caller - exact live Team member authorizing this operation.
   * @param build - synchronous planner receiving a detached current Board snapshot.
   * @returns native Task views after the event has been flushed.
   */
  commit(caller: Agent, build: TeamTaskTransactionBuilder): Promise<TeamTaskView[]>
  /** Remove the extension and restore the default native Task writer. */
  dispose(): void
}

/** Product writer selected for native create/update calls while installed. */
export interface TeamTaskExtension {
  /** Stable identifier stored with each extension-owned Task event. */
  readonly id: string
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
