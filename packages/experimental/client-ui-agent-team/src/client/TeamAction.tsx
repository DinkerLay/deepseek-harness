import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamMemberProjection,
  TeamProjection,
  TeamTaskView as TeamTask,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import {
  IconChevronDownOutlineRegular, IconCloseOutlineRegular,
  IconUserOutlineRegular, IconUsersOutlineRegular, StateDot, Tag, Tooltip,
  isBehindModal, useAnchoredPosition, useDismissOnOutsidePointer, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import type {} from './task-view-slots.ts'
import css from './TeamAction.module.css'

/** Business actions injected by the browser plugin. */
export interface TeamActionInjected {
  /** Open a roster Session from the current conversation. */
  openTeammate: (sessionId: SessionId, childSessionId: SessionId, addressSessionId?: SessionId) => void
}

/** Durable lifecycle overlaid with the member Session's live turn activity. */
type MemberStatus = 'running' | 'inactive' | 'provisioning' | 'failed' | 'retiring' | 'retired' | 'changing'

/** Full props of the Team conversation-header action. */
export type TeamActionProps =
  PropsRuntime<'conversation.session.header.actions'> & TeamActionInjected & PropsLocale<typeof NS>
  & PropsRenderSlots<'agent-team.panel.member.meta' | 'agent-team.panel.member.action' | 'agent-team.panel.task.action'
    | 'agent-team.panel.tasks.action' | 'agent-team.panel.tasks.graph'
    | 'agent-team.panel.tasks.content' | 'agent-team.panel.header.actions'>

function statusKey(status: TeamTask['status']): TeamKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'in_progress': return 'status.in_progress'
    case 'completed': return 'status.completed'
    /* v8 ignore next -- Team views omit deleted task tombstones. */
    case 'deleted': return 'status.completed'
  }
}

function memberStatusKey(status: MemberStatus): TeamKey {
  switch (status) {
    case 'running': return 'memberStatus.running'
    case 'inactive': return 'memberStatus.inactive'
    case 'provisioning': return 'memberStatus.provisioning'
    case 'failed': return 'memberStatus.failed'
    case 'retiring': return 'memberStatus.retiring'
    case 'retired': return 'memberStatus.retired'
    case 'changing': return 'memberStatus.changing'
  }
}

function memberDotState(status: Exclude<MemberStatus, 'inactive'>): StateDotState {
  switch (status) {
    case 'running':
    case 'provisioning':
    case 'changing':
    case 'retiring': return 'ongoing'
    case 'failed': return 'error'
    case 'retired': return 'idle'
  }
}

function taskDotState(task: TeamTask): StateDotState {
  switch (task.status) {
    case 'pending': return task.ready ? 'idle' : 'warning'
    case 'in_progress': return 'ongoing'
    case 'completed': return 'done'
    /* v8 ignore next -- Team views omit deleted task tombstones. */
    case 'deleted': return 'idle'
  }
}

type TeamMemberRowProps = Pick<TeamActionProps,
  'sessionId' | 'useSessions' | 'useSessionStatus' | 'openTeammate' | 'renderSlot' | 't'
> & {
  member: TeamMemberProjection
  memberCount: number
  leadSessionId: SessionId
  leadBinding: TeamProjection['lead']
  onError: (message: string) => void
}

