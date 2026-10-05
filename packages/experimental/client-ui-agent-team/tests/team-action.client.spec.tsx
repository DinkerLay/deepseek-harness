// @vitest-environment jsdom

import { Profiler, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamMemberProjection, TeamProjection, TeamTaskId, TeamTaskView as TeamTask,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionListState, SessionSnapshot, SessionSummary, UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { TeamAction, type TeamActionInjected, type TeamActionProps } from '../src/client/TeamAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const SESSION = 'lead' as SessionId
const WORKER = 'worker-id' as SessionId
const TASK_1 = 'task-1' as TeamTaskId
const TASK_2 = 'task-2' as TeamTaskId
const task: TeamTask = {
  id: TASK_1,
  revision: 1,
  subject: 'Implement runtime',
  description: 'Build the Team runtime',
  status: 'in_progress',
  ownerName: 'lead',
  blockedBy: [],
  writeScopes: ['src'],
  ready: false,
  writeScopeWarnings: ['write scopes overlap with task-2'],
}
const lead: TeamMemberProjection = { id: SESSION, name: 'lead', role: 'lead', phase: 'active' }
const worker: TeamMemberProjection = {
  id: WORKER, name: 'worker', role: 'teammate', phase: 'active',
}
const team: TeamProjection = { members: [lead, worker], tasks: [task] }

function MemberModalAction() {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(false)
  return <>
    <button type="button" onClick={() => { setOpen(true) }}>Member fixture</button>
    <Modal open={open} onClose={() => { setOpen(false) }} title="Member fixture dialog" closeLabel="Close member fixture">
      <button type="button" onClick={() => { setSelected(true) }}>{selected ? 'Replacement selected' : 'Replace member fixture'}</button>
    </Modal>
  </>
}

function memberMeta(value: unknown): value is { member: { name: string }; presetId?: string } {
  return typeof value === 'object' && value !== null && 'member' in value
    && typeof value.member === 'object' && value.member !== null
    && 'name' in value.member && typeof value.member.name === 'string'
    && (!('presetId' in value) || value.presetId === undefined || typeof value.presetId === 'string')
}

function taskAction(value: unknown): value is { task: { id: string }; closePanel: () => void } {
  return typeof value === 'object' && value !== null && 'task' in value
    && typeof value.task === 'object' && value.task !== null
    && 'id' in value.task && typeof value.task.id === 'string'
    && 'closePanel' in value && typeof value.closePanel === 'function'
}

type Projections = SessionListState['projectionsBySession']

function summary(id: SessionId, running: boolean): SessionSummary {
  return { id, displayTitle: id, running, retainedBy: {}, blank: false, updatedAt: 0 }
}

function bench(options: {
  projections?: Projections
  sessionId?: SessionId
  parentSessionId?: SessionId
  openState?: SessionSnapshot['openState']
  statuses?: SessionStatusSnapshot
  running?: Record<SessionId, boolean>
  renderSlot?: TeamActionProps['renderSlot']
} = {}) {
  const sessionId = options.sessionId ?? SESSION
  const byId: Record<SessionId, SessionSummary> = {}
  for (const [id, running] of Object.entries(options.running ?? {}) as [SessionId, boolean][]) byId[id] = summary(id, running)
  const sessions = createSnapshotStore<SessionListState>({
    ids: Object.keys(byId) as SessionId[], byId, phase: 'ready',
    projectionsBySession: options.projections ?? { [SESSION]: { state: 'ready', error: null, values: { agentTeam: team } } },
  })
  const statuses = createSnapshotStore<SessionStatusSnapshot>(options.statuses ?? new Map())
  const session = createSnapshotStore<SessionSnapshot>({
    sessionId,
    pendingSubmissions: [],
    running: false,
    subagent: options.parentSessionId === undefined
      ? null
      : { address: { parentSessionId: options.parentSessionId, childSessionId: sessionId, mode: 'continuable' } },
    removed: false,
    openState: options.openState ?? 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
  })
  const useSessions = bindSnapshotSelector(sessions)
  const injected: TeamActionInjected = { openTeammate: vi.fn() }
  const props: TeamActionProps = {
    sessionId,
    useSession: bindSnapshotSelector(session),
    useProjection: ((key: string, select?: (value: unknown) => unknown) => {
      const value = useSessions(state => state.projectionsBySession[sessionId]?.values[
        key as keyof SessionListState['projectionsBySession'][SessionId]['values']
      ])
      return select === undefined ? value : select(value)
    }) as UseProjection,
    useSessions,
    useSessionStatus: bindSnapshotSelector(statuses),
    renderSlot: ((key, owner, opts) => {
      const rendered = options.renderSlot?.(key, owner, opts) ?? null
      // The real slot renderer wraps the owner-provided fallback in a Fragment.
      return key === 'agent-team.panel.tasks.content' && rendered === null
        ? <>{opts?.fallback ?? null}</> : rendered
    }) as TeamActionProps['renderSlot'],
    ...injected,
    t: makeTranslate(zh, commonZh),
  } as TeamActionProps
  return { props, injected, sessions, statuses, session }
}

function openPanel(): void {
  fireEvent.click(screen.getByRole('button', { name: /智能体团队/u }))
}

function hasGraphAction(value: object): value is { openGraph: () => void } {
  return 'openGraph' in value && typeof value.openGraph === 'function'
}

function hasClosePanel(value: object): value is { closePanel: () => void } {
  return 'closePanel' in value && typeof value.closePanel === 'function'
}

function setProjectionSnapshot(
  sessions: ReturnType<typeof bench>['sessions'],
  sessionId: SessionId,
  snapshot: Projections[SessionId],
): void {
  act(() => {
    const current = sessions.getSnapshot()
    sessions.set({ ...current, projectionsBySession: { ...current.projectionsBySession, [sessionId]: snapshot } })
  })
}

function setProjection(sessions: ReturnType<typeof bench>['sessions'], sessionId: SessionId, value: TeamProjection): void {
  setProjectionSnapshot(sessions, sessionId, { state: 'ready', error: null, values: { agentTeam: value } })
}

describe('TeamAction', () => {
  it('preserves hover ownership while a Modal is foreground, including an already scheduled dismissal', async () => {
    vi.useFakeTimers()
    const b = bench({ renderSlot: (key, owner) => key === 'agent-team.panel.member.action'
      && memberMeta(owner) && owner.member.name === worker.name ? <MemberModalAction /> : null })
    render(<TeamAction {...b.props} />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: zh.trigger }))
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    const panel = screen.getByRole('dialog', { name: zh.trigger })
    fireEvent.mouseLeave(panel)
    fireEvent.click(screen.getByRole('button', { name: 'Member fixture' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    expect(screen.getByRole('dialog', { name: zh.trigger })).toBe(panel)
    fireEvent.mouseLeave(panel)
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    expect(screen.getByRole('dialog', { name: zh.trigger })).toBe(panel)
    fireEvent.click(screen.getByRole('button', { name: 'Close member fixture' }))
    fireEvent.mouseLeave(panel)
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    expect(screen.queryByRole('dialog', { name: zh.trigger })).toBeNull()
  })

  it('yields pointer dismissal and Escape to a foreground portaled Modal without unmounting its owner', () => {
    const b = bench({ renderSlot: (key, owner) => key === 'agent-team.panel.member.action'
      && memberMeta(owner) && owner.member.name === worker.name ? <MemberModalAction /> : null })
    render(<TeamAction {...b.props} />)
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Member fixture' }))
    const replacement = screen.getByRole('button', { name: 'Replace member fixture' })
    fireEvent.pointerDown(replacement)
    fireEvent.click(replacement)
    expect(screen.getByRole('dialog', { name: zh.trigger })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Replacement selected' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Replacement selected' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Member fixture dialog' })).toBeNull()
    expect(screen.getByRole('dialog', { name: zh.trigger })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog', { name: zh.trigger }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: zh.trigger })).toBeNull()
    openPanel()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: zh.trigger })).toBeNull()
  })

  it('uses the current member execution for status and navigation without changing its roster id', () => {
    const execution = 'worker-generation-2' as SessionId
    const renewed = { ...worker, execution: { memberId: WORKER, executionId: execution, generation: 2 } }
    const b = bench({ projections: {
      [SESSION]: { state: 'ready', error: null, values: { agentTeam: { ...team, members: [lead, renewed] } } },
      [WORKER]: { state: 'ready', error: null, values: { modelSelection: { lastUsed: null,
        next: { provider: 'p', model: 'old-model' } } } },
      [execution]: { state: 'ready', error: null, values: { modelSelection: { lastUsed: null,
        next: { provider: 'p', model: 'current-model' } } } },
    }, running: { [execution]: true } })
    render(<TeamAction {...b.props} />)
    openPanel()
    const row = screen.getByRole('button', { name: /^worker/u })
    expect(row.textContent).toContain('current-model')
    expect(row.textContent).not.toContain('old-model')
    expect(row.textContent).toContain(zh['memberStatus.running'])
    fireEvent.click(row)
    expect(b.injected.openTeammate).toHaveBeenCalledWith(SESSION, execution)
  })

  it('renders member operations outside disabled navigation buttons', () => {
    const b = bench({ renderSlot: (key, owner) => key === 'agent-team.panel.member.action'
      && memberMeta(owner) && 'role' in owner.member && owner.member.role === 'teammate'
      ? <button type="button">Member operations</button> : null })
    setProjection(b.sessions, SESSION, { ...team, members: [lead, { ...worker, executionStarted: false }] })
    render(<TeamAction {...b.props} />)
    openPanel()
    const operation = screen.getByRole('button', { name: 'Member operations' })
    expect(operation.parentElement?.closest('button')).toBeNull()
    expect(operation).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: /^worker/u })).toHaveProperty('disabled', true)
  })

  it('shows a held replacement as changing rather than ready and prevents candidate navigation', () => {
    const b = bench({ projections: { [SESSION]: { state: 'ready', error: null, values: { agentTeam: {
      ...team, members: [lead, { ...worker, executionHeld: true, executionStarted: false,
        execution: { memberId: WORKER, executionId: 'candidate-ui' as SessionId, generation: 2 } }],
    } } } } })
    render(<TeamAction {...b.props} />)
    openPanel()
    const row = screen.getByRole('button', { name: /^worker/u })
    expect(row.textContent).toContain(zh['memberStatus.changing'])
    expect(row.textContent).toContain(`${zh.generation} 2`)
    expect(row.textContent).not.toContain(zh['memberStatus.unstarted'])
    expect(row).toHaveProperty('disabled', true)
    fireEvent.click(row)
    expect(b.injected.openTeammate).not.toHaveBeenCalled()
  })

  it.each(['agent-team.panel.header.actions', 'agent-team.panel.tasks.content', 'agent-team.panel.tasks.graph'] as const)(
    'keeps the native close callback owned by %s', (target) => {
      const slot: TeamActionProps['renderSlot'] = (key, owner) => {
        if (target === 'agent-team.panel.tasks.graph' && key === 'agent-team.panel.tasks.action' && hasGraphAction(owner)) {
          return <button onClick={owner.openGraph}>Open graph</button>
        }
        return key === target && hasClosePanel(owner) ? <button onClick={owner.closePanel}>Close from slot</button> : null
      }
      const b = bench({ renderSlot: slot })
      b.props.sessionAddressId = SESSION
      render(<TeamAction {...b.props} />)
      openPanel()
      if (target === 'agent-team.panel.tasks.graph') fireEvent.click(screen.getByRole('button', { name: 'Open graph' }))
      fireEvent.click(screen.getByRole('button', { name: 'Close from slot' }))
      expect(screen.queryByRole('dialog')).toBeNull()
    },
  )

  it('preserves retiring and retired member lifecycle while rendering mixed grouped and ungrouped rows', () => {
    const b = bench()
    setProjection(b.sessions, SESSION, { tasks: [], members: [lead,
      { ...worker, name: 'leaving', phase: 'retiring' },
      { ...worker, id: 'retired-worker' as SessionId, name: 'left', phase: 'retired', group: 'finished' },
    ] })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('button', { name: /^leaving/u }).textContent).toContain(zh['memberStatus.retiring'])
    expect(screen.getByRole('button', { name: /^left/u }).textContent).toContain(zh['memberStatus.retired'])
    expect(screen.getByRole('button', { name: /^leaving/u })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: /^left/u }).querySelector('[data-state="idle"]')).not.toBeNull()
    expect(screen.getByText(zh['group.ungrouped'])).toBeTruthy()
    expect(screen.getByText('finished')).toBeTruthy()
  })

  it('displays the native current Lead execution without using the stable host preset or runtime status', () => {
    const execution = 'actual-lead-execution' as SessionId
    const b = bench({ sessionId: execution, running: { [SESSION]: false, [execution]: true },
      statuses: new Map([[execution, { running: true, pendingInteraction: undefined, completionUnread: false }]]),
      projections: {
        [SESSION]: { state: 'ready', error: null, values: { agentTeam: { ...team,
          lead: { executionId: execution, term: 4, presetId: 'analyst', revision: 'analyst-revision' },
          members: [{ ...lead, preset: { id: 'analyst', revision: 'analyst-revision' } }, worker] },
        modelSelection: { lastUsed: null, next: { provider: 'p', model: 'dormant-host-model' } } } },
        [execution]: { state: 'ready', error: null,
          values: { modelSelection: { lastUsed: null, next: { provider: 'p', model: 'actual-lead-model' } } } },
      } })
    b.props.sessionAddressId = SESSION
    const initial = b.sessions.getSnapshot()
    b.sessions.set({ ...initial, byId: { ...initial.byId,
      [SESSION]: { ...initial.byId[SESSION]!, projectionValues: { agentPreset: 'standard' } },
      [execution]: { ...initial.byId[execution]!, projectionValues: { agentPreset: 'analyst' } },
    } })
    render(<TeamAction {...b.props} />)
    openPanel()
    const row = screen.getByRole<HTMLButtonElement>('button', { name: /^lead/u })
    expect(row.textContent).toContain('analyst')
    expect(row.textContent).toContain('actual-lead-model')
    expect(row.textContent).toContain(zh['memberStatus.running'])
    expect(row.textContent).toContain(zh.current)
    expect(row.textContent).not.toContain('standard')
    expect(row.textContent).not.toContain('dormant-host-model')
    expect(row.disabled).toBe(true)
    expect(b.injected.openTeammate).not.toHaveBeenCalled()
  })

  it('updates Lead seat display while keeping its roster identity and navigation on the stable Team address', () => {
    const first = 'first-native-lead' as SessionId
    const next = 'next-native-lead' as SessionId
    const slot: TeamActionProps['renderSlot'] = (key, owner) => key === 'agent-team.panel.member.meta' && memberMeta(owner)
      ? <small>{owner.member.name}:{owner.presetId ?? 'none'}</small> : null
    const b = bench({ sessionId: WORKER, parentSessionId: SESSION, renderSlot: slot,
      running: { [SESSION]: true, [first]: false, [next]: true },
      projections: {
        [SESSION]: { state: 'ready', error: null, values: { agentTeam: { ...team,
          lead: { executionId: first, term: 2, presetId: 'analyst', revision: 'a' } },
        modelSelection: { lastUsed: null, next: { provider: 'p', model: 'host-model' } } } },
        [first]: { state: 'ready', error: null, values: { modelSelection: { lastUsed: null, next: { provider: 'p', model: 'first-model' } } } },
        [next]: { state: 'ready', error: null, values: { modelSelection: { lastUsed: null, next: { provider: 'p', model: 'next-model' } } } },
      } })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText('lead:analyst')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^lead/u }).textContent).toContain(zh['memberStatus.inactive'])
    expect(screen.getByRole('button', { name: /^lead/u }).textContent).toContain('first-model')
    fireEvent.click(screen.getByRole('button', { name: /^lead/u }))
    expect(b.injected.openTeammate).toHaveBeenCalledWith(WORKER, SESSION)
    setProjection(b.sessions, SESSION, { ...team,
      lead: { executionId: next, term: 3, presetId: 'reviewer', revision: 'b' } })
    const row = screen.getByRole('button', { name: /^lead/u })
    expect(row.textContent).toContain('lead:reviewer')
    expect(row.textContent).toContain('next-model')
    expect(row.textContent).toContain(zh['memberStatus.running'])
    expect(row.textContent).not.toContain('first-model')
    expect(row.textContent).not.toContain('host-model')
    fireEvent.click(row)
    expect(b.injected.openTeammate).toHaveBeenLastCalledWith(WORKER, SESSION)
  })

  it('uses the committed Lead preset without guessing a model from the host when its execution row is cold', () => {
    const execution = 'cold-native-lead' as SessionId
    const b = bench({ projections: {
      [SESSION]: { state: 'ready', error: null, values: { agentTeam: { ...team,
        lead: { executionId: execution, term: 2, presetId: 'analyst', revision: 'a' } },
      modelSelection: { lastUsed: null, next: { provider: 'p', model: 'host-model' } } } },
    } })
    render(<TeamAction {...b.props} />)
    openPanel()
    const row = screen.getByRole('button', { name: /^lead/u })
    expect(row.textContent).toContain('analyst')
    expect(row.textContent).not.toContain('host-model')
    expect(row.textContent).not.toContain(zh['model'])
  })

  it('shows the current Lead preset and closes the Team panel explicitly', () => {
    const b = bench({ running: { [SESSION]: false } })
    const snapshot = b.sessions.getSnapshot()
    b.sessions.set({
      ...snapshot,
      byId: {
        ...snapshot.byId,
        [SESSION]: { ...snapshot.byId[SESSION]!, projectionValues: { agentPreset: 'standard' } },
      },
    })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('button', { name: /lead/u })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps lead literal and mounts a direct Task action without opening task details', () => {
    const slot: TeamActionProps['renderSlot'] = (key, owner) => {
      if (key === 'agent-team.panel.member.meta' && memberMeta(owner)) {
        return <small>{owner.member.name} · {owner.presetId ?? 'none'}</small>
      }
      if (key === 'agent-team.panel.task.action' && taskAction(owner)) {
        return <button type="button" onClick={owner.closePanel}>Jump {owner.task.id}</button>
      }
      return null
    }
    const b = bench({ renderSlot: slot, running: { [SESSION]: false } })
    const state = b.sessions.getSnapshot()
    b.sessions.set({ ...state, byId: { ...state.byId,
      [SESSION]: { ...state.byId[SESSION]!, projectionValues: { agentPreset: 'standard' } },
    } })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText('lead · standard')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Jump task-1' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('mounts an external Task graph without replacing the native Board', () => {
    const slot: TeamActionProps['renderSlot'] = (key, owner) => {
      if (key === 'agent-team.panel.tasks.action' && hasGraphAction(owner)) {
        const openGraph = owner.openGraph
        return <button type="button" onClick={() => { openGraph() }}>Graph plugin</button>
      }
      if (key === 'agent-team.panel.tasks.graph') return <p>External graph view</p>
      return null
    }
    const b = bench({ renderSlot: slot })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText('Implement runtime')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Graph plugin' }))
    expect(screen.getByText('External graph view')).toBeTruthy()
    expect(screen.queryByText('Implement runtime')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Graph plugin' }))
    expect(screen.getByText('Implement runtime')).toBeTruthy()
  })

  it('uses an optional Task content slot while retaining the official Board fallback', () => {
    const b = bench({ renderSlot: key => key === 'agent-team.panel.tasks.content'
      ? <p>Product Task workspace</p> : null })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText('Product Task workspace')).toBeTruthy()
    expect(document.querySelector('[data-team-action]')?.hasAttribute('data-team-projection-ready')).toBe(true)
    expect(screen.queryByText('Implement runtime')).toBeNull()
    const current = b.sessions.getSnapshot()
    setProjection(b.sessions, SESSION, { members: [lead], tasks: [] })
    expect(screen.getByText('Product Task workspace')).toBeTruthy()
    expect(document.querySelector('[data-team-action]')?.hasAttribute('data-team-projection-ready')).toBe(false)
    expect(current.projectionsBySession[SESSION]?.values.agentTeam?.tasks).toHaveLength(1)
  })

  it('mounts optional product controls in the native panel header without changing the roster', () => {
    const b = bench({ renderSlot: key => key === 'agent-team.panel.header.actions'
      ? <button type="button">Profile controls</button> : null })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('button', { name: 'Profile controls' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /worker/u })).toBeTruthy()
    expect(screen.getByText('Implement runtime')).toBeTruthy()
  })

  it('renders the native empty Task notice when an unoccupied slot returns a fallback wrapper', () => {
    const b = bench({ renderSlot: (key, _owner, opts) => key === 'agent-team.panel.tasks.content'
      ? <>{opts?.fallback ?? null}</> : null })
    setProjection(b.sessions, SESSION, { members: [lead], tasks: [] })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText(zh.empty)).toBeTruthy()
    expect(document.querySelector('[data-team-panel-body]')).not.toBeNull()
  })

  it('groups members only when a durable group label exists and keeps member navigation', () => {
    const b = bench()
    setProjection(b.sessions, SESSION, { members: [lead, { ...worker, group: 'collection' }], tasks: [] })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText('collection')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /worker/u }))
    expect(b.injected.openTeammate).toHaveBeenCalledWith(SESSION, WORKER)
  })

  it('keeps an unstarted member visible without opening a nonexistent execution Session', () => {
    const b = bench()
    setProjection(b.sessions, SESSION, { members: [lead, { ...worker, executionStarted: false }], tasks: [] })
    render(<TeamAction {...b.props} />)
    openPanel()
    const row = screen.getByRole('button', { name: /worker.*未启动/u })
    expect(row).toHaveProperty('disabled', true)
    fireEvent.click(row)
    expect(b.injected.openTeammate).not.toHaveBeenCalled()
    setProjection(b.sessions, SESSION, { members: [lead, { ...worker, executionStarted: true }], tasks: [] })
    fireEvent.click(screen.getByRole('button', { name: /worker.*未运行/u }))
    expect(b.injected.openTeammate).toHaveBeenCalledWith(SESSION, WORKER)
  })

  it('renders the Lead projection and applies later projection frames without any user action', async () => {
    const b = bench()
    render(<TeamAction {...b.props} />)
    expect(screen.getByRole('button', { name: /智能体团队/u }).textContent).toBe(zh.trigger)
    openPanel()
    expect(await screen.findByText('Implement runtime')).toBeTruthy()
    expect(screen.getByText('write scopes overlap with task-2')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /刷新|Refresh/u })).toBeNull()

    setProjection(b.sessions, SESSION, {
      members: [lead, worker, { id: 'worker-b' as SessionId, name: 'worker-b', role: 'teammate', phase: 'provisioning' }],
      tasks: [task, { ...task, id: TASK_2, subject: 'Pushed task', status: 'pending', ready: true, writeScopeWarnings: [] }],
    })
    expect(screen.getByText('Pushed task')).toBeTruthy()
    expect(screen.getByRole('button', { name: /worker-b/u })).toHaveProperty('disabled', true)
    expect(screen.getByRole('heading', { name: '成员3' })).toBeTruthy()
  })

  it('overlays live Session status and the durable model selection on roster rows', () => {
    const statuses: SessionStatusSnapshot = new Map([[WORKER, { running: true, pendingInteraction: undefined, completionUnread: false }]])
    const b = bench({
      statuses,
      running: { [SESSION]: true },
      projections: {
        [SESSION]: {
          state: 'ready', error: null,
          values: { agentTeam: team, modelSelection: { lastUsed: null, next: { provider: 'p', model: 'lead-model' } } },
        },
        [WORKER]: {
          state: 'ready', error: null,
          values: { modelSelection: { lastUsed: { provider: 'p', model: 'worker-model' }, next: { provider: 'p', model: 'worker-model' } } },
        },
      },
    })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('button', { name: new RegExp(`lead.*${zh['memberStatus.running']}.*lead-model`, 'u') })).toBeTruthy()
    const row = screen.getByRole('button', { name: new RegExp(`worker.*${zh['memberStatus.running']}.*worker-model`, 'u') })
    expect(row.querySelector('[data-state="ongoing"]')).not.toBeNull()

    act(() => { b.statuses.set(new Map([[WORKER, { running: false, pendingInteraction: undefined, completionUnread: false }]])) })
    expect(screen.getByRole('button', { name: /^worker.*未运行/u })).toBeTruthy()

    act(() => {
      b.statuses.set(new Map())
      b.sessions.update((draft) => { draft.byId[WORKER] = summary(WORKER, true) })
    })
    expect(screen.getByRole('button', { name: /^worker.*运行中/u })).toBeTruthy()
  })

  it('reads the Lead projection from an addressed teammate conversation', () => {
    const b = bench({ sessionId: WORKER, parentSessionId: SESSION })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText('Implement runtime')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^worker/u }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^lead/u }))
    expect(b.injected.openTeammate).toHaveBeenCalledWith(WORKER, SESSION)
  })

  it('reads a stable Team address from an ordinary execution view without inventing subagent identity', () => {
    const execution = 'lead-execution-2' as SessionId
    const b = bench({ sessionId: execution })
    render(<TeamAction {...b.props} sessionAddressId={SESSION} />)
    openPanel()
    expect(screen.getByText('Implement runtime')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^worker/u }))
    expect(b.injected.openTeammate).toHaveBeenCalledWith(execution, WORKER, SESSION)
    expect(b.session.getSnapshot().subagent).toBeNull()
  })

  it.each([false, true])('accepts shared baselines and late capability updates (teammate page: %s)', (addressed) => {
    const b = bench({
      ...(addressed ? { sessionId: WORKER, parentSessionId: SESSION } : {}),
      projections: {}, openState: 'loading',
    })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('status').textContent).toBe(zh.loading)
    act(() => { b.session.set({ ...b.session.getSnapshot(), openState: 'open' }) })
    expect(screen.getByRole('status').textContent).toBe(zh.unavailable)
    setProjectionSnapshot(b.sessions, SESSION, { state: 'idle', error: null, values: { agentTeam: team } })
    expect(screen.getByText('Implement runtime')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    setProjectionSnapshot(b.sessions, SESSION, { state: 'idle', error: null, values: {} })
    expect(screen.getByRole('status').textContent).toBe(zh.unavailable)
    setProjection(b.sessions, SESSION, { members: [lead], tasks: [] })
    expect(screen.getByText(zh.empty)).toBeTruthy()
  })

  it('waits for the shared Session list and accepts cached projections without an explicit read', () => {
    const b = bench({ projections: {} })
    b.sessions.update((draft) => { draft.phase = 'pending' })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('status').textContent).toBe(zh.loading)
    act(() => { b.sessions.set({
      ...b.sessions.getSnapshot(), phase: 'ready',
      projectionsBySession: { [SESSION]: { state: 'idle', error: null, values: { agentTeam: team } } },
    }) })
    expect(screen.getByText('Implement runtime')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each([false, true])('ignores unrelated Session updates (teammate page: %s)', (addressed) => {
    const b = bench(addressed ? { sessionId: WORKER, parentSessionId: SESSION } : {})
    const onRender = vi.fn()
    render(<Profiler id="team" onRender={onRender}><TeamAction {...b.props} /></Profiler>)
    openPanel()
    onRender.mockClear()

    act(() => {
      const current = b.sessions.getSnapshot()
      const projectionsBySession = Object.fromEntries(Object.entries(current.projectionsBySession)
        .map(([id, snapshot]) => [id, { ...snapshot }]))
      b.sessions.set({
        ...current,
        byId: { ...current.byId, ['unrelated' as SessionId]: summary('unrelated' as SessionId, true) },
        projectionsBySession: {
          ...projectionsBySession,
          ['unrelated' as SessionId]: { state: 'ready', error: null, values: { agentTeam: { members: [], tasks: [] } } },
        },
      })
      b.statuses.set(new Map([['unrelated' as SessionId, { running: true, pendingInteraction: undefined, completionUnread: false }]]))
    })
    expect(onRender).not.toHaveBeenCalled()

    setProjectionSnapshot(b.sessions, WORKER, {
      state: 'ready', error: null,
      values: { modelSelection: { lastUsed: null, next: { provider: 'p', model: 'updated-worker-model' } } },
    })
    expect(screen.getByRole('button', { name: /worker.*updated-worker-model/u })).toBeTruthy()
    setProjection(b.sessions, SESSION, { ...team, tasks: [{ ...task, subject: 'Updated parent task' }] })
    expect(screen.getByText('Updated parent task')).toBeTruthy()
  })

  it('shows capability absence after a successful read instead of loading forever', () => {
    const b = bench({ projections: { [SESSION]: { state: 'ready', error: null, values: {} } } })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.queryByText(zh.loading)).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Team 暂不可用')
  })

  it('surfaces a Team projection failure beside the last valid state', () => {
    const b = bench({
      projections: { [SESSION]: { state: 'ready', error: null, values: { agentTeam: { ...team, failure: 'revision is not contiguous' } } } },
    })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('alert').textContent).toBe('团队持久记录无效：revision is not contiguous')
    expect(screen.getByText('Implement runtime')).toBeTruthy()
  })

  it('renders roster/task state variants and reports navigation failures', () => {
    const { ownerName: _ownerName, ...unownedTask } = task
    const b = bench({
      projections: {
        [SESSION]: {
          state: 'ready', error: null,
          values: {
            agentTeam: {
              members: [
                lead,
                worker,
                { id: 'failed-id' as SessionId, name: 'failed-worker', role: 'teammate', phase: 'failed', error: 'provider failed' },
                { id: 'provisioning-id' as SessionId, name: 'provisioning-worker', role: 'teammate', phase: 'provisioning' },
              ],
              tasks: [
                { ...unownedTask, id: 'ready-task' as TeamTaskId, status: 'pending', ready: true },
                { ...unownedTask, id: 'blocked-task' as TeamTaskId, status: 'pending', ready: false, blockedBy: [TASK_1] },
                { ...task, id: 'completed-task' as TeamTaskId, status: 'completed', ownerName: 'worker' },
              ],
            },
          },
        },
      },
    })
    b.injected.openTeammate = vi.fn(() => { throw new Error('navigation failed') })
    render(<TeamAction {...b.props} {...b.injected} />)
    openPanel()
    expect(screen.getByText('provider failed')).toBeTruthy()
    expect(screen.getByText(zh.ready)).toBeTruthy()
    expect(screen.getByText(zh.blocked)).toBeTruthy()
    expect(screen.getAllByText('Owner: 未分配')).toHaveLength(2)
    expect(screen.getByText('Owner: worker')).toBeTruthy()
    const failedMember = screen.getByRole<HTMLButtonElement>('button', { name: /failed-worker/u })
    const provisioningMember = screen.getByRole<HTMLButtonElement>('button', { name: /provisioning-worker/u })
    expect(failedMember.disabled).toBe(true)
    expect(failedMember.querySelector('[data-state="error"]')).not.toBeNull()
    expect(provisioningMember.disabled).toBe(true)
    expect(provisioningMember.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^lead/u }).disabled).toBe(true)
    const tasks = [...document.querySelectorAll('article')]
    expect(tasks.map(card => card.querySelector('[data-state]')?.getAttribute('data-state')))
      .toEqual(['idle', 'warning', 'done'])
    for (const card of tasks) expect(card.querySelector('button, input, select, textarea')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^worker/u }))
    expect(screen.getByRole('alert').textContent).toBe('Error: navigation failed')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /智能体团队/u }))
  })

  it('closes the panel and clears a navigation failure when the conversation switches sessions', () => {
    const b = bench()
    b.injected.openTeammate = vi.fn(() => { throw new Error('navigation failed') })
    const rendered = render(<TeamAction {...b.props} {...b.injected} />)
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: /^worker/u }))
    expect(screen.getByRole('alert')).toBeTruthy()

    const next = bench({ sessionId: 'next-lead' as SessionId, projections: {}, openState: 'loading' })
    rendered.rerender(<TeamAction {...next.props} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    openPanel()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(zh.loading)
  })

  it('keeps panel interactions open and dismisses on outside pointer or Escape', () => {
    const b = bench()
    const rendered = render(<TeamAction {...b.props} />)
    const trigger = screen.getByRole('button', { name: /智能体团队/u })
    fireEvent.click(trigger)
    const panel = screen.getByRole('dialog')
    expect(rendered.container.contains(panel)).toBe(false)
    expect(document.activeElement).toBe(panel)
    fireEvent.pointerDown(panel)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.pointerDown(trigger)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('button', { name: /^worker/u }), { key: 'Enter' })
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: /^worker/u }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each([true, false])('clamps a long task description behind an expand toggle (ResizeObserver: %s)', async (resizeObserver) => {
    if (!resizeObserver) vi.stubGlobal('ResizeObserver', undefined)
    const scrollHeight = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(120)
    const clientHeight = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(60)
    try {
      render(<TeamAction {...bench().props} />)
      fireEvent.click(screen.getByRole('button', { name: /智能体团队/u }))
      const expand = await screen.findByRole('button', { name: zh['task.expand'] })
      const description = screen.getByText('Build the Team runtime')
      expect(expand.getAttribute('aria-expanded')).toBe('false')
      expect(description.className).not.toBe('')

      fireEvent.click(expand)
      const collapse = screen.getByRole('button', { name: zh['task.collapse'] })
      expect(collapse.getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByText('Build the Team runtime').className).toBe('')

      fireEvent.click(collapse)
      expect(screen.getByRole('button', { name: zh['task.expand'] })).toBeTruthy()
    } finally {
      scrollHeight.mockRestore()
      clientHeight.mockRestore()
    }
  })

  it('opens on hover and preserves the trigger-to-panel crossing grace', async () => {
    vi.useFakeTimers()
    const advance = async (duration: number): Promise<void> => {
      await act(async () => { await vi.advanceTimersByTimeAsync(duration) })
    }
    const b = bench()
    const rendered = render(<TeamAction {...b.props} />)
    const trigger = screen.getByRole('button', { name: /智能体团队/u })
    const root = trigger.parentElement!

    fireEvent.mouseEnter(trigger)
    await advance(149)
    expect(screen.queryByRole('dialog')).toBeNull()
    await advance(1)
    const panel = screen.getByRole('dialog')

    fireEvent.mouseEnter(trigger)
    expect(screen.getByRole('dialog')).toBe(panel)

    fireEvent.mouseLeave(root)
    fireEvent.mouseEnter(panel)
    await advance(120)
    expect(screen.getByRole('dialog')).toBe(panel)

    fireEvent.mouseLeave(panel)
    await advance(119)
    expect(screen.getByRole('dialog')).toBe(panel)
    await advance(1)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.mouseEnter(trigger)
    fireEvent.mouseLeave(root, { relatedTarget: document.body })
    rendered.unmount()
    await advance(150)
  })

  it('pins a click-opened panel through hover-out until explicit dismissal', async () => {
    vi.useFakeTimers()
    const advance = async (duration: number): Promise<void> => {
      await act(async () => { await vi.advanceTimersByTimeAsync(duration) })
    }
    render(<TeamAction {...bench().props} />)
    const trigger = screen.getByRole('button', { name: /智能体团队/u })
    const root = trigger.parentElement!

    fireEvent.click(trigger)
    const panel = screen.getByRole('dialog')
    fireEvent.mouseEnter(trigger)
    fireEvent.mouseLeave(root)
    await advance(300)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.mouseEnter(panel)
    fireEvent.mouseLeave(panel)
    await advance(300)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.mouseEnter(trigger)
    await advance(150)
    const hovered = screen.getByRole('dialog')
    fireEvent.click(trigger)
    fireEvent.mouseLeave(root)
    await advance(300)
    expect(screen.getByRole('dialog')).toBe(hovered)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.mouseEnter(trigger)
    fireEvent.mouseLeave(root)
    await advance(300)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens by click only while the trigger is collapsed to its icon', async () => {
    vi.useFakeTimers()
    const advance = async (duration: number): Promise<void> => {
      await act(async () => { await vi.advanceTimersByTimeAsync(duration) })
    }
    render(<TeamAction {...bench().props} />)
    const trigger = screen.getByRole('button', { name: /智能体团队/u })
    const label = screen.getByText(zh.trigger)
    const computedStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element =>
      element === label ? { display: 'none' } as CSSStyleDeclaration : computedStyle(element))

    fireEvent.mouseEnter(trigger)
    await advance(300)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('keeps projection updates live without polling while pinned', async () => {
    vi.useFakeTimers()
    const b = bench()
    render(<TeamAction {...b.props} />)
    openPanel()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    setProjection(b.sessions, SESSION, { ...team, tasks: [{ ...task, subject: 'Pushed while pinned' }] })
    expect(screen.getByText('Pushed while pinned')).toBeTruthy()
  })

  it('keeps an accessible trigger name when its label is collapsed', () => {
    render(<TeamAction {...bench().props} />)
    screen.getByText(zh.trigger).style.display = 'none'
    expect(screen.getByRole('button', { name: zh.trigger })).toBeTruthy()
  })

  it('dismisses a hovered panel with Escape without stealing composer focus', async () => {
    vi.useFakeTimers()
    render(<><textarea aria-label="Composer" /><TeamAction {...bench().props} /></>)
    const composer = screen.getByRole('textbox')
    composer.focus()
    fireEvent.mouseEnter(screen.getByRole('button', { name: zh.trigger }))
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(composer, { key: 'a' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(composer, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(composer)
  })
})

it('keeps the hover panel open when the pointer returns directly to its trigger', async () => {
  vi.useFakeTimers()
  render(<TeamAction {...bench().props} />)
  const trigger = screen.getByRole('button', { name: zh.trigger })
  fireEvent.mouseOver(trigger, { relatedTarget: document.body })
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  const panel = screen.getByRole('dialog')
  fireEvent.mouseOut(trigger, { relatedTarget: panel })
  fireEvent.mouseOver(panel, { relatedTarget: trigger })
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  expect(screen.getByRole('dialog')).toBe(panel)
  fireEvent.mouseOut(panel, { relatedTarget: trigger })
  fireEvent.mouseOver(trigger, { relatedTarget: panel })
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  expect(screen.getByRole('dialog')).toBe(panel)
})

it('cancels pending hover dismissal when the trigger is activated from the keyboard', async () => {
  vi.useFakeTimers()
  render(<TeamAction {...bench().props} />)
  const trigger = screen.getByRole('button', { name: zh.trigger })
  trigger.focus()
  fireEvent.mouseOver(trigger, { relatedTarget: document.body })
  await act(async () => { await vi.advanceTimersByTimeAsync(150) })
  fireEvent.mouseOut(trigger, { relatedTarget: document.body })
  fireEvent.click(trigger, { detail: 0 })
  await act(async () => { await vi.advanceTimersByTimeAsync(120) })
  expect(screen.getByRole('dialog')).toBe(document.activeElement)
})

it('updates expansion availability on paragraph resize and disconnects its observer', () => {
  const observers: TestResizeObserver[] = []
  class TestResizeObserver implements ResizeObserver {
    observe = vi.fn<ResizeObserver['observe']>()
    unobserve = vi.fn<ResizeObserver['unobserve']>()
    disconnect = vi.fn()
    constructor(readonly callback: ResizeObserverCallback) { observers.push(this) }
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  const scrollHeight = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(36)
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(36)
  const view = render(<TeamAction {...bench().props} />)
  openPanel()
  const paragraph = screen.getByText('Build the Team runtime')
  const observer = observers.find(item => item.observe.mock.calls.some(([target]) => target === paragraph))!
  expect(observer).toBeDefined()
  expect(screen.queryByRole('button', { name: zh['task.expand'] })).toBeNull()
  scrollHeight.mockReturnValue(72)
  act(() => { observer.callback([], observer) })
  expect(screen.getByRole('button', { name: zh['task.expand'] })).toBeTruthy()
  scrollHeight.mockReturnValue(36)
  act(() => { observer.callback([], observer) })
  expect(screen.queryByRole('button', { name: zh['task.expand'] })).toBeNull()
  view.unmount()
  expect(observer.disconnect).toHaveBeenCalledOnce()
})
