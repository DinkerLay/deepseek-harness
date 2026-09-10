import { describe, expect, it } from 'vitest'
import { reconstructRc2ChunkProvenance } from '../src/legacy-sqlite-provenance.ts'

function chunk(seq: number, turn = 1, step = 1) {
  return { type: 'assistant/chunk', seq, time: seq, data: { turn, step, chunk: { type: 'text-delta', index: 0, text: 'part' } } }
}

function message(seq: number, options: {
  turn?: number
  step?: number
  sourceEventSeqs?: readonly number[]
  sourceKind?: string
  content?: string
} = {}) {
  return {
    type: 'assistant/message', seq, time: seq,
    data: {
      turn: options.turn ?? 1,
      step: options.step ?? 1,
      message: {
        id: 'answer', role: 'assistant', content: [{ type: 'text', text: options.content ?? 'partpart' }],
        source: { kind: options.sourceKind ?? 'model', provider: 'provider', model: 'model' },
      },
    },
    surfaceOp: 'append',
    ...(options.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: options.sourceEventSeqs }),
  }
}

describe('recorded rc2 SQLite chunk provenance', () => {
  it('reconstructs one exact immediate chunk run without mutating the reader values', () => {
    const events = [chunk(4), chunk(5), message(6)]
    const output = reconstructRc2ChunkProvenance(events)
    expect(output).toEqual([chunk(4), chunk(5), { ...message(6), sourceEventSeqs: [4, 5] }])
    expect(events[2]).not.toHaveProperty('sourceEventSeqs')
  })

  it('preserves matching provenance and messages without an immediate chunk run', () => {
    const matching = message(6, { sourceEventSeqs: [4, 5] })
    expect(reconstructRc2ChunkProvenance([chunk(4), chunk(5), matching])[2]).toBe(matching)
    const plain = message(1, { content: 'answer' })
    expect(reconstructRc2ChunkProvenance([plain])).toEqual([plain])
  })

  it.each([
    ['a sequence gap', [chunk(3), chunk(5), message(6)], /sequence has a gap/u],
    ['a cross-step chunk', [chunk(4), chunk(5, 1, 2), message(6)], /another turn or step/u],
    ['conflicting provenance', [chunk(4), chunk(5), message(6, { sourceEventSeqs: [5] })], /provenance conflicts/u],
    ['a non-model final message', [chunk(4), chunk(5), message(6, { sourceKind: 'plugin' })], /source is not a model/u],
    ['content that disagrees with chunks', [chunk(4), chunk(5), message(6, { content: 'different' })], /disagrees with its chunks/u],
  ])('refuses %s', (_label, events, expected) => {
    expect(() => reconstructRc2ChunkProvenance(events)).toThrow(expected as RegExp)
  })
})
