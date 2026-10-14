import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { TeamError, TeamId, TeamMessageId, TeamTaskId, type TeamTaskSnapshot } from '../src/index.ts'
import { assertStartQuota, countedStarters, memberEverStarted } from '../src/start-quota.ts'
import { nativeHarness, nativeState } from './native-lifecycle-harness.ts'

type Harness = Awaited<ReturnType<typeof nativeHarness>>

function task(id: string, extra: Partial<TeamTaskSnapshot> = {}): TeamTaskSnapshot {
  return { id: TeamTaskId(id), revision: 1, subject: `Task ${id}`, description: 'quota fixture', status: 'pending',
    blockedBy: [], writeScopes: [], ...extra }
}

function notice(test: Harness, id: string, targetId: SessionId) {
  return { id: TeamMessageId(id), senderId: test.lead.id, senderName: 'lead', targetId, content: [{ type: 'text' as const, text: 'work' }] }
}

/** The Team refusal a write ends with. */
async function refusal(write: Promise<unknown>): Promise<TeamError> {
  const error = await write.then(() => undefined, (failure: unknown) => failure)
  if (!(error instanceof TeamError)) throw new Error('the write was not refused by the Team')
  return error
}

/** Queue one Lead message to a member without delivering it, as a busy mailbox leaves it. */
async function message(test: Harness, target: string) {
  return await test.ctx.agentTeams.sendMessage(test.lead, { target, content: [{ type: 'text', text: `for ${target}` }], signal: test.signal })
}

describe('controlled Team start quota', () => {
  it('counts members with waiting work, not standby registrations, and refuses only the write that starts one too many', async () => {
    const test = await nativeHarness({ config: { maxStartedMembers: 1 } })
    const first = await test.spawn('first')
    await test.spawn('second')
    const third = await test.spawn('third')
    // Three standby members registered past the start quota: none holds an execution yet.
    expect(test.ctx.agentTeams.memberQuotas(test.lead))
      .toMatchObject({ inPost: { used: 3 }, started: { used: 0, limit: 1, memberIds: [] } })
    await message(test, 'first')
    expect([...countedStarters(nativeState(test.ctx, test.lead))]).toEqual([first.member.id])
    const refused = await refusal(message(test, 'second'))
    expect(refused.code).toBe('TEAM_START_QUOTA_REACHED')
    expect(refused.message).toContain('start quota 1 reached: second would start; members already counted: 1 (first)')
    // A member already counted receives more work at any time.
    await message(test, 'first')
    expect((await refusal(test.writer!.commitRecord(test.lead, () => ({ recordId: 'both', dataJson: '{}',
      notices: [notice(test, 'to-first', first.member.id), notice(test, 'to-third', third.member.id)] })))).message)
      .toContain('third would start')
    expect(await test.writer!.commitRecord(test.lead, () => ({ recordId: 'first-only', dataJson: '{}',
      notices: [notice(test, 'to-first-again', first.member.id), notice(test, 'to-lead', test.lead.id)] }))).toMatchObject({ committed: true })
    expect(await test.writer!.read(test.lead, snapshot => snapshot.startQuota)).toMatchObject({ limit: 1, counted: [first.member.id] })
  })

  it('names the started members that could retire at once', async () => {
    const test = await nativeHarness({ config: { maxStartedMembers: 2 } })
    const busy = await test.spawn('busy')
    await test.spawn('idle')
    await test.spawn('standby')
    await test.writer!.commit(test.lead, () => ({ dataJson: '{}', updates: [{ previousRevision: null,
      task: task('task-1', { status: 'in_progress', ownerId: busy.member.id }) }] }))
    const sent = [await message(test, 'busy'), await message(test, 'idle')]
    await vi.waitFor(() => {
      const delivered = nativeState(test.ctx, test.lead).delivered
      expect(sent.every(item => delivered.includes(item.messageId))).toBe(true)
    })
    // The busy member still owns running work; the idle one has nothing left to settle.
    expect((await refusal(message(test, 'standby'))).message).toContain('members already counted: 2 (busy, idle); idle can retire at once')
    const idle = nativeState(test.ctx, test.lead).members.find(member => member.name === 'idle')!
    expect(test.ctx.agentTeams.memberQuotas(test.lead).started).toMatchObject({ used: 2, retirable: [idle.id] })
    expect(await test.writer!.read(test.lead, snapshot => snapshot.startQuota?.retirable)).toEqual([idle.id])
  })

  it('keeps a rebuilt member counted and leaves failed members and every official Team out', async () => {
    const test = await nativeHarness({ config: { maxStartedMembers: 1 } })
    const rebuilt = await test.spawn('rebuilt')
    const state = nativeState(test.ctx, test.lead)
    const member = state.members.find(candidate => candidate.id === rebuilt.member.id)!
    const renewed = { ...state, memberExecutions: [{ memberId: member.id, executionId: SessionId('rebuilt-generation-2'),
      generation: 2, operationId: 'renew' }] }
    expect(memberEverStarted(renewed, member)).toBe(true)
    expect([...countedStarters(renewed)]).toEqual([member.id])
    expect([...countedStarters({ ...renewed, members: [{ ...member, phase: 'failed' as const }] })]).toEqual([])

    // A retired source still held by its change operation keeps its place until the operation lets go.
    const control = { memberId: member.id, operationId: 'replace', ownerId: 'member-change', generation: 2,
      executionId: SessionId('rebuilt-generation-2'), leadExecutionId: test.lead.id, leadTerm: 1, held: true }
    const retired = { ...renewed, members: [{ ...member, phase: 'retired' as const }] }
    expect([...countedStarters({ ...retired, memberControls: [control] })]).toEqual([member.id])
    expect([...countedStarters(retired)]).toEqual([])

    const official = await nativeHarness({ controlled: false, config: { maxStartedMembers: 1, maxOpenTasks: 1 }, writer: false })
    expect(official.ctx.agentTeams.memberQuotas(official.lead)).not.toHaveProperty('started')
  })
})