function TeamMemberRow({
  member, memberCount, leadSessionId, leadBinding, sessionId, useSessions, useSessionStatus, openTeammate, renderSlot, onError, t,
}: TeamMemberRowProps) {
  const seat = member.role === 'lead' ? leadBinding : undefined
  // Stable roster identity and current execution are different navigation targets.
  const executionId = seat?.executionId ?? member.execution?.executionId ?? member.id
  const model = useSessions(state => state.projectionsBySession[executionId]?.values.modelSelection?.next?.model)
  const preset = useSessions(state => state.byId[executionId]?.projectionValues?.agentPreset)
  const leadPreset = useSessions(state => state.byId[leadBinding?.executionId ?? leadSessionId]?.projectionValues?.agentPreset)
  const running = useSessionStatus(state => state.get(executionId)?.running)
  const summaryRunning = useSessions(state => state.byId[executionId]?.running)
  const status: MemberStatus = member.executionHeld === true ? 'changing' : member.phase === 'active'
    ? (running ?? summaryRunning) === true ? 'running' : 'inactive'
    : member.phase
  const isCurrent = executionId === sessionId
  const unstarted = status !== 'changing' && member.phase === 'active' && member.executionStarted === false
  const highlightCurrent = isCurrent && memberCount > 1
  const inert = isCurrent || unstarted || status === 'failed' || status === 'provisioning'
    || status === 'retiring' || status === 'retired' || status === 'changing'
  const presetId = seat?.presetId ?? (typeof preset === 'string' ? preset
    : member.preset?.id ?? leadBinding?.presetId ?? (typeof leadPreset === 'string' ? leadPreset : undefined))
  const presetMeta = renderSlot('agent-team.panel.member.meta', { member,
    ...presetId === undefined ? {} : { presetId } })

  return (
    <div className={css.memberRow}>
      <Tooltip label={t('open')} side="bottom" gap={4} disabled={inert}>
        <button
          type="button"
          className={highlightCurrent ? `${css.member} ${css.memberCurrent}` : css.member}
          disabled={inert}
          onClick={() => {
            try {
              openTeammate(sessionId, member.role === 'lead' ? member.id : executionId)
            } catch (reason) {
              onError(String(reason))
            }
          }}
        >
          <span className={css.memberDot}>
            {status === 'inactive'
              ? <IconUserOutlineRegular size={14} className={css.inactiveIcon} />
              : <StateDot state={memberDotState(status)} />}
          </span>
          <span className={css.memberText}>
            <span className={css.memberName}>
              <span className={css.memberNameText}>{member.name}</span>
              {isCurrent && <Tag tone="info" className={css.currentTag}>{t('current')}</Tag>}
              {member.execution !== undefined && <Tag>{t('generation')} {member.execution.generation}</Tag>}
            </span>
            <small>
              {t(unstarted ? 'memberStatus.unstarted' : memberStatusKey(status))}
              {(presetMeta === null || presetMeta === undefined) && presetId !== undefined && (
                <span className={css.memberModel}>{` · ${t('preset')}: ${presetId}`}</span>
              )}
              {model !== undefined && (
                <span className={css.memberModel}>{` · ${t('model')}: ${model}`}</span>
              )}
            </small>
            {presetMeta}
            {member.error !== undefined && <small className={css.diagnostic}>{member.error}</small>}
          </span>
        </button>
      </Tooltip>
      {renderSlot('agent-team.panel.member.action', { member, leadSessionId })}
    </div>
  )
}

/** Task card with a two-line description clamp expanded from a toggle in the meta row. */
function TaskCard({ task, leadSessionId, closePanel, renderSlot, t }: {
  task: TeamTask
  leadSessionId: SessionId
  closePanel: () => void
  renderSlot: TeamActionProps['renderSlot']
  t: TranslateNS<typeof NS>
}) {
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    if (expanded) return
    const paragraph = textRef.current
    /* v8 ignore next -- the paragraph mounts in the same commit as the effect. */
    if (paragraph === null) return
    const measure = (): void => { setClamped(paragraph.scrollHeight > paragraph.clientHeight + 1) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(paragraph)
    return () => { observer.disconnect() }
  }, [task.description, expanded])
  return (
    <article className={css.task}>
      <div className={css.taskTitle}>
        <strong>{task.subject}</strong>
        <span className={css.taskState}>
          <StateDot state={taskDotState(task)} />
          <span>{t(statusKey(task.status))}</span>
        </span>
      </div>
      <p ref={textRef} className={expanded ? undefined : css.clampedDescription}>{task.description}</p>
      <div className={css.meta}>
        <span className={css.taskControls}>
          {renderSlot('agent-team.panel.task.action', { task, leadSessionId, closePanel })}
          {(clamped || expanded) && (
            <button type="button" className={css.expandToggle} aria-expanded={expanded}
              onClick={() => { setExpanded(current => !current) }}>
              {t(expanded ? 'task.collapse' : 'task.expand')}
              <IconChevronDownOutlineRegular size={12} className={expanded ? css.expandToggleOpen : undefined} />
            </button>
          )}
        </span>
        <span>{task.id}</span>
        <span>{t('owner')}: {task.ownerName ?? t('unowned')}</span>
        {task.status === 'pending' && <span>{task.ready ? t('ready') : t('blocked')}</span>}
        {task.blockedBy.length > 0 && <span>{t('blockedBy')}: {task.blockedBy.join(', ')}</span>}
        {task.writeScopes.length > 0 && <span>{t('writeScopes')}: {task.writeScopes.join(', ')}</span>}
        {task.writeScopeWarnings.map(warning => <span key={warning} className={css.warning}>{warning}</span>)}
      </div>
    </article>
  )
}

