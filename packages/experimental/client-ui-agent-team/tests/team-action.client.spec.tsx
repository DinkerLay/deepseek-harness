// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamMessageId, TeamTaskAttemptId, TeamTaskId, TeamTaskView as TeamTask, TeamView,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  TeamAction, type TeamActionInjected, type TeamActionProps, type TeamActionResult,
} from '../src/client/TeamAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const SESSION = 'lead' as SessionId
const TASK_1 = 'task-1' as TeamTaskId
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
const view: TeamView = {
  members: [
    { id: SESSION, name: 'lead', role: 'lead', status: 'inactive', model: 'model-a', diagnostics: [] },
    {
      id: 'worker-id' as SessionId,
      name: 'worker',
      role: 'teammate',
      status: 'inactive',
      model: 'model-a',
      diagnostics: [],
    },
  ],
  tasks: [task],
}

function remoteFailure(message: string): TeamActionResult<never> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

function props(actions: TeamActionInjected, sessionId: SessionId = SESSION, activity?: object): TeamActionProps {
  return {
    sessionId,
    ...actions,
    t: makeTranslate(zh, commonZh),
    renderSlot: () => null,
    useProjection: () => activity,
  } as unknown as TeamActionProps
}

function actions(overrides: Partial<TeamActionInjected> = {}): TeamActionInjected {
  return {
    load: () => Promise.resolve({ ok: true, value: view }),
    loadMessages: () => Promise.resolve({ ok: true, value: { messages: [], total: 0 } }),
    openTeammate: () => {},
    ...overrides,
  }
}

