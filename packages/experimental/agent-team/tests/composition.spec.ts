import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyCompositionTransition, compositionOf, noteCompositionMemberChange,
  noteCompositionPermissionChange } from '../src/composition.ts'
import type { TeamMemberSnapshot } from '../src/types.ts'

const member: TeamMemberSnapshot = { id: SessionId('worker'), name: 'worker', description: 'research',
  provider: 'spawn', context: 'fresh', phase: 'active' }

describe('native Team composition policy', () => {
  it('leaves an untouched official Team dynamic and user locks independent of a Profile', () => {
    expect(compositionOf(undefined)).toEqual({ phase: 'dynamic' })
    const fixed = applyCompositionTransition(undefined, { kind: 'lock' }, [member])
    expect(fixed).toEqual({ phase: 'fixed' })
    expect(applyCompositionTransition(fixed, { kind: 'unlock' }, [member])).toEqual({ phase: 'dynamic' })
    expect(() => applyCompositionTransition(undefined, { kind: 'unlock' }, [])).toThrow(/fixed/)
    expect(() => applyCompositionTransition(undefined, { kind: 'lock' }, [{ ...member, phase: 'retiring' }]))
      .toThrow(/transitioning/)
  })

  it('records one target, detects changes, and stops without rolling them back', () => {
    const begin = { kind: 'begin' as const, applicationId: 'application-1', profileId: 'profile-1',
      profileVersion: 2, targetJson: '{}', retiringMemberIds: [member.id], previousPhase: 'dynamic' as const }
    const applying = applyCompositionTransition(undefined, begin, [member])
    expect(applying).toMatchObject({ phase: 'applying', application: { id: 'application-1', changed: false } })
    expect(applyCompositionTransition(applying, { kind: 'stop', applicationId: 'application-1' }, [member]))
      .toEqual({ phase: 'dynamic' })
    const changed = noteCompositionMemberChange(applying, member, { ...member, phase: 'retiring' })!
    expect(changed.application?.changed).toBe(true)
    expect(applyCompositionTransition(changed, { kind: 'stop', applicationId: 'application-1' }, []))
      .toEqual({ phase: 'dynamic' })
    expect(() => applyCompositionTransition(applying, { ...begin, applicationId: 'other' }, [member]))
      .toThrow(/changed/)
  })

  it('finishes a replacement, tracks later changes, and rejects unfinished transitions', () => {
    const applying = applyCompositionTransition(undefined, { kind: 'begin', applicationId: 'a',
      profileId: 'stock', profileVersion: 1, targetJson: '{"roles":[]}', retiringMemberIds: [],
      previousPhase: 'dynamic' }, [])
    expect(() => applyCompositionTransition(applying, { kind: 'finish', applicationId: 'a' },
      [{ ...member, phase: 'provisioning' }])).toThrow(/transitioning/)
    const fixed = applyCompositionTransition(applying, { kind: 'finish', applicationId: 'a' }, [member])
    expect(fixed).toEqual({ phase: 'fixed', appliedTargetJson: '{"roles":[]}',
      profile: { id: 'stock', version: 1, modified: false } })
    const unlocked = applyCompositionTransition(fixed, { kind: 'unlock' }, [member])
    expect(unlocked.profile?.modified).toBe(false)
    expect(noteCompositionPermissionChange(unlocked)?.profile?.modified).toBe(true)
    expect(noteCompositionMemberChange(unlocked, undefined, { ...member, id: SessionId('next') })?.profile?.modified)
      .toBe(true)
  })

  it('rejects a malformed target and an unknown retirement member before recording the transition', () => {
    const begin = { kind: 'begin' as const, applicationId: 'a', profileId: 'p',
      profileVersion: 1, targetJson: '{', retiringMemberIds: [], previousPhase: 'dynamic' as const }
    expect(() => applyCompositionTransition(undefined, begin, [])).toThrow(/not JSON/)
    expect(() => applyCompositionTransition(undefined, { ...begin, targetJson: '{}',
      retiringMemberIds: [SessionId('absent')] }, [])).toThrow(/not present/)
  })
})
