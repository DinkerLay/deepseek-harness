/** Strict Task writer checkpoint retries and ownership during an awaited confirmation. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TeamTaskId } from '../src/index.ts'
import type { TeamTaskExtension, TeamTaskExtensionHandle, TeamTaskSnapshot } from '../src/index.ts'
import { nativeFacadeHarness } from './native-facade-harness.ts'

type Harness = Awaited<ReturnType<typeof nativeFacadeHarness>>

function extension(id = 'acknowledgement-writer'): TeamTaskExtension {
  const unavailable = async (): Promise<never> => { throw new Error('this fixture uses the owned transaction capability') }
  return { id, requireDurableAcknowledgement: true, create: unavailable, update: unavailable }
}

function task(): TeamTaskSnapshot {
  return { id: TeamTaskId('task-1'), revision: 1, subject: 'Checkpoint work', description: 'Owned Task effect',
    status: 'pending', blockedBy: [], writeScopes: [] }
}

function writes(test: Harness): readonly SessionEvent[] {
  return test.lead.session.snapshotEvents().filter(event =>
    event.type === 'team/task/transaction' || event.type === 'team/extension')
}

async function storedEvents(test: Harness): Promise<readonly SessionEvent[]> {
  const reader = await test.ctx.sessionPersistence.open(test.lead.id, 'read')
  try { return (await reader.read()).events }
  finally { await reader.close() }
}

/** Leave one actual extension write awaiting confirmation, without replacing the native journal. */
async function pendingRecord(test: Harness, writer: TeamTaskExtensionHandle, recordId = 'pending-checkpoint') {
  const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
  const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
    const last = session.snapshotEvents().at(-1)
    if (session === test.lead.session && last?.type === 'team/extension' && last.data.extension.recordId === recordId) return false
    return await original(session)
  })
  try {
    await expect(writer.commitRecord(test.lead, () => ({ recordId, dataJson: '{}' })))
      .rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
    expect(writes(test).filter(event => event.type === 'team/extension'
      && event.data.extension.recordId === recordId)).toHaveLength(1)
  } finally { checkpoint.mockRestore() }
}

/** Hold exactly the next root checkpoint; cleanup releases and awaits every owned operation. */
function checkpointGate(test: Harness) {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const operations: Promise<unknown>[] = []
  const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
  let held = false
  const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (!held && session === test.lead.session) {
      held = true
      entered.resolve(undefined)
      await release.promise
    }
    return await original(session)
  })
  const finish = async () => {
    release.resolve(undefined)
    await Promise.allSettled(operations)
    checkpoint.mockRestore()
  }
  onTestFinished(finish)
  return { entered: entered.promise, release: () => { release.resolve(undefined) },
    own: (operation: Promise<unknown>) => { operations.push(operation) }, finish }
}

