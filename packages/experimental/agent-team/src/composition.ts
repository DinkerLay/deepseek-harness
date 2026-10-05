/** Pure user-managed Team composition policy over durable roster events. */

import type { TeamCompositionState, TeamCompositionTransition, TeamMemberSnapshot } from './types.ts'

const EMPTY_COMPOSITION: TeamCompositionState = { phase: 'dynamic' }
const MAX_TARGET_BYTES = 262_144

/**
 * Read the default dynamic policy without writing a record to an official Team.
 * @param value - optional persisted composition state.
 * @returns persisted state, or the shared dynamic default when absent.
 */
export function compositionOf(value: TeamCompositionState | undefined): TeamCompositionState {
  return value ?? EMPTY_COMPOSITION
}

function assertTarget(targetJson: string): void {
  if (Buffer.byteLength(targetJson, 'utf8') > MAX_TARGET_BYTES) {
    throw new Error('Team composition target exceeds the maximum event size')
  }
  try { JSON.parse(targetJson) } catch { throw new Error('Team composition target is not JSON') }
}

/**
 * Apply one durable composition transition after checking native member state.
 * @param current - latest composition value, absent for an untouched Team.
 * @param transition - Host-authorized transition from the Team event.
 * @param members - current durable roster used to validate retirement and lock admission.
 * @returns the next durable composition value.
 */
export function applyCompositionTransition(
  current: TeamCompositionState | undefined,
  transition: TeamCompositionTransition,
  members: readonly TeamMemberSnapshot[],
): TeamCompositionState {
  const state = compositionOf(current)
  switch (transition.kind) {
    case 'begin': {
      if (state.phase === 'applying' || state.phase !== transition.previousPhase) {
        throw new Error('Team composition changed before application began')
      }
      assertTarget(transition.targetJson)
      if (new Set(transition.retiringMemberIds).size !== transition.retiringMemberIds.length) {
        throw new Error('Team composition retires the same member twice')
      }
      for (const id of transition.retiringMemberIds) {
        if (!members.some(member => member.id === id && member.phase !== 'retired')) {
          throw new Error(`Team composition retirement target "${id}" is not present`)
        }
      }
      return { ...state, phase: 'applying', application: {
        id: transition.applicationId, profileId: transition.profileId,
        profileVersion: transition.profileVersion, targetJson: transition.targetJson,
        retiringMemberIds: [...transition.retiringMemberIds],
        previousPhase: transition.previousPhase, changed: false,
      } }
    }
    case 'target':
    case 'diagnostic':
    case 'finish':
    case 'stop': {
      const application = state.application
      if (state.phase !== 'applying' || application?.id !== transition.applicationId) {
        throw new Error('Team composition application is not current')
      }
      if (transition.kind === 'target') {
        assertTarget(transition.targetJson)
        return { ...state, application: { ...application, targetJson: transition.targetJson } }
      }
      if (transition.kind === 'diagnostic') {
        return { ...state, application: { ...application, diagnostic: transition.message } }
      }
      if (transition.kind === 'stop') {
        return { phase: application.changed ? 'dynamic' : application.previousPhase,
          ...state.profile === undefined ? {} : { profile: state.profile },
          ...state.slotBindings === undefined ? {} : { slotBindings: state.slotBindings },
          ...state.appliedTargetJson === undefined ? {} : { appliedTargetJson: state.appliedTargetJson } }
      }
      if (members.some(member => member.phase === 'provisioning' || member.phase === 'retiring')) {
        throw new Error('Team composition cannot finish while a member is transitioning')
      }
      return { phase: 'fixed', appliedTargetJson: application.targetJson, profile: {
        id: application.profileId, version: application.profileVersion, modified: false,
      } }
    }
    case 'lock':
      if (state.phase !== 'dynamic') throw new Error('Team must be dynamic before locking')
      if (members.some(member => member.phase === 'provisioning' || member.phase === 'retiring')) {
        throw new Error('Team cannot lock while a member is transitioning')
      }
      return { ...state, phase: 'fixed' }
    case 'unlock':
      if (state.phase !== 'fixed') throw new Error('Team must be fixed before unlocking')
      return { ...state, phase: 'dynamic' }
  }
}

/**
 * Mark an applied Profile modified after a new member or retirement starts.
 * @param value - current optional composition value.
 * @param previous - earlier member value, absent for provisioning.
 * @param next - committed member value.
 * @returns updated composition, or the unchanged optional value for a non-composition Team.
 */
export function noteCompositionMemberChange(
  value: TeamCompositionState | undefined,
  previous: TeamMemberSnapshot | undefined,
  next: TeamMemberSnapshot,
): TeamCompositionState | undefined {
  const changed = previous === undefined || previous.phase !== 'retiring' && next.phase === 'retiring'
  if (!changed || value === undefined) return value
  return { ...value,
    ...value.profile === undefined ? {} : { profile: { ...value.profile, modified: true } },
    ...value.application === undefined ? {} : { application: { ...value.application, changed: true } },
  }
}

/**
 * Mark an applied Profile modified when a product permission table changes.
 * @param value - current optional composition value.
 * @returns updated composition, or undefined for an untouched Team.
 */
export function noteCompositionPermissionChange(value: TeamCompositionState | undefined): TeamCompositionState | undefined {
  if (value === undefined) return undefined
  return { ...value,
    ...value.profile === undefined ? {} : { profile: { ...value.profile, modified: true } },
    ...value.application === undefined ? {} : { application: { ...value.application, changed: true } },
  }
}
