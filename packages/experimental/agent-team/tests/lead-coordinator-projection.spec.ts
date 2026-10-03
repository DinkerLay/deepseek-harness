import { describe, expect, it } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { emptyTeamState, teamProjectionDefinition } from '../src/projection.ts'
import type { TeamProjectionState } from '../src/projection.ts'
import type { TeamLeadTransaction } from '../src/lead-seat.ts'
import { TeamId, TeamLeadOperationId } from '../src/types.ts'

const anchor = SessionId('projection-coordination')
const teamId = TeamId(anchor)
const mode = { kind: 'controlled' as const, requiredTaskExtensionId: 'writer', permissionTableId: 'table', permissionRevision: 'revision' }
const base = { ...emptyTeamState(anchor), mode }
const requested = { coordinatorId: 'coordinator', operationId: TeamLeadOperationId('operation'), previousTerm: 1,
  previousExecutionId: anchor, phase: 'requested' as const }
const prepared: TeamProjectionState = { ...base, leadCoordination: { ...requested, phase: 'prepared' } }
const transaction: TeamLeadTransaction = { version: 1, teamId, previousTerm: 1,
  binding: { executionId: SessionId('projection-candidate'), term: 2, presetId: 'preset', revision: 'a'.repeat(64) },
  extension: { id: 'writer', dataJson: '{}' }, releases: [],
  handoffRecord: { id: 'coordinator', recordId: 'committed', dataJson: '{}' } }

function event(state: TeamProjectionState, type: SessionEvent['type'], data: unknown) {
  return teamProjectionDefinition.apply(state, { type, data, seq: SessionSeq(1), time: 0 } as SessionEvent)
}

describe('durable independent coordinator facts', () => {
  it('checks prepared ownership, JSON and unique audit identity before changing the seat', () => {
    const { handoffRecord: _record, ...withoutRecord } = transaction
    expect(event(prepared, 'team/lead/transaction', withoutRecord).failure).toMatch(/independent record/)
    expect(event(prepared, 'team/lead/transaction', { ...withoutRecord, preloadNoticesFirst: true }).failure).toMatch(/initialization order/)
    for (const state of [base, { ...prepared, leadCoordination: { ...requested, phase: 'safe' as const } }]) {
      expect(event(state, 'team/lead/transaction', transaction).failure).toMatch(/prepared/)
    }
    expect(event(prepared, 'team/lead/transaction', { ...transaction,
      handoffRecord: { ...transaction.handoffRecord!, id: 'another' } }).failure).toMatch(/prepared/)
    expect(event(prepared, 'team/lead/transaction', { ...transaction,
      handoffRecord: { ...transaction.handoffRecord!, dataJson: '{' } }).failure).toMatch(/not JSON/)
    expect(event({ ...prepared, extensionRecords: [{ writerId: 'coordinator', recordId: 'committed', dataJson: '{}' }] },
      'team/lead/transaction', transaction).failure).toMatch(/already exists/)
    const committed = event(prepared, 'team/lead/transaction', transaction)
    expect(committed.failure).toBeUndefined()
    expect(committed.extensionRecords).toEqual([{ writerId: 'coordinator', recordId: 'committed', dataJson: '{}' }])
    expect(committed.leadCoordination?.phase).toBe('committed')
    expect(teamProjectionDefinition.stateSchema.parse(committed)).toEqual(committed)
  })

  it('replay refuses Profile begin while native coordination owns the same Team', () => {
    expect(event({ ...base, leadCoordination: requested }, 'team/composition', { version: 1, teamId,
      transition: { kind: 'begin', applicationId: 'application', profileId: 'profile', profileVersion: 1,
        targetJson: '{}', retiringMemberIds: [], previousPhase: 'dynamic' } }).failure).toMatch(/conflicts/)
  })
})