describe('strict native Task writer acknowledgement', () => {
  it('reads an unchanged journal without flushing, writing or notifying Team activity', async () => {
    const test = await nativeFacadeHarness()
    const writer = test.ctx.agentTeams.installTaskExtension(extension())
    const flush = vi.spyOn(test.ctx.sessions, 'flush')
    const before = test.lead.session.snapshotEvents()
    const changed = vi.fn()
    const abort = new AbortController()
    const reason = new Error('unchanged-read probe finished')
    const waiting = test.ctx.agentTeams.waitForChange(test.lead, 10_000, abort.signal)
      .then((value) => { changed(value); return value }, (error: unknown) => error)
    try {
      expect(await writer.read(test.lead, snapshot => snapshot.tasks)).toEqual([])
      expect(flush).not.toHaveBeenCalled()
      expect(test.lead.session.snapshotEvents()).toEqual(before)
      expect(changed).not.toHaveBeenCalled()
      abort.abort(reason)
      expect(await waiting).toBe(reason)
    } finally {
      abort.abort(reason)
      await waiting
      flush.mockRestore()
      writer.dispose()
    }
  })

  it('confirms a pending checkpoint before its read callback sees persisted facts', async () => {
    const test = await nativeFacadeHarness()
    const writer = test.ctx.agentTeams.installTaskExtension(extension())
    await pendingRecord(test, writer)
    const gate = checkpointGate(test)
    const read = vi.fn(async () => {
      expect((await storedEvents(test)).filter(event => event.type === 'team/extension'
        && event.data.extension.recordId === 'pending-checkpoint')).toHaveLength(1)
      return 'confirmed'
    })
    const pending = writer.read(test.lead, read)
    gate.own(pending)
    try {
      await Promise.race([gate.entered, pending.then(() => { throw new Error('read did not wait for its checkpoint') })])
      expect(read).not.toHaveBeenCalled()
      gate.release()
      expect(await pending).toBe('confirmed')
      expect(read).toHaveBeenCalledOnce()
      expect(writes(test)).toHaveLength(1)
    } finally { await gate.finish(); writer.dispose() }
  })

  it.each(['false', 'throw'] as const)('rejects a strict read while a pending checkpoint returns %s', async (failure) => {
    const test = await nativeFacadeHarness()
    const writer = test.ctx.agentTeams.installTaskExtension(extension())
    await pendingRecord(test, writer)
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === test.lead.session) {
        if (failure === 'throw') throw new Error('fixture read checkpoint unavailable')
        return false
      }
      return await original(session)
    })
    const read = vi.fn(() => 'not acknowledged')
    try {
      await expect(writer.read(test.lead, read)).rejects.toThrow(/checkpoint|durability/u)
      expect(read).not.toHaveBeenCalled()
      expect(writes(test)).toHaveLength(1)
      checkpoint.mockRestore()
      expect(await writer.read(test.lead, read)).toBe('not acknowledged')
      expect(read).toHaveBeenCalledOnce()
      expect(writes(test)).toHaveLength(1)
    } finally { checkpoint.mockRestore(); writer.dispose() }
  })

  for (const operation of ['read', 'Task', 'record'] as const) {
    for (const loss of ['dispose', 'replace', 'runtime'] as const) {
      it(`rejects ${operation} when ${loss} removes its writer during checkpoint confirmation`, async () => {
        const test = await nativeFacadeHarness()
        const writer = test.ctx.agentTeams.installTaskExtension(extension())
        await pendingRecord(test, writer)
        const gate = checkpointGate(test)
        const read = vi.fn(() => 'late read')
        const build = vi.fn(() => ({ updates: [{ previousRevision: null, task: task() }], dataJson: '{}' }))
        const record = vi.fn(() => ({ recordId: 'late-record', dataJson: '{}' }))
        const pending = operation === 'read' ? writer.read(test.lead, read)
          : operation === 'Task' ? writer.commit(test.lead, build) : writer.commitRecord(test.lead, record)
        gate.own(pending)
        const rejected = expect(pending).rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
        gate.own(rejected)
        let replacement: TeamTaskExtensionHandle | undefined
        try {
          await Promise.race([gate.entered, pending.then(() => { throw new Error('operation did not wait for confirmation') })])
          if (loss === 'runtime') await test.fiber.dispose()
          else {
            writer.dispose()
            if (loss === 'replace') replacement = test.ctx.agentTeams.installTaskExtension(extension('replacement-writer'))
          }
          gate.release()
          await rejected
          expect(read).not.toHaveBeenCalled()
          expect(build).not.toHaveBeenCalled()
          expect(record).not.toHaveBeenCalled()
          expect(writes(test)).toHaveLength(1)
          if (replacement !== undefined) {
            expect(await replacement.commitRecord(test.lead, () => ({ recordId: 'replacement-active', dataJson: '{}' })))
              .toEqual({ recordId: 'replacement-active', committed: true })
          }
        } finally { await gate.finish(); replacement?.dispose(); writer.dispose() }
      })
    }
  }

  it.each(['false', 'throw'] as const)('confirms strict record retries without a second write after first checkpoint %s', async (failure) => {
    const test = await nativeFacadeHarness()
    const writer = test.ctx.agentTeams.installTaskExtension(extension())
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    let reject = true
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const last = session.snapshotEvents().at(-1)
      if (reject && session === test.lead.session && last?.type === 'team/extension'
        && last.data.extension.recordId === 'durable-record') {
        if (failure === 'throw') throw new Error('fixture record checkpoint unavailable')
        return false
      }
      return await original(session)
    })
    const first = vi.fn(() => ({ recordId: 'durable-record', dataJson: '{"effect":"once"}' }))
    const retry = vi.fn(() => ({ existingRecordId: 'durable-record' }))
    try {
      await expect(writer.commitRecord(test.lead, first)).rejects.toThrow(/checkpoint|durability/u)
      expect(first).toHaveBeenCalledOnce()
      expect(writes(test)).toHaveLength(1)
      await expect(writer.commitRecord(test.lead, retry)).rejects.toThrow(/checkpoint|durability/u)
      expect(retry).not.toHaveBeenCalled()
      reject = false
      expect(await writer.commitRecord(test.lead, retry)).toEqual({ recordId: 'durable-record', committed: false })
      expect(retry).toHaveBeenCalledOnce()
      expect(writes(test)).toHaveLength(1)
      const stored = (await storedEvents(test)).filter(event => event.type === 'team/extension'
        && event.data.extension.recordId === 'durable-record')
      expect(stored).toHaveLength(1)
      expect(JSON.stringify(stored[0])).not.toContain('requireDurableAcknowledgement')
      expect(await writer.commitRecord(test.lead, retry)).toEqual({ recordId: 'durable-record', committed: false })
      expect(writes(test)).toHaveLength(1)
    } finally { checkpoint.mockRestore(); writer.dispose() }
  })
})
