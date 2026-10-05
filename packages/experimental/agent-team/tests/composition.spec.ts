import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyCompositionTransition, compositionOf, noteCompositionMemberChange,
  noteCompositionPermissionChange } from '../src/composition.ts'
import type { TeamCompositionState, TeamMemberSnapshot } from '../src/types.ts'

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

  it('checks the complete UTF-8 target and rejects duplicate or retired retirement identities', () => {
    const begin = { kind: 'begin' as const, applicationId: 'bounded', profileId: 'profile', profileVersion: 1,
      targetJson: JSON.stringify('x'.repeat(262_142)), retiringMemberIds: [], previousPhase: 'dynamic' as const }
    expect(applyCompositionTransition(undefined, begin, []).application?.targetJson).toBe(begin.targetJson)
    expect(() => applyCompositionTransition(undefined, { ...begin, targetJson: JSON.stringify('文'.repeat(90_000)) }, []))
      .toThrow(/maximum event size/)
    expect(() => applyCompositionTransition(undefined, { ...begin, targetJson: '{}',
      retiringMemberIds: [member.id, member.id] }, [member])).toThrow(/same member twice/)
    expect(() => applyCompositionTransition(undefined, { ...begin, targetJson: '{}',
      retiringMemberIds: [member.id] }, [{ ...member, phase: 'retired' }])).toThrow(/not present/)
    expect(() => applyCompositionTransition({ phase: 'fixed' }, { ...begin, targetJson: '{}' }, []))
      .toThrow(/changed before/)
  })

  it('rejects stale application changes and cannot lock an already fixed Team', () => {
    const applying = applyCompositionTransition(undefined, { kind: 'begin', applicationId: 'current', profileId: 'profile',
      profileVersion: 1, targetJson: '{}', retiringMemberIds: [], previousPhase: 'dynamic' }, [])
    for (const kind of ['target', 'diagnostic', 'stop', 'finish'] as const) {
      const transition = kind === 'target' ? { kind, applicationId: 'other', targetJson: '{}' }
        : kind === 'diagnostic' ? { kind, applicationId: 'other', message: 'not this application' }
          : { kind, applicationId: 'other' }
      expect(() => applyCompositionTransition(applying, transition, [])).toThrow(/not current/)
      expect(() => applyCompositionTransition(undefined, transition, [])).toThrow(/not current/)
    }
    expect(() => applyCompositionTransition({ phase: 'applying' }, { kind: 'stop', applicationId: 'missing' }, []))
      .toThrow(/not current/)
    expect(() => applyCompositionTransition({ phase: 'fixed' }, { kind: 'lock' }, [])).toThrow(/dynamic before locking/)
  })

  it('updates only the current application target and retains earlier Profile/slot facts when stopped', () => {
    const previous: TeamCompositionState = { phase: 'fixed', profile: { id: 'old-profile', version: 1, modified: false },
      appliedTargetJson: '{"old":true}', slotBindings: [{ slotId: 'research', memberId: member.id }] }
    const applying = applyCompositionTransition(previous, { kind: 'begin', applicationId: 'replacement', profileId: 'new-profile',
      profileVersion: 2, targetJson: '{"new":1}', retiringMemberIds: [], previousPhase: 'fixed' }, [member])
    const target = applyCompositionTransition(applying, { kind: 'target', applicationId: 'replacement', targetJson: '{"new":2}' }, [member])
    expect(target.application?.targetJson).toBe('{"new":2}')
    expect(applying.application?.targetJson).toBe('{"new":1}')
    expect(() => applyCompositionTransition(target, { kind: 'target', applicationId: 'replacement', targetJson: '{' }, []))
      .toThrow(/not JSON/)
    const diagnostic = applyCompositionTransition(target, { kind: 'diagnostic', applicationId: 'replacement', message: 'waiting for cleanup' }, [])
    expect(diagnostic.application?.diagnostic).toBe('waiting for cleanup')
    const stopped = applyCompositionTransition(diagnostic, { kind: 'stop', applicationId: 'replacement' }, [])
    expect(stopped).toEqual(previous)
    const changed = noteCompositionPermissionChange(diagnostic)
    expect(changed?.application?.changed).toBe(true)
    expect(changed?.profile?.modified).toBe(true)
    expect(applyCompositionTransition(changed, { kind: 'stop', applicationId: 'replacement' }, []))
      .toEqual({ ...previous, phase: 'dynamic', profile: { ...previous.profile, modified: true } })
    expect(noteCompositionPermissionChange(undefined)).toBeUndefined()
    expect(noteCompositionPermissionChange({ phase: 'dynamic' })).toEqual({ phase: 'dynamic' })
    expect(noteCompositionMemberChange(applying, { ...member, phase: 'provisioning' }, member)).toBe(applying)
    expect(noteCompositionMemberChange(undefined, undefined, member)).toBeUndefined()
  })
})
