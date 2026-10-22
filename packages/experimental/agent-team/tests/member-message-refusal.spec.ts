/** The installed member owner may refuse a new Team message to one teammate before it is queued. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { facadeControlledMode, nativeFacadeHarness } from './native-facade-harness.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const signal = new AbortController().signal
const text = (value: string) => [{ type: 'text' as const, text: value }]

it('refuses a new message to a teammate its member owner refuses, queues nothing, and leaves other targets alone', async () => {
  const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode }, script: [textResponse('unused')] })
  const unsupported = async (): Promise<never> => { throw new Error('Task changes are outside this test') }
  test.ctx.agentTeams.installTaskExtension({ id: facadeControlledMode.requiredTaskExtensionId, create: unsupported,
    update: unsupported, validateMemberGroup: () => undefined, assessSettlementNotice: () => 'suppress' })
  const refused = new Set<SessionId>()
  const asked: SessionId[] = []
  const owner = test.ctx.agentTeams.installMemberExecutions({ id: 'refusing-owner', refuseMessage: (anchor, memberId) => {
    expect(anchor).toBe(test.lead)
    asked.push(memberId)
    return refused.has(memberId) ? 'it is leaving the Team' : undefined
  } })
  const leaving = (await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'leaving-worker', context: 'fresh',
    provider: 'spawn', presetId: 'standard', prompt: [], signal })).member
  const staying = (await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'staying-worker', context: 'fresh',
    provider: 'spawn', presetId: 'standard', prompt: [], signal })).member
  refused.add(leaving.id)
  const queued = () => test.lead.session.snapshotEvents().filter(event => event.type === 'team/message/queued')
    .map(event => event.type === 'team/message/queued' ? event.data.message.targetId : undefined)
  await expect(test.ctx.agentTeams.sendMessage(test.lead, { target: leaving.name, content: text('More work'), signal }))
    .rejects.toMatchObject({ code: 'TEAM_MESSAGE_REFUSED', message: 'teammate "leaving-worker" takes no new messages: it is leaving the Team' })
  expect(queued()).not.toContain(leaving.id)
  await test.ctx.agentTeams.sendMessage(test.lead, { target: staying.name, content: text('Other work'), signal })
  expect(queued()).toContain(staying.id)
  expect(asked).toEqual([leaving.id, staying.id])
  // Without an owner nothing refuses the message.
  await owner.dispose()
  await test.ctx.agentTeams.sendMessage(test.lead, { target: leaving.name, content: text('Late word'), signal })
  expect(queued()).toContain(leaving.id)
})
