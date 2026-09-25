/** Pure native Task revision and DAG fold for extension-owned atomic updates. */

import { assertTaskGraph } from './task-graph.ts'
import type { TeamTaskSnapshot, TeamTaskTransactionUpdate } from './types.ts'

/** Rejection category shared by commit-time and replay-time validation. */
export type TaskTransactionViolation = 'empty' | 'duplicate' | 'stale' | 'id-space' | 'revision' | 'result-marker'

/** Exact invalid Task transaction relation. */
export class TeamTaskTransactionError extends Error {
  /**
   * @param message - concrete invalid Task update.
   * @param violation - stable rejection category.
   */
  constructor(message: string, readonly violation: TaskTransactionViolation) {
    super(message)
    this.name = 'TeamTaskTransactionError'
  }
}

/**
 * Fold one atomic update batch without mutating the current Task collection.
 * @param current - committed Task snapshots before this event.
 * @param nextTaskNumber - next native numeric Task identity.
 * @param updates - new and next-revision snapshots in one event.
 * @returns complete final Task collection and next numeric identity.
 */
export function applyTaskTransaction(
  current: readonly TeamTaskSnapshot[],
  nextTaskNumber: number,
  updates: readonly TeamTaskTransactionUpdate[],
): { tasks: TeamTaskSnapshot[]; nextTaskNumber: number } {
  if (updates.length === 0) throw new TeamTaskTransactionError('Task transaction has no updates', 'empty')
  const tasks = [...current]
  const touched = new Set<string>()
  let next = nextTaskNumber
  for (const update of updates) {
    const { task, previousRevision } = update
    if (touched.has(task.id)) throw new TeamTaskTransactionError(`Task "${task.id}" occurs twice`, 'duplicate')
    touched.add(task.id)
    const index = tasks.findIndex(candidate => candidate.id === task.id)
    const prior = tasks[index]
    if (previousRevision === null) {
      if (task.resultUnavailable === true) {
        throw new TeamTaskTransactionError(`new Task "${task.id}" cannot start with an unavailable result`, 'result-marker')
      }
      if (prior !== undefined) {
        throw new TeamTaskTransactionError(`Task "${task.id}" already exists`,
          task.id === `task-${next}` ? 'id-space' : 'stale')
      }
      if (task.id !== `task-${next}`) {
        throw new TeamTaskTransactionError(`new Task "${task.id}" must use task-${next}`, 'id-space')
      }
      if (task.revision !== 1) throw new TeamTaskTransactionError(`new Task "${task.id}" must begin at revision 1`, 'revision')
      tasks.push(task)
      if (next < Number.MAX_SAFE_INTEGER) next += 1
      continue
    }
    if (!Number.isSafeInteger(previousRevision) || previousRevision < 1
      || prior === undefined || prior.revision !== previousRevision) {
      throw new TeamTaskTransactionError(`stale Task "${task.id}" revision`, 'stale')
    }
    if (previousRevision === Number.MAX_SAFE_INTEGER || task.revision !== previousRevision + 1) {
      throw new TeamTaskTransactionError(`Task "${task.id}" revision is not contiguous`, 'revision')
    }
    if (prior.resultUnavailable === true && task.resultUnavailable !== true) {
      throw new TeamTaskTransactionError(`Task "${task.id}" cannot restore an unavailable result`, 'result-marker')
    }
    if (prior.resultUnavailable !== true && task.resultUnavailable === true && prior.status !== 'completed') {
      throw new TeamTaskTransactionError(`Task "${task.id}" has no completed result to invalidate`, 'result-marker')
    }
    tasks[index] = task
  }
  assertTaskGraph(tasks)
  return { tasks, nextTaskNumber: next }
}