/** Render the Team roster and read-only task board. */
export function TeamAction({
  sessionId, sessionAddressId, useSession, useSessions, useSessionStatus, openTeammate, renderSlot, t,
}: TeamActionProps) {
  const [open, setOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const triggerLabelRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({
    open, anchorRef: triggerRef, panelRef, gap: 5, margin: 16,
  })
  const positioned = position !== null
  const parentSessionId = useSession(snapshot => snapshot.subagent?.address.parentSessionId)
  const explicitAddress = sessionAddressId !== sessionId ? sessionAddressId : undefined
  const leadSessionId = explicitAddress ?? parentSessionId ?? sessionId
  const openMember: TeamActionInjected['openTeammate'] = (source, member) => {
    if (explicitAddress === undefined) openTeammate(source, member)
    else openTeammate(source, member, explicitAddress)
  }
  const team = useSessions(state => state.projectionsBySession[leadSessionId]?.values.agentTeam)
  const opening = useSession(snapshot => snapshot.openState === 'loading')
  const listing = useSessions(state => state.phase === 'pending')
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pinnedRef = useRef(false)

  const cancelHoverChange = (): void => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = undefined
  }

  useEffect(() => {
    cancelHoverChange()
    pinnedRef.current = false
    setOpen(false)
    setGraphOpen(false)
    setError(null)
  }, [sessionId])

  useEffect(() => cancelHoverChange, [])

  useLayoutEffect(() => {
    if (open && positioned && pinnedRef.current) panelRef.current?.focus()
  }, [open, positioned])

  const changeOpen = (next: boolean): void => {
    cancelHoverChange()
    if (!next) pinnedRef.current = false
    setOpen(next)
  }

  const scheduleHoverOpen = (): void => {
    cancelHoverChange()
    if (open) return
    const label = triggerLabelRef.current
    /* v8 ignore next -- the label mounts with the trigger that received the hover. */
    if (label === null) return
    // Icon-only trigger (label collapsed by the header container query):
    // hover-open would surprise on such a small target, so only click opens.
    if (getComputedStyle(label).display === 'none') return
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = undefined
      changeOpen(true)
    }, 150)
  }

  const scheduleHoverClose = (): void => {
    cancelHoverChange()
    if (pinnedRef.current || isBehindModal(rootRef.current)) return
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = undefined
      if (!isBehindModal(rootRef.current)) changeOpen(false)
    }, 120)
  }

  useDismissOnOutsidePointer(rootRef, open, (next) => {
    if (!isBehindModal(rootRef.current)) changeOpen(next)
  }, panelRef)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || isBehindModal(rootRef.current)) return
      event.preventDefault()
      cancelHoverChange()
      pinnedRef.current = false
      setOpen(false)
      if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
    }
    document.addEventListener('keydown', dismiss)
    return () => { document.removeEventListener('keydown', dismiss) }
  }, [open])

  const compact = team !== undefined && team.members.length === 1 && team.tasks.length === 0
  const memberSections: Array<{ label?: string; members: TeamMemberProjection[] }> = []
  if (team !== undefined) {
    if (!team.members.some(member => member.group !== undefined)) {
      memberSections.push({ members: team.members })
    } else {
      memberSections.push({ members: team.members.filter(member => member.role === 'lead') })
      const grouped = new Map<string, TeamMemberProjection[]>()
      for (const member of team.members) {
        if (member.role === 'lead') continue
        const label = member.group ?? t('group.ungrouped')
        const members = grouped.get(label) ?? []
        members.push(member)
        grouped.set(label, members)
      }
      for (const [label, members] of grouped) memberSections.push({ label, members })
    }
  }
  const nativeTaskContent = team === undefined ? null : team.tasks.length === 0
    ? <p className={css.emptyNotice}>{t('empty')}</p>
    : <>
      <h3>
        {t('tasks')}<span className={css.count}>{team.tasks.length}</span>
        {renderSlot('agent-team.panel.tasks.action', {
          view: team, active: graphOpen, openGraph: () => { setGraphOpen(value => !value) },
        })}
      </h3>
      {graphOpen
        ? renderSlot('agent-team.panel.tasks.graph', {
          view: team, leadSessionId, closePanel: () => { changeOpen(false) },
        })
        : <div className={css.tasks}>{team.tasks.map(task => <TaskCard key={task.id} task={task}
          leadSessionId={leadSessionId} closePanel={() => { changeOpen(false) }} renderSlot={renderSlot} t={t} />)}</div>}
    </>

  return (
    <div
      ref={rootRef}
      className={css.root}
      data-team-action
      data-team-projection-ready={team !== undefined && (team.members.length > 1 || team.tasks.length > 0)
        ? '' : undefined}
      onMouseLeave={scheduleHoverClose}
    >
      <button
        type="button"
        ref={triggerRef}
        onMouseEnter={scheduleHoverOpen}
        className={css.trigger}
        aria-label={t('trigger')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          cancelHoverChange()
          pinnedRef.current = true
          if (!open) changeOpen(true)
          else panelRef.current?.focus()
        }}
      >
        <IconUsersOutlineRegular size={14} />
        <span ref={triggerLabelRef} className={css.triggerLabel}>{t('trigger')}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={compact ? `${css.panel} ${css.panelCompact}` : css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          tabIndex={-1}
          aria-label={t('trigger')}
          data-team-panel
          onMouseEnter={cancelHoverChange}
          onMouseLeave={scheduleHoverClose}
        >
          <div className={css.panelHeader}>
            <strong>{t('trigger')}</strong>
            {renderSlot('agent-team.panel.header.actions', {
              ...team === undefined ? {} : { view: team },
              leadSessionId, closePanel: () => { changeOpen(false) },
            })}
            <button type="button" className={css.closeButton} aria-label={t('close')}
              onClick={() => { changeOpen(false) }}><IconCloseOutlineRegular size={16} /></button>
          </div>
          <div className={css.body} data-team-panel-body>
            {error !== null && (
              <div className={css.error} role="alert"><StateDot state="error" />{error}</div>
            )}
            {team === undefined && (
              <div className={css.notice} role="status">
                <StateDot state={opening || listing ? 'ongoing' : 'warning'} />
                {t(opening || listing ? 'loading' : 'unavailable')}
              </div>
            )}
            {team !== undefined && (
              <>
                {team.failure !== undefined && (
                  <div className={css.error} role="alert"><StateDot state="error" />{t('failure', { message: team.failure })}</div>
                )}
                <section className={css.membersPane}>
                  <h3>
                    {t('roster')}
                    {team.members.length > 1 && <span className={css.count}>{team.members.length}</span>}
                  </h3>
                  <div className={css.roster}>
                    {memberSections.map(({ label, members }, index) => <Fragment key={label ?? `lead-${index}`}>
                      {label !== undefined && <h4 className={css.groupHeading}>{label}</h4>}
                      {members.map(member => (
                        <TeamMemberRow
                          key={member.id}
                          member={member}
                          memberCount={team.members.length}
                          leadSessionId={leadSessionId}
                          leadBinding={team.lead}
                          sessionId={sessionId}
                          useSessions={useSessions}
                          useSessionStatus={useSessionStatus}
                          openTeammate={openMember}
                          renderSlot={renderSlot}
                          onError={setError}
                          t={t}
                        />
                      ))}
                    </Fragment>)}
                  </div>
                </section>
                <section className={css.tasksPane}>
                  {renderSlot('agent-team.panel.tasks.content', {
                    view: team, leadSessionId, closePanel: () => { changeOpen(false) },
                  }, { fallback: nativeTaskContent })}
                </section>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
