import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { leadCoordinatorHarness } from './lead-coordinator-harness.ts'
import { nativeFacadeHarness } from './native-facade-harness.ts'

const signal = new AbortController().signal

async function replacedLead(term: number) {
  const test = await leadCoordinatorHarness({}, ['hang'])
  test.writer.dispose()
  test.ctx.agentTeams.installTaskExtension({ id: 'facade-writer',
    validateMemberGroup: (_caller, group) => { if (group !== 'control') throw new Error('Control fixture requires its control group') },
    planLeadRelease: () => '{}',
    create: async () => { throw new Error('Control fixture does not create Tasks') },
    update: async () => { throw new Error('Control fixture does not update Tasks') },
  })
  const spawned = await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'control-worker', group: 'control', presetId: 'reviewer',
    provider: 'spawn', context: 'fresh', prompt: [], signal })
  const executions = [test.lead]
  for (let nextTerm = 2; nextTerm <= term; nextTerm++) {
    const operationId = `interrupt-handoff-${nextTerm}`
    await test.freeze(operationId, nextTerm - 1)
    const candidate = await test.create(`interrupt-lead-${nextTerm}`, nextTerm)
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(operationId, nextTerm - 1), async (safe) => {
      await safe.record({ recordId: `${operationId}-prepared`, dataJson: '{}' }, true)
      await safe.commitLeadTransaction({ binding: test.binding(candidate.agent), releases: [],
        record: { recordId: `${operationId}-commit`, dataJson: '{}' } })
    })
    await test.stage('ready', operationId, nextTerm - 1)
    executions.push(candidate.agent)
  }
  const current = executions.at(-1)!
  await test.ctx.agentTeams.sendMessage(current, { target: spawned.member.name, content: [{ type: 'text', text: 'Remain active' }], signal })
  await vi.waitFor(() => { expect(test.ctx.agents.get(spawned.member.id)?.status).toBe('running') })
  const worker = test.ctx.agents.get(spawned.member.id)
  if (worker === undefined) throw new Error('Control worker was not activated')
  return { ...test, current, executions, worker, spawned }
}

describe('member interruption after a native Lead change', () => {
  it.each([2, 3])('authorizes the term-%s Lead before addressing the member through its original parent', async (term) => {
    const test = await replacedLead(term)
    const interrupt = vi.spyOn(test.ctx.subagents, 'interrupt')
    const queued = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Preserve queued work' }] })
    const receipt = test.ctx.agents.sendInput(test.worker, { message: queued, target: 'next-turn', wakeup: false })
    if (receipt !== undefined) await receipt
    try {
      expect(test.worker.session.header.parentSession).toBe(test.lead.id)
      expect(test.ctx.agentTeams.membership(test.current)).toMatchObject({ role: 'lead', term })
      expect(test.ctx.agentTeams.interrupt(test.current, test.spawned.member.name)).toEqual({ previousStatus: 'running' })
      expect(interrupt).toHaveBeenCalledWith(test.worker.id, { kind: 'ancestor', agent: test.lead })
      expect(test.worker.inbox.nextTurn.some(message => message.id === queued.id)).toBe(true)
      await test.worker.whenIdle()
    } finally { interrupt.mockRestore(); test.worker.cancel({ kind: 'user' }); await test.worker.whenIdle() }
  })

  it('refuses dormant, stale, unbound, member and unrelated callers before invoking subagent control', async () => {
    const test = await replacedLead(3)
    const candidate = await test.create('interrupt-unbound-fourth', 4)
    const unrelated = await test.ctx.agents.create({ sessionId: SessionId('interrupt-unrelated'), agentOptions: { provider: 'mock', model: 'mock' } })
    const interrupt = vi.spyOn(test.ctx.subagents, 'interrupt')
    try {
      for (const caller of [...test.executions.slice(0, -1), candidate.agent, test.worker, unrelated.agent]) {
        expect(() => test.ctx.agentTeams.interrupt(caller, test.spawned.member.name)).toThrow()
      }
      expect(interrupt).not.toHaveBeenCalled()
      expect(test.worker.status).toBe('running')
      await test.freeze('interrupt-frozen', 3)
      expect(() => test.ctx.agentTeams.interrupt(test.current, test.spawned.member.name)).toThrow()
      expect(interrupt).not.toHaveBeenCalled()
    } finally {
      interrupt.mockRestore(); test.worker.cancel({ kind: 'user' }); await test.worker.whenIdle()
      await unrelated.dispose(); await candidate.dispose()
    }
  })

  it('preserves the original Lead caller and parent for an official Team', async () => {
    const test = await nativeFacadeHarness({ script: ['hang'] })
    const spawned = await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'official-control-worker', description: 'Wait',
      provider: 'spawn', context: 'fresh', prompt: [{ type: 'text', text: 'Remain active' }], signal })
    await vi.waitFor(() => { expect(test.ctx.agents.get(spawned.member.id)?.status).toBe('running') })
    const worker = test.ctx.agents.get(spawned.member.id)
    if (worker === undefined) throw new Error('Official worker was not activated')
    const interrupt = vi.spyOn(test.ctx.subagents, 'interrupt')
    try {
      expect(test.ctx.agentTeams.interrupt(test.lead, spawned.member.name)).toEqual({ previousStatus: 'running' })
      expect(interrupt).toHaveBeenCalledWith(worker.id, { kind: 'ancestor', agent: test.lead })
      await worker.whenIdle()
    } finally { interrupt.mockRestore(); worker.cancel({ kind: 'user' }); await worker.whenIdle() }
  })
})
