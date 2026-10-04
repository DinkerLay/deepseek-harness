import { describe, expect, it } from 'vitest'
import { TeamMessageId } from '../src/index.ts'
import { teamMessageDeliveryBytes } from '../src/mailbox.ts'
import { leadCoordinatorHarness } from './lead-coordinator-harness.ts'
import { nativeFacadeHarness } from './native-facade-harness.ts'

describe('owned coordinator material size', () => {
  it('measures exact framed serialization without writing or admitting an oversized notice', async () => {
    const test = await leadCoordinatorHarness({ config: { maxMessageBytes: 256 } })
    const notice = { id: TeamMessageId('material-identity'), senderId: test.lead.id, senderName: 'lead', targetId: test.lead.id,
      content: [{ type: 'text' as const, text: '文😀\u0000"\\\n'.repeat(30) }] }
    const before = test.lead.session.snapshotEvents()
    const size = test.coordinator.measureMaterial(test.lead, notice)
    expect(size).toEqual({ bytes: teamMessageDeliveryBytes(notice, test.state()), maxBytes: 256 })
    expect(size.bytes).toBeGreaterThan(256)
    expect(test.lead.session.snapshotEvents()).toEqual(before)
    await test.stage('requested')
    await expect(test.coordinator.record(test.lead, { operationId: test.safeRequest().operationId, previousTerm: 1,
      recordId: 'oversized', dataJson: '{}', notices: [notice] })).rejects.toMatchObject({ code: 'TEAM_MESSAGE_TOO_LARGE' })
    expect(test.state().messages).toHaveLength(0)
  })

  it('admits the exact measured byte limit and never reserves or promises mailbox capacity', async () => {
    const test = await leadCoordinatorHarness({ config: { maxMessageBytes: 4096, maxPendingMessagesPerMember: 1 } })
    await test.freeze()
    const empty = { id: TeamMessageId('exact-material'), senderId: test.lead.id, senderName: 'lead', targetId: test.lead.id,
      content: [{ type: 'text' as const, text: '' }] }
    const overhead = test.coordinator.measureMaterial(test.lead, empty).bytes
    const exact = { ...empty, content: [{ type: 'text' as const, text: 'x'.repeat(4096 - overhead) }] }
    const before = test.lead.session.snapshotEvents()
    expect(test.coordinator.measureMaterial(test.lead, exact)).toEqual({ bytes: 4096, maxBytes: 4096 })
    expect(test.coordinator.measureMaterial(test.lead, exact)).toEqual({ bytes: 4096, maxBytes: 4096 })
    expect(test.lead.session.snapshotEvents()).toEqual(before)
    const record = { operationId: test.safeRequest().operationId, previousTerm: 1, dataJson: '{}' }
    await expect(test.coordinator.record(test.lead, { ...record, recordId: 'over-limit',
      notices: [{ ...exact, content: [{ type: 'text', text: `${exact.content[0]!.text}x` }] }] }))
      .rejects.toMatchObject({ code: 'TEAM_MESSAGE_TOO_LARGE' })
    expect(test.lead.session.snapshotEvents()).toEqual(before)
    await test.coordinator.record(test.lead, { ...record, recordId: 'exact-limit', notices: [exact] })
    expect(test.state().messages).toHaveLength(1)
    expect(test.state().messages[0]).toMatchObject({ id: exact.id, content: exact.content,
      contentParts: ['fact'], contentAuthors: [null] })
    const after = test.lead.session.snapshotEvents()
    const additional = { ...empty, id: TeamMessageId('no-capacity') }
    expect(test.coordinator.measureMaterial(test.lead, additional).bytes).toBeLessThan(4096)
    expect(test.lead.session.snapshotEvents()).toEqual(after)
    await expect(test.coordinator.record(test.lead, { ...record, recordId: 'full-mailbox', notices: [additional] }))
      .rejects.toMatchObject({ code: 'TEAM_MAILBOX_FULL' })
    expect(test.lead.session.snapshotEvents()).toEqual(after)
  })

  it('keeps measurement under the registered owner and preserves official Team behavior', async () => {
    const test = await leadCoordinatorHarness()
    const notice = { id: TeamMessageId('material'), senderId: test.lead.id, senderName: 'lead', targetId: test.lead.id, content: [] }
    expect(() => test.coordinator.measureMaterial(test.lead, { ...notice, senderTerm: 1 }))
      .toThrow(/cannot claim model authorship/)
    expect(() => test.coordinator.measureMaterial(test.lead, { ...notice, contentAuthors: [{ executionId: test.lead.id, term: 1 }] }))
      .toThrow(/cannot claim model authorship/)
    await test.coordinator.dispose()
    expect(() => test.coordinator.measureMaterial(test.lead, notice)).toThrow(/registration closed/)
    const official = await nativeFacadeHarness()
    const before = official.lead.session.snapshotEvents()
    const coordinator = official.ctx.agentTeams.installLeadCoordinator({ id: 'readonly-size' })
    expect(() => coordinator.measureMaterial(official.lead, { ...notice, senderId: official.lead.id, targetId: official.lead.id }))
      .toThrow(/controlled/)
    expect(official.lead.session.snapshotEvents()).toEqual(before)
  })
})
