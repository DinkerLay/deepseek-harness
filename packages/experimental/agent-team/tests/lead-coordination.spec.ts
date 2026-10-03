import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { emptyTeamState } from '../src/projection.ts'
import { applyLeadTransition, leadCoordinationActive, leadCoordinationFrozen,
  teamLeadCoordinationSchema, teamLeadTransitionSchema } from '../src/lead-coordination.ts'
import type { TeamLeadTransition } from '../src/lead-coordination.ts'
import { TeamLeadOperationId, TeamMessageId } from '../src/types.ts'

const anchor = SessionId('coordination-anchor')
const base = { ...emptyTeamState(anchor), mode: { kind: 'controlled' as const,
  requiredTaskExtensionId: 'writer', permissionTableId: 'table', permissionRevision: 'revision' } }
const requested: TeamLeadTransition = { operationId: TeamLeadOperationId('handoff'), previousTerm: 1,
  previousExecutionId: anchor, phase: 'requested' }
const requestedState = { ...base, leadCoordination: applyLeadTransition(base, 'coordinator', requested) }
const frozen = { ...requestedState, leadCoordination: applyLeadTransition(requestedState, 'coordinator', { ...requested, phase: 'frozen' }) }

describe('native coordination phase relations', () => {
  it('validates the new schemas and preserves an untouched official Team', () => {
    expect(teamLeadTransitionSchema.parse(requested)).toEqual(requested)
    expect(teamLeadCoordinationSchema.parse(frozen.leadCoordination)).toEqual(frozen.leadCoordination)
    expect(leadCoordinationActive(undefined)).toBe(false)
    expect(leadCoordinationFrozen(requestedState.leadCoordination)).toBe(false)
    expect(leadCoordinationFrozen(frozen.leadCoordination)).toBe(true)
    for (const phase of ['ready', 'cancelled', 'failed'] as const) {
      expect(leadCoordinationActive({ ...frozen.leadCoordination, phase })).toBe(false)
    }
    expect(() => applyLeadTransition(emptyTeamState(anchor), 'coordinator', requested)).toThrow(/controlled/)
    expect(() => applyLeadTransition(base, 'writer', requested)).toThrow(/distinct/)
  })

  it.each([
    ['missing', { ...base }, { ...requested, phase: 'frozen' }],
    ['owner', { ...frozen, leadCoordination: { ...frozen.leadCoordination, coordinatorId: 'another' } }, { ...requested, phase: 'safe' }],
    ['operation', frozen, { ...requested, operationId: TeamLeadOperationId('another'), phase: 'safe' }],
    ['term', frozen, { ...requested, previousTerm: 2, phase: 'safe' }],
    ['execution', frozen, { ...requested, previousExecutionId: SessionId('another'), phase: 'safe' }],
    ['safe before freeze', requestedState, { ...requested, phase: 'safe' }],
    ['prepare before safe', frozen, { ...requested, phase: 'prepared' }],
    ['ready before commit', frozen, { ...requested, phase: 'ready' }],
  ] as const)('rejects %s control', (_name, state, transition) => {
    expect(() => applyLeadTransition(state, 'coordinator', transition)).toThrow()
  })

  it('requires exact incumbent seat and allows repeated occupation of prepared work after recovery', () => {
    expect(() => applyLeadTransition({ ...frozen, lead: { executionId: SessionId('new'), term: 2,
      presetId: 'preset', revision: 'a'.repeat(64) } }, 'coordinator', { ...requested, phase: 'safe' })).toThrow(/stale/)
    expect(() => applyLeadTransition({ ...frozen, lead: { executionId: SessionId('other'), term: 1,
      presetId: 'preset', revision: 'a'.repeat(64) } }, 'coordinator', { ...requested, phase: 'safe' })).toThrow(/stale/)
    let state = { ...frozen, leadCoordination: applyLeadTransition(frozen, 'coordinator', { ...requested, phase: 'safe' }) }
    state = { ...state, leadCoordination: applyLeadTransition(state, 'coordinator', { ...requested, phase: 'safe' }) }
    state = { ...state, leadCoordination: applyLeadTransition(state, 'coordinator', { ...requested, phase: 'prepared' }) }
    state = { ...state, leadCoordination: applyLeadTransition(state, 'coordinator', { ...requested, phase: 'prepared' }) }
    expect(applyLeadTransition(state, 'coordinator', { ...requested, phase: 'safe' }).phase).toBe('safe')
    expect(applyLeadTransition(state, 'coordinator', { ...requested, phase: 'failed' }).phase).toBe('failed')
    expect(() => applyLeadTransition({ ...state, leadCoordination: { ...state.leadCoordination, phase: 'cancelled' } },
      'coordinator', { ...requested, phase: 'failed' })).toThrow(/phase/)
  })

  it('readiness requires the committed next term and settled logical Lead mail', () => {
    const message = { id: TeamMessageId('notice'), senderId: anchor, senderName: 'lead', targetId: anchor, content: [] }
    const committed = { ...frozen, leadCoordination: { ...frozen.leadCoordination, phase: 'committed' as const },
      lead: { executionId: SessionId('new'), term: 2, presetId: 'preset', revision: 'a'.repeat(64) }, messages: [message] }
    expect(() => applyLeadTransition({ ...committed, lead: { ...committed.lead, term: 3 } }, 'coordinator', { ...requested, phase: 'ready' })).toThrow(/committed/)
    expect(() => applyLeadTransition(committed, 'coordinator', { ...requested, phase: 'ready' })).toThrow(/mailbox/)
    expect(applyLeadTransition({ ...committed, delivered: [message.id] }, 'coordinator', { ...requested, phase: 'ready' }).phase).toBe('ready')
    expect(applyLeadTransition({ ...committed, cancelled: [{ messageId: message.id, targetId: anchor, reason: 'settled' }] },
      'coordinator', { ...requested, phase: 'ready' }).phase).toBe('ready')
    expect(applyLeadTransition({ ...committed, messages: [{ ...message, targetId: SessionId('member') }] },
      'coordinator', { ...requested, phase: 'ready' }).phase).toBe('ready')
  })
})
