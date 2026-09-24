/** Optional views that extend the official Agent Team task section. */
import type { TeamMemberProjection, TeamProjection, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Read-only member metadata beside the native activity line. */
export interface TeamMemberMetaOwner {
  readonly member: TeamMemberProjection
  readonly presetId?: string
}

/** One task's product action beside the native expand control. */
export interface TeamTaskCardActionOwner {
  readonly task: TeamTaskView
  readonly leadSessionId: SessionId
  readonly closePanel: () => void
}

/** Action beside the native task-list heading. */
export interface TeamTaskViewActionOwner {
  readonly view: TeamProjection
  readonly active: boolean
  readonly openGraph: () => void
}

/** Current native Team projection supplied to a graph renderer. */
export interface TeamTaskGraphOwner {
  readonly view: TeamProjection
  readonly leadSessionId: SessionId
  readonly closePanel: () => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Optional name of the effective Agent Preset shown on a member card. */
    'agent-team.panel.member.meta': { kind: 'single'; scope: 'session'; owner: TeamMemberMetaOwner }
    /** Optional Task navigation control beside the native expand toggle. */
    'agent-team.panel.task.action': { kind: 'single'; scope: 'session'; owner: TeamTaskCardActionOwner }
    /** Optional action that opens a task view without replacing the Team panel. */
    'agent-team.panel.tasks.action': { kind: 'list'; scope: 'session'; owner: TeamTaskViewActionOwner }
    /** One read-only task view selected from the native Team task section. */
    'agent-team.panel.tasks.graph': { kind: 'single'; scope: 'session'; owner: TeamTaskGraphOwner }
  }
}