describe('TeamAction', () => {
  it('ignores a stale Team load after the conversation switches sessions', async () => {
    const nextSession = 'next-lead' as SessionId
    const firstLoad = Promise.withResolvers<{ ok: true; value: TeamView }>()
    const nextView: TeamView = {
      ...view,
      members: [{ id: nextSession, name: 'lead', role: 'lead', status: 'inactive', diagnostics: [] }],
      tasks: [{ ...task, id: 'task-next' as TeamTaskId, subject: 'Next session task' }],
    }
    const load = vi.fn((sessionId: SessionId) => sessionId === SESSION
      ? firstLoad.promise
      : Promise.resolve({ ok: true as const, value: nextView }))
    const injected = actions({ load })
    const rendered = render(<TeamAction {...props(injected)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await waitFor(() => { expect(load).toHaveBeenCalledWith(SESSION) })

    rendered.rerender(<TeamAction {...props(injected, nextSession)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByText('Next session task')).toBeTruthy()
    firstLoad.resolve({ ok: true, value: view })
    await Promise.resolve()

    await waitFor(() => {
      expect(screen.getByText('Next session task')).toBeTruthy()
      expect(screen.queryByText('Implement runtime')).toBeNull()
    })
  })

  it('loads roster/task diagnostics on open and navigates a healthy teammate', async () => {
    const openTeammate = vi.fn()
    render(<TeamAction {...props(actions({ openTeammate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    const worker = await screen.findByRole('button', { name: /worker/u })
    fireEvent.click(screen.getByRole('button', { name: /Implement runtime/u }))
    expect(screen.getByText('write scopes overlap with task-2')).toBeTruthy()
    fireEvent.click(worker)
    await waitFor(() => { expect(openTeammate).toHaveBeenCalledWith(SESSION, view.members[1]) })
  })

  it('keeps retired members visible without offering Team execution navigation', async () => {
    const openTeammate = vi.fn()
    const retiredView: TeamView = {
      ...view,
      members: [view.members[0]!, { ...view.members[1]!, status: 'retired' }],
      tasks: [{ ...task, ownerName: 'worker' }],
    }
    render(<TeamAction {...props(actions({
      openTeammate,
      load: () => Promise.resolve({ ok: true, value: retiredView }),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    const member = await screen.findByRole('button', { name: /^worker/u })
    expect(member.hasAttribute('disabled')).toBe(true)
    expect(member.textContent).toContain(zh['memberStatus.retired'])
    fireEvent.click(screen.getByRole('button', { name: /Implement runtime/u }))
    expect(screen.queryByRole('button', { name: zh.openMemberSession })).toBeNull()
    expect(openTeammate).not.toHaveBeenCalled()
  })

  it('shows complete peer messages to the Lead without exposing the monitor in a teammate session', async () => {
    const loadMessages = vi.fn(() => Promise.resolve({ ok: true as const, value: {
      total: 1,
      messages: [{
        id: 'message-1' as TeamMessageId,
        senderName: 'worker', targetName: 'reviewer',
        text: 'private review findings',
        contentJson: '[{"type":"text","text":"private review findings"}]',
        hasNonText: false,
        taskId: TASK_1, time: 1_000, status: 'delivered' as const,
      }],
    } }))
    const injected = actions({ loadMessages })
    const rendered = render(<TeamAction {...props(injected)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    fireEvent.click(await screen.findByRole('button', { name: zh.messages }))
    expect(await screen.findByText('private review findings')).toBeTruthy()
    expect(screen.getByText('worker → reviewer')).toBeTruthy()
    expect(screen.getByText(TASK_1)).toBeTruthy()
    expect(loadMessages).toHaveBeenCalledWith(SESSION, undefined)

    rendered.rerender(<TeamAction {...props(injected, 'worker-id' as SessionId)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    expect(screen.queryByRole('button', { name: zh.messages })).toBeNull()
  })

  it('keeps only the newest overlapping refresh for one session', async () => {
    const older = Promise.withResolvers<TeamActionResult<TeamView>>()
    const newer = Promise.withResolvers<TeamActionResult<TeamView>>()
    const newestView = {
      ...view,
      tasks: [{ ...task, id: 'newest-task' as TeamTaskId, subject: 'Newest task' }],
    }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
    render(<TeamAction {...props(actions({ load }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    const refresh = screen.getByRole('button', { name: zh.refresh })
    fireEvent.click(refresh)
    expect(screen.getByRole('status', { name: zh.loading })).toBeTruthy()
    fireEvent.click(refresh)
    newer.resolve({ ok: true, value: newestView })
    expect(await screen.findByText('Newest task')).toBeTruthy()
    older.resolve({ ok: true, value: view })
    await Promise.resolve()

    expect(screen.getByText('Newest task')).toBeTruthy()
    expect(screen.queryByText('Implement runtime')).toBeNull()
  })

  it('renders roster/task state variants and contains navigation, refresh, and close actions', async () => {
    const { ownerName: _ownerName, ...unownedTask } = task
    const richView: TeamView = {
      ...view,
      members: [
        view.members[0]!,
        { ...view.members[1]!, status: 'running' },
        {
          id: 'failed-id' as SessionId,
          name: 'failed-worker',
          role: 'teammate',
          status: 'failed',
          diagnostics: ['provider failed'],
        },
        {
          id: 'provisioning-id' as SessionId,
          name: 'provisioning-worker',
          role: 'teammate',
          status: 'provisioning',
          diagnostics: [],
        },
      ],
      tasks: [
        { ...unownedTask, id: 'ready-task' as TeamTaskId, status: 'pending', ready: true },
        { ...unownedTask, id: 'blocked-task' as TeamTaskId, status: 'pending', ready: false, blockedBy: [TASK_1] },
        { ...task, id: 'completed-task' as TeamTaskId, status: 'completed' },
      ],
    }
    const load = vi.fn(() => Promise.resolve({ ok: true as const, value: richView }))
    const openTeammate = vi.fn(() => { throw new Error('navigation failed') })
    render(<TeamAction {...props(actions({ load, openTeammate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByText('provider failed')).toBeTruthy()
    expect(screen.getByText(zh.ready)).toBeTruthy()
    expect(screen.getByText(zh.blocked)).toBeTruthy()
    const failedMember = screen.getByRole<HTMLButtonElement>('button', { name: /failed-worker/u })
    const provisioningMember = screen.getByRole<HTMLButtonElement>('button', { name: /provisioning-worker/u })
    expect(failedMember.disabled).toBe(true)
    expect(failedMember.querySelector('[data-state="error"]')).not.toBeNull()
    expect(provisioningMember.disabled).toBe(true)
    expect(provisioningMember.querySelector('[data-state="ongoing"]')).not.toBeNull()
    const tasks = [...document.querySelectorAll('button[aria-pressed]')]
    expect(tasks.map(card => card.querySelector('[data-state]')?.getAttribute('data-state')))
      .toEqual(['idle', 'warning', 'done'])

    fireEvent.click(screen.getByRole('button', { name: /^worker运行中/u }))
    expect(await screen.findByText('Error: navigation failed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Agent Team/u }))
  })

  it('shows load failures', async () => {
    render(<TeamAction {...props(actions({
      load: () => Promise.resolve(remoteFailure('load failed')),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'load failed (gateway/internal)')
  })

  it('shows an empty task board without a create action', async () => {
    render(<TeamAction {...props(actions({
      load: () => Promise.resolve({ ok: true, value: { members: [], tasks: [] } }),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByText(zh.empty)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /新建任务/u })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('keeps task rows compact and opens the full record before member navigation', async () => {
    const { ownerName: _ownerName, ...unowned } = task
    const tasks: TeamTask[] = [
      { ...unowned, status: 'pending', ready: true },
      { ...task, id: 'task-2' as TeamTaskId },
      { ...task, id: 'task-3' as TeamTaskId, status: 'completed', ownerName: 'worker' },
    ]
    const openTeammate = vi.fn()
    render(<TeamAction {...props(actions({
      openTeammate,
      load: () => Promise.resolve({ ok: true, value: { ...view, tasks } }),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByRole('button', { name: /task-3/u })
    expect(screen.queryByText('Build the Team runtime')).toBeNull()
    expect(screen.getByText('Owner: 未分配')).toBeTruthy()
    expect(screen.getByText('Owner: lead')).toBeTruthy()
    expect(screen.getByText('Owner: worker')).toBeTruthy()
    expect(screen.getByText(zh['status.pending'])).toBeTruthy()
    expect(screen.getByText(zh['status.in_progress'])).toBeTruthy()
    expect(screen.getByText(zh['status.completed'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^(新建任务|编辑|完成|重开|删除)$/u })).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    for (const card of document.querySelectorAll('button[aria-pressed]')) {
      expect(card.querySelector('button, input, select, textarea')).toBeNull()
    }
    fireEvent.click(screen.getByRole('button', { name: /task-3/u }))
    const detail = screen.getByRole('region', { name: zh.taskDetails })
    expect(detail.textContent).toContain('Build the Team runtime')
    expect(detail.textContent).toContain(zh.taskRecord)
    fireEvent.click(screen.getByRole('button', { name: zh.openMemberSession }))
    expect(openTeammate).toHaveBeenCalledWith(SESSION, view.members[1])
    fireEvent.click(screen.getByRole('button', { name: zh.closeDetails }))
    expect(screen.queryByRole('region', { name: zh.taskDetails })).toBeNull()
  })

  it('renders the selected task record as safe GFM without changing task data', async () => {
    const description = '# Final audit\n\n| Task | Result |\n| --- | --- |\n| task-1 | accepted |\n\n<script>alert(1)</script>'
    render(<TeamAction {...props(actions({
      load: () => Promise.resolve({ ok: true, value: {
        ...view, tasks: [{ ...task, description }],
      } }),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    fireEvent.click(await screen.findByRole('button', { name: /Implement runtime/u }))
    const detail = screen.getByRole('region', { name: zh.taskDetails })
    expect(detail.querySelector('h1')?.textContent).toBe('Final audit')
    expect(detail.querySelectorAll('table')).toHaveLength(1)
    expect(detail.querySelector('th')?.textContent).toBe('Task')
    expect(detail.querySelector('td')?.textContent).toBe('task-1')
    expect(detail.querySelector('script')).toBeNull()
    expect(view.tasks[0]?.description).toBe('Build the Team runtime')
  })

  it('keeps the Task request separate from submitted results and review state', async () => {
    const managed: TeamTask = {
      ...task,
      review: {
        validity: 'none',
        attempts: [{
          id: 'attempt-1' as TeamTaskAttemptId,
          ownerName: 'worker',
          status: 'submitted',
          inputs: [],
          result: { summary: '**Reviewed output**', artifacts: ['reports/review.md'] },
        }],
      },
    }
    render(<TeamAction {...props(actions({
      load: () => Promise.resolve({ ok: true, value: { ...view, tasks: [managed] } }),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    fireEvent.click(await screen.findByRole('button', { name: /Implement runtime/u }))
    const detail = screen.getByRole('region', { name: zh.taskDetails })
    expect(detail.textContent).toContain('Build the Team runtime')
    expect(detail.textContent).toContain('Reviewed output')
    expect(detail.textContent).toContain('reports/review.md')
    expect(detail.textContent).toContain(zh['review.submitted'])
    expect(detail.querySelectorAll('h4').length).toBeGreaterThan(1)
  })

  it('keeps the task list authoritative while an optional graph view is open', async () => {
    const renderSlot = vi.fn((name: string, owner: { openGraph?: () => void }) => {
      if (name === 'agent-team.panel.tasks.action') {
        return <button onClick={owner.openGraph}>Open prerequisite graph</button>
      }
      return <div>Read-only graph extension</div>
    })
    render(<TeamAction {...{ ...props(actions()), renderSlot } as TeamActionProps} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: 'Open prerequisite graph' }))
    expect(screen.getByText('Read-only graph extension')).toBeTruthy()
    expect(screen.queryByText('Implement runtime')).toBeNull()
    expect(renderSlot.mock.calls.some(([name, owner]) => name === 'agent-team.panel.tasks.graph'
      && 'view' in owner && owner.view === view
      && 'openMemberSession' in owner && typeof owner.openMemberSession === 'function')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh.taskList }))
    expect(screen.getByText('Implement runtime')).toBeTruthy()
    expect(screen.queryByText('Read-only graph extension')).toBeNull()
  })

  it('refreshes an open graph when the Lead Team activity projection advances', async () => {
    const nextView = { ...view, tasks: [
      { ...task, status: 'completed' as const },
      { ...task, id: 'task-2' as TeamTaskId, subject: 'Review result', blockedBy: [TASK_1] },
    ] }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockResolvedValueOnce({ ok: true, value: nextView })
    const renderSlot = (name: string, owner: { openGraph?: () => void; view?: TeamView }) =>
      name === 'agent-team.panel.tasks.action'
        ? <button onClick={owner.openGraph}>Open graph</button>
        : <div>Graph tasks: {owner.view?.tasks.length}; first: {owner.view?.tasks[0]?.status}; edges: {owner.view?.tasks[1]?.blockedBy.join(',') ?? 'none'}</div>
    const component = (activity: object) => <TeamAction {...{
      ...props(actions({ load }), SESSION, activity), renderSlot,
    } as TeamActionProps} />
    const rendered = render(component({ revision: 0 }))
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: 'Open graph' }))
    expect(screen.getByText('Graph tasks: 1; first: in_progress; edges: none')).toBeTruthy()

    rendered.rerender(component({ revision: 1 }))
    expect(await screen.findByText('Graph tasks: 2; first: completed; edges: task-1')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('keeps panel interactions open and dismisses on outside pointer or Escape', async () => {
    const rendered = render(<TeamAction {...props(actions())} />)
    const trigger = screen.getByRole('button', { name: /Agent Team/u })
    fireEvent.click(trigger)
    const panel = await screen.findByRole('dialog')
    expect(rendered.container.contains(panel)).toBe(false)
    expect(document.activeElement).toBe(panel)
    fireEvent.pointerDown(panel)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.pointerDown(trigger)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    await screen.findByText('Implement runtime')
    fireEvent.keyDown(screen.getByRole('button', { name: zh.refresh }), { key: 'Enter' })
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: zh.refresh }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps focus within the trigger or panel and closes when focus moves elsewhere', async () => {
    render(<><TeamAction {...props(actions())} /><button>Outside</button></>)
    const trigger = screen.getByRole('button', { name: /Agent Team/u })
    fireEvent.click(trigger)
    const panel = await screen.findByRole('dialog')
    fireEvent.blur(panel, { relatedTarget: screen.getByRole('button', { name: zh.refresh }) })
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.blur(panel, { relatedTarget: trigger })
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.blur(panel, { relatedTarget: null })
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.blur(panel, { relatedTarget: screen.getByRole('button', { name: 'Outside' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

})
