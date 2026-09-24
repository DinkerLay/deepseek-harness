import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamMemberView as TeamRosterMember,
  TeamMessageId,
  TeamMessagePage,
  TeamTaskView as TeamTask,
  TeamView,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCloseOutlineRegular, IconRefreshOutlineRegular, IconUserOutlineRegular, MarkdownText, StateDot,
  useAnchoredPosition, useDismissOnOutsidePointer, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import css from './TeamAction.module.css'

/** Generated Remote result consumed directly by the Team UI. */
export type TeamActionResult<T> = RemoteResult<T>

/** Business actions injected by the browser plugin. */
export interface TeamActionInjected {
  load: (sessionId: SessionId) => Promise<TeamActionResult<TeamView>>
  loadMessages: (sessionId: SessionId, before?: TeamMessageId) => Promise<TeamActionResult<TeamMessagePage>>
  openTeammate: (sessionId: SessionId, member: TeamRosterMember) => void
}

/** Full props of the Team conversation-header action. */
export type TeamActionProps =
  PropsRuntime<'conversation.session.header.actions'> & TeamActionInjected & PropsLocale<typeof NS>
  & PropsRenderSlots<'agent-team.panel.tasks.action' | 'agent-team.panel.tasks.graph'>

function failureText(error: { readonly code: string; readonly message: string }): string {
  return `${error.message} (${error.code})`
}

function statusKey(status: TeamTask['status']): TeamKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'in_progress': return 'status.in_progress'
    case 'completed': return 'status.completed'
    /* v8 ignore next -- Team views omit deleted task tombstones. */
    case 'deleted': return 'status.completed'
  }
}

function taskDisplayStatus(task: TeamTask): TeamKey {
  if (task.review?.replacedByTaskId !== undefined) return 'review.replaced'
  if (task.review?.validity === 'stale') return 'review.stale'
  if (task.review?.attempts.at(-1)?.status === 'submitted') return 'review.submitted'
  if (task.review?.validity === 'valid') return 'review.accepted'
  return statusKey(task.status)
}

function memberStatusKey(status: TeamRosterMember['status']): TeamKey {
  switch (status) {
    case 'running': return 'memberStatus.running'
    case 'inactive': return 'memberStatus.inactive'
    case 'provisioning': return 'memberStatus.provisioning'
    case 'failed': return 'memberStatus.failed'
    case 'retiring': return 'memberStatus.retiring'
    case 'retired': return 'memberStatus.retired'
  }
}

function memberDotState(status: TeamRosterMember['status']): StateDotState {
  switch (status) {
    case 'running':
    case 'provisioning': return 'ongoing'
    case 'inactive': return 'idle'
    case 'failed': return 'error'
    case 'retiring': return 'warning'
    case 'retired': return 'idle'
  }
}

function taskDotState(task: TeamTask): StateDotState {
  if (task.review?.validity === 'stale' || task.review?.replacedByTaskId !== undefined
    || task.review?.attempts.at(-1)?.status === 'submitted') return 'warning'
  switch (task.status) {
    case 'pending': return task.ready ? 'idle' : 'warning'
    case 'in_progress': return 'ongoing'
    case 'completed': return 'done'
    /* v8 ignore next -- Team views omit deleted task tombstones. */
    case 'deleted': return 'idle'
  }
}

function taskMember(view: TeamView, task: TeamTask): TeamRosterMember | undefined {
  return view.members.find(member => member.role === 'teammate' && member.name === task.ownerName
    && member.status !== 'failed' && member.status !== 'provisioning'
    && member.status !== 'retiring' && member.status !== 'retired')
}

