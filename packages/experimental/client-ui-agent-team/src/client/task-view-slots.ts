/** Optional views that extend the official Agent Team task section. */
import type { TeamProjection, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team/client'

/** Action beside the native task-list heading. */
export interface TeamTaskViewActionOwner {
  readonly view: TeamProjection
  readonly active: boolean
  readonly openGraph: () => void
}

/** Current native Team projection supplied to a graph renderer. */
export interface TeamTaskGraphOwner {
  readonly view: TeamProjection
  /** Opens the owner's conversation, not a task-specific Turn. */
  readonly openMemberSession: (task: TeamTaskView) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Optional action that opens a task view without replacing the Team panel. */
    'agent-team.panel.tasks.action': { kind: 'list'; scope: 'session'; owner: TeamTaskViewActionOwner }
    /** One read-only task view selected from the native Team task section. */
    'agent-team.panel.tasks.graph': { kind: 'single'; scope: 'session'; owner: TeamTaskGraphOwner }
  }
}