describe('start quota refusals', () => {
  it('leaves cancelled mail out and says so when no member counts yet', async () => {
    const test = await nativeHarness({ config: { maxStartedMembers: 1 } })
    const first = await test.spawn('first')
    const second = await test.spawn('second')
    const state = nativeState(test.ctx, test.lead)
    const waiting = notice(test, 'cancelled-work', first.member.id)
    expect([...countedStarters({ ...state, messages: [waiting],
      cancelled: [{ messageId: waiting.id, targetId: first.member.id, reason: 'cancelled' }] })]).toEqual([])
    expect(() => { assertStartQuota(state, [first.member.id, second.member.id], 1) })
      .toThrow('start quota 1 reached: first, second would start; members already counted: 0; none can retire at once')
    // A locked composition names no member as retirable: the user unlocks it first.
    expect(() => { assertStartQuota({ ...state, composition: { phase: 'fixed' } }, [first.member.id, second.member.id], 1) })
      .toThrow('the Team composition is locked, so the user unlocks it before anyone retires')
    // An official Team has no start quota.
    const { mode: _mode, ...official } = state
    expect(() => { assertStartQuota(official, [first.member.id, second.member.id], 1) }).not.toThrow()
    expect(() => { assertStartQuota(state, [first.member.id], 1) }).not.toThrow()
    expect(() => { assertStartQuota(state, [first.member.id, second.member.id], undefined) }).not.toThrow()
  })
})

describe('Task counts', () => {
  /** Seed Tasks straight into the journal, as an earlier deployment with a higher limit left them. */
  async function seed(test: Harness, ...tasks: TeamTaskSnapshot[]) {
    test.lead.session.append('team/task/transaction', { version: 1, teamId: TeamId(test.lead.id),
      updates: tasks.map(item => ({ previousRevision: null, task: item })), extension: { id: 'lifecycle-writer', dataJson: '{}' } })
    await test.ctx.sessions.flush(test.lead.session)
  }
  const committer = (test: Harness) => (...updates: { previousRevision: number | null; task: TeamTaskSnapshot }[]) =>
    test.writer!.commit(test.lead, () => ({ dataJson: '{}', updates }))

  it('limits unfinished Tasks and refuses only a write that adds one, also when the limit is already exceeded', async () => {
    const test = await nativeHarness({ config: { maxOpenTasks: 1 } })
    const commit = committer(test)
    await seed(test, task('task-1'), task('task-2'))
    // Two unfinished Tasks under a limit of one: changing them or finishing them still passes.
    await commit({ previousRevision: 1, task: task('task-1', { revision: 2, status: 'in_progress', ownerId: test.lead.id }) })
    const refused = await refusal(commit({ previousRevision: null, task: task('task-3') }))
    expect(refused.code).toBe('TEAM_OPEN_TASK_LIMIT')
    expect(refused.message).toBe('Team open task limit 1 reached: unfinished Tasks: 2; finish or cancel some first')
    await commit({ previousRevision: 1, task: task('task-2', { revision: 2, status: 'deleted' }) })
    await commit({ previousRevision: 2, task: task('task-1', { revision: 3, status: 'completed', ownerId: test.lead.id }) })
    // A completed Task frees its place; reopening it while another is unfinished adds one and is refused.
    await commit({ previousRevision: null, task: task('task-3') })
    expect((await refusal(commit({ previousRevision: 3, task: task('task-1', { revision: 4, status: 'pending' }) }))).code)
      .toBe('TEAM_OPEN_TASK_LIMIT')
  })

  it('keeps maxTasks as the history of Tasks that are not deleted, refusing only a write that adds one', async () => {
    const test = await nativeHarness({ config: { maxTasks: 1 } })
    const commit = committer(test)
    await seed(test, task('task-1', { status: 'completed', ownerId: test.lead.id }), task('task-2', { status: 'completed', ownerId: test.lead.id }))
    // Reopening a kept Task keeps the count, even past the limit.
    await commit({ previousRevision: 1, task: task('task-1', { revision: 2, status: 'pending' }) })
    const refused = await refusal(commit({ previousRevision: null, task: task('task-3') }))
    expect(refused.code).toBe('TEAM_TASK_LIMIT')
    expect(refused.message).toContain('Team task limit 1 reached: Tasks kept that are not deleted: 2')
    await commit({ previousRevision: 2, task: task('task-1', { revision: 3, status: 'deleted' }) })
    await commit({ previousRevision: 1, task: task('task-2', { revision: 2, status: 'deleted' }) })
    await commit({ previousRevision: null, task: task('task-3') })
  })

  it('applies no open-Task quota outside a controlled Team', async () => {
    const test = await nativeHarness({ controlled: false, config: { maxOpenTasks: 1 } })
    const commit = committer(test)
    await commit({ previousRevision: null, task: task('task-1') }, { previousRevision: null, task: task('task-2') })
    expect(test.ctx.agentTeams.listTasks(test.lead)).toHaveLength(2)
  })
})