/** Render the Team roster and read-only task board. */
export function TeamAction({
  sessionId, useProjection, load, loadMessages, openTeammate, t, renderSlot,
}: TeamActionProps) {
  const teamProjection = useProjection('agentTeamActivity')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<TeamView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [taskView, setTaskView] = useState<'list' | 'graph' | 'messages'>('list')
  const [messagePage, setMessagePage] = useState<TeamMessagePage | null>(null)
  const [messageLoading, setMessageLoading] = useState(false)
  const [messageError, setMessageError] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<TeamTask['id'] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({
    open, anchorRef: triggerRef, panelRef, gap: 5, margin: 16,
  })
  const positioned = position !== null
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  const sessionRef = useRef(sessionId)
  const refreshGeneration = useRef(0)
  const messageGeneration = useRef(0)
  const observedProjection = useRef({ sessionId, value: teamProjection })
  const markdownLabels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])
  sessionRef.current = sessionId

  useEffect(() => {
    refreshGeneration.current += 1
    messageGeneration.current += 1
    setOpen(false)
    setLoading(false)
    setView(null)
    setError(null)
    setTaskView('list')
    setMessagePage(null)
    setMessageLoading(false)
    setMessageError(null)
    setSelectedTaskId(null)
  }, [sessionId])

  useLayoutEffect(() => {
    if (open && positioned) panelRef.current?.focus()
  }, [open, positioned])

  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const refreshMessages = useCallback(async (before?: TeamMessageId): Promise<void> => {
    const requestedSession = sessionId
    const generation = ++messageGeneration.current
    setMessageLoading(true)
    const result = await loadMessages(requestedSession, before)
    if (sessionRef.current !== requestedSession || messageGeneration.current !== generation) return
    setMessageLoading(false)
    if (!result.ok) {
      setMessageError(failureText(result.error))
      return
    }
    setMessageError(null)
    if (before === undefined) {
      setMessagePage(result.value)
    } else {
      setMessagePage((previous) => {
        if (previous === null) return result.value
        const known = new Set(previous.messages.map(message => message.id))
        return {
          messages: [...previous.messages, ...result.value.messages.filter(message => !known.has(message.id))],
          total: result.value.total,
          ...result.value.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor },
        }
      })
    }
  }, [loadMessages, sessionId])

  const refresh = useCallback(async (showLoading = true): Promise<void> => {
    const requestedSession = sessionId
    const generation = ++refreshGeneration.current
    if (showLoading) setLoading(true)
    const result = await load(requestedSession)
    if (sessionRef.current !== requestedSession || refreshGeneration.current !== generation) return
    setLoading(false)
    if (result.ok) {
      setView(result.value)
      setError(null)
      if (taskView === 'messages') void refreshMessages()
    } else {
      setError(failureText(result.error))
    }
  }, [load, refreshMessages, sessionId, taskView])

  useEffect(() => {
    const previous = observedProjection.current
    observedProjection.current = { sessionId, value: teamProjection }
    if (open && previous.sessionId === sessionId && previous.value !== teamProjection) void refresh(false)
  }, [open, refresh, sessionId, teamProjection])

  const teammates = view?.members.filter(member => member.role === 'teammate') ?? []
  const canMonitor = view?.members[0]?.id === sessionId
  const selectedTask = view?.tasks.find(task => task.id === selectedTaskId)
  const selectedMember = view !== null && selectedTask !== undefined ? taskMember(view, selectedTask) : undefined
  const openMember = (member: TeamRosterMember): void => {
    try {
      openTeammate(sessionId, member)
    } catch (reason) {
      setError(String(reason))
    }
  }
  const openTaskMember = (task: TeamTask): void => {
    if (view === null) return
    const member = taskMember(view, task)
    if (member !== undefined) openMember(member)
  }

  return (
    <div ref={rootRef} className={css.root} data-team-action onKeyDown={(event) => {
      if (event.key !== 'Escape' || !open) return
      event.preventDefault()
      close()
    }} onBlur={(event) => {
      const target = event.relatedTarget
      if (target instanceof Node && !event.currentTarget.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false)
      }
    }}>
      <button
        type="button"
        ref={triggerRef}
        className={css.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) void refresh()
        }}
      >
        <IconUserOutlineRegular size={14} />
        <span>{t('trigger')}</span>
        {teammates.length > 0 && <span className={css.count}>{teammates.length}</span>}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          role="dialog"
          tabIndex={-1}
          aria-label={t('trigger')}
          data-team-panel
        >
          <div className={css.toolbar}>
            <strong>{t('trigger')}</strong>
            <span className={css.spacer} />
            {loading && view !== null && (
              <span role="status" aria-label={t('loading')}><StateDot state="ongoing" /></span>
            )}
            <button type="button" className={css.iconButton} aria-label={t('refresh')} onClick={() => { void refresh() }}>
              <IconRefreshOutlineRegular size={14} />
            </button>
            <button type="button" className={css.iconButton} aria-label={t('close')} onClick={close}>
              <IconCloseOutlineRegular size={14} />
            </button>
          </div>
          {error !== null && (
            <div className={css.error} role="alert"><StateDot state="error" />{error}</div>
          )}
          {loading && view === null && (
            <div className={css.notice} role="status"><StateDot state="ongoing" />{t('loading')}</div>
          )}
          {view !== null && (
            <div className={css.content}>
              <section className={css.membersPane}>
                <h3>{t('roster')}</h3>
                <div className={css.roster}>
                  {view.members.map(member => (
                    <button
                      key={member.id}
                      type="button"
                      className={css.member}
                      disabled={member.role === 'lead' || member.status === 'failed' || member.status === 'provisioning'
                        || member.status === 'retiring' || member.status === 'retired'}
                      title={member.role === 'teammate' && member.status !== 'retiring' && member.status !== 'retired'
                        ? t('open') : undefined}
                      onClick={() => { openMember(member) }}
                    >
                      <StateDot state={memberDotState(member.status)} />
                      <span className={css.memberText}>
                        <span>{member.name}</span>
                        <small>{t(memberStatusKey(member.status))}{member.model === undefined ? '' : ` · ${t('model')}: ${member.model}`}</small>
                        {member.diagnostics.map(diagnostic => <small key={diagnostic} className={css.diagnostic}>{diagnostic}</small>)}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
              <section className={css.tasksPane}>
                <div className={css.taskSectionHead}>
                  <h3>{t(taskView === 'messages' ? 'messages' : 'tasks')}</h3>
                  <div className={css.taskViewActions}>
                    {taskView !== 'list' && <button type="button" className={css.viewButton} onClick={() => { setTaskView('list') }}>{t('taskList')}</button>}
                    {canMonitor && taskView !== 'messages' && <button type="button" className={css.viewButton}
                      onClick={() => { setTaskView('messages'); setMessagePage(null); void refreshMessages() }}>
                      {t('messages')}
                    </button>}
                    {renderSlot('agent-team.panel.tasks.action', { view, active: taskView === 'graph', openGraph: () => { setTaskView('graph') } })}
                  </div>
                </div>
                <div className={`${css.taskContent} ${taskView === 'list' && selectedTask !== undefined ? css.withDetail : ''}`}>
                  {taskView === 'graph'
                    ? <div className={css.graphExtension}>{renderSlot('agent-team.panel.tasks.graph', {
                      view, openMemberSession: openTaskMember,
                    })}</div>
                    : taskView === 'messages'
                      ? <section className={css.messageList} aria-label={t('messages')}>
                        {messageLoading && messagePage === null && <div role="status">{t('loadingMessages')}</div>}
                        {messageError !== null && <div role="alert" className={css.error}>{messageError}</div>}
                        {messagePage?.messages.length === 0 && <div className={css.notice}>{t('noMessages')}</div>}
                        {messagePage?.messages.map(message => (
                          <article key={message.id} className={css.messageCard}>
                            <div className={css.messageHead}>
                              <strong>{message.senderName} → {message.targetName}</strong>
                              {message.taskId !== undefined && <span>{message.taskId}</span>}
                              <span>{t(message.status === 'delivered' ? 'message.delivered' : 'message.queued')}</span>
                              <time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleString()}</time>
                            </div>
                            <div className={css.messageBody}>
                              {message.text !== '' && <MarkdownText text={message.text} labels={markdownLabels} variant="compact" />}
                              {message.hasNonText && <pre className={css.messageRaw}>{message.contentJson}</pre>}
                            </div>
                          </article>
                        ))}
                        {messagePage?.nextCursor !== undefined && <button type="button" className={css.viewButton}
                          disabled={messageLoading} onClick={() => { void refreshMessages(messagePage.nextCursor) }}>
                          {t('loadOlderMessages')}
                        </button>}
                      </section>
                      : <>
                        {view.tasks.length === 0 && <div className={css.notice}>{t('empty')}</div>}
                        <div className={css.tasks}>
                          {view.tasks.map(task => (
                            <button key={task.id} type="button" className={css.task}
                              aria-pressed={selectedTaskId === task.id}
                              onClick={() => { setSelectedTaskId(current => current === task.id ? null : task.id) }}>
                              <span className={css.taskTitle}>
                                <strong>{task.subject}</strong>
                                <span className={css.taskState}>
                                  <StateDot state={taskDotState(task)} />
                                  <span>{t(taskDisplayStatus(task))}</span>
                                </span>
                              </span>
                              <span className={css.meta}>
                                <span>{task.id}</span>
                                <span>{t('owner')}: {task.ownerName ?? t('unowned')}</span>
                                {task.status === 'pending' && <span>{task.ready ? t('ready') : t('blocked')}</span>}
                                {task.blockedBy.length > 0 && <span>{t('blockedBy')}: {task.blockedBy.length}</span>}
                              </span>
                            </button>
                          ))}
                        </div>
                        {selectedTask !== undefined && <section className={css.taskDetail} aria-label={t('taskDetails')}>
                          <div className={css.taskDetailHead}>
                            <strong>{selectedTask.id} · {selectedTask.subject}</strong>
                            <div className={css.taskDetailActions}>
                              {selectedMember !== undefined && <button type="button" className={css.memberLink}
                                onClick={() => { openMember(selectedMember) }}>{t('openMemberSession')}</button>}
                              <button type="button" className={css.iconButton} aria-label={t('closeDetails')}
                                onClick={() => { setSelectedTaskId(null) }}><IconCloseOutlineRegular size={14} /></button>
                            </div>
                          </div>
                          <div className={css.meta}>
                            <span>{t(taskDisplayStatus(selectedTask))}</span>
                            <span>{t('owner')}: {selectedTask.ownerName ?? t('unowned')}</span>
                            {selectedTask.blockedBy.length > 0 && <span>{t('blockedBy')}: {selectedTask.blockedBy.join(', ')}</span>}
                            {selectedTask.writeScopes.length > 0 && <span>{t('writeScopes')}: {selectedTask.writeScopes.join(', ')}</span>}
                          </div>
                          <h4>{t('taskRecord')}</h4>
                          <div className={css.taskRecord}>
                            <MarkdownText text={selectedTask.description} labels={markdownLabels} variant="compact" />
                          </div>
                          {selectedTask.review?.replacedByTaskId !== undefined &&
                            <small className={css.warning}>{t('review.replaced')}: {selectedTask.review.replacedByTaskId}</small>}
                          {selectedTask.review?.origin !== undefined &&
                            <small className={css.warning}>{t('taskAttempt')}: {selectedTask.review.origin.taskId} · {selectedTask.review.origin.reason}</small>}
                          {selectedTask.review?.attempts.map(attempt => (
                            <div key={attempt.id} className={css.taskAttempt}>
                              <h4>{t('taskAttempt')} · {attempt.id} · {attempt.ownerName ?? t('unowned')} · {t(`attempt.${attempt.status}`)}</h4>
                              {attempt.result !== undefined && <>
                                <h4>{t('taskResult')}</h4>
                                <div className={css.taskRecord}>
                                  <MarkdownText text={attempt.result.summary} labels={markdownLabels} variant="compact" />
                                </div>
                                {attempt.result.artifacts.length > 0 && <>
                                  <h4>{t('taskArtifacts')}</h4>
                                  <ul className={css.taskArtifacts}>{attempt.result.artifacts.map(artifact =>
                                    <li key={artifact}>{artifact}</li>)}</ul>
                                </>}
                              </>}
                              {attempt.reason !== undefined && <small className={css.warning}>{attempt.reason}</small>}
                            </div>
                          ))}
                          {selectedTask.writeScopeWarnings.map(warning =>
                            <small key={warning} className={css.warning}>{warning}</small>)}
                        </section>}
                      </>}
                </div>
              </section>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
