import { describe, expect, it, vi } from 'vitest'
import { TeamId, TeamMessageId } from '../src/index.ts'
import { TeamJournal } from '../src/journal.ts'
import { nativeHarness } from './native-lifecycle-harness.ts'

type Harness = Awaited<ReturnType<typeof nativeHarness>>

/** A Team wait and whether it has returned yet. */
function watch(test: Harness) {
  const state = { settled: false }
  const wait = test.ctx.agentTeams.waitForChange(test.lead, 10_000, new AbortController().signal)
  void wait.finally(() => { state.settled = true })
  return { wait, state }
}

const extension = (test: Harness, recordId: string) => ({ version: 1 as const, teamId: TeamId(test.lead.id),
  extension: { id: 'lifecycle-writer', recordId, dataJson: '{}' } })

describe('audit-only extension records', () => {
  it('leave Team waiters waiting, while records with notices and ordinary records wake them', async () => {
    const test = await nativeHarness()
    const first = watch(test)
    await test.writer!.commitRecord(test.lead, () => ({ recordId: 'read-1', dataJson: '{}', quiet: true }))
    await Promise.resolve()
    expect(first.state.settled).toBe(false)
    await test.writer!.commitRecord(test.lead, () => ({ recordId: 'ordinary', dataJson: '{}' }))
    await expect(first.wait).resolves.toEqual({ timedOut: false })

    // A quiet record that carries notices still wakes: the notices concern the waiting Lead.
    const second = watch(test)
    await test.writer!.commitRecord(test.lead, () => ({ recordId: 'read-with-notice', dataJson: '{}', quiet: true,
      notices: [{ id: TeamMessageId('quiet-notice'), senderId: test.lead.id, senderName: 'lead', targetId: test.lead.id,
        content: [{ type: 'text', text: 'notice' }] }] }))
    await expect(second.wait).resolves.toEqual({ timedOut: false })
  })

  it('wakes for an earlier write still awaiting confirmation, whose own commit never woke anyone', async () => {
    const test = await nativeHarness()
    const onCommit = vi.fn()
    const journal = new TeamJournal(test.ctx, onCommit)
    await journal.appendAndFlush(test.lead, 'team/extension', extension(test, 'quiet-plain'), false, false, false)
    await journal.appendAndFlush(test.lead, 'team/extension', extension(test, 'quiet-durable'), true, false, false)
    expect(onCommit).not.toHaveBeenCalled()

    // The durable write's checkpoint fails, so it stays unconfirmed without waking anyone.
    vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(journal.appendAndFlush(test.lead, 'team/extension', extension(test, 'unconfirmed'), true))
      .rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
    expect(onCommit).not.toHaveBeenCalled()
    await journal.appendAndFlush(test.lead, 'team/extension', extension(test, 'quiet-after-plain'), false, false, false)
    expect(onCommit).toHaveBeenCalledTimes(1)

    vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(journal.appendAndFlush(test.lead, 'team/extension', extension(test, 'unconfirmed-2'), true))
      .rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
    await journal.appendAndFlush(test.lead, 'team/extension', extension(test, 'quiet-after-durable'), true, false, false)
    expect(onCommit).toHaveBeenCalledTimes(2)
  })
})
