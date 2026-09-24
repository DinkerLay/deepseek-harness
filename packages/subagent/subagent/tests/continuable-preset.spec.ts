import { describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { foldContinuablePreset } from '../src/continuable-preset.ts'

const revision = 'a'.repeat(64)
const binding = {
  type: 'subagent/continuable-preset',
  seq: SessionSeq(0),
  time: 0,
  data: { version: 1, preset: { id: 'reviewer', revision } },
} satisfies SessionEvent<'subagent/continuable-preset'>

describe('continuable child preset binding', () => {
  it('keeps older inherited-composition children unbound', () => {
    expect(foldContinuablePreset([])).toBeUndefined()
  })

  it('reads one explicit captured declaration', () => {
    expect(foldContinuablePreset([binding])).toEqual({ id: 'reviewer', revision })
  })

  it('rejects duplicate and malformed persisted bindings', () => {
    expect(() => foldContinuablePreset([binding, { ...binding, seq: SessionSeq(1) }])).toThrow('duplicate')
    expect(() => foldContinuablePreset([{ ...binding, data: {
      version: 1, preset: { id: 'reviewer', revision: 'changed' },
    } }])).toThrow()
  })
})
