import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec, restoreReleasedV4Artifact } from '../src/index.ts'

const header = { version: 4, id: 'current', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const types = new Set(['session/execution-directory', 'session/title-generation', 'session/title-policy', 'session/end-seed'])

describe('native V4 execution and title state', () => {
  it('round trips current bindings and naming state without migration', () => {
    const events: SessionFormatEvent[] = [
      { type: 'session/execution-directory', seq: 0, time: 1, data: { sessionId: header.id, cwd: '/worktree' } },
      { type: 'session/title-policy', seq: 1, time: 2, data: { automatic: true } },
      { type: 'session/title-generation', seq: 2, time: 3, data: { state: 'generating' } },
      { type: 'session/title-generation', seq: 3, time: 4, data: { state: 'failed', error: 'cancelled' } },
      { type: 'session/title-generation', seq: 4, time: 5, data: { state: 'ready' } },
    ]
    const decoder = releasedV4SessionFormatCodec.createDecoder(releasedV4SessionFormatCodec.encodeHeader(header, 0), 'strict')
    const collector = new SessionFormatEventCollector()
    for (const event of events) decoder.decodeRow(releasedV4SessionFormatCodec.encodeEvent(event), collector)
    const cut = decoder.finish(collector)
    const restored = restoreReleasedV4Artifact({ header, events: collector.values, inheritedEventCount: cut }, types)
    expect(restored.events).toEqual(events)
  })

  it('refuses malformed native payloads before physical row recovery', () => {
    const invalid: SessionFormatEvent[] = [
      { type: 'session/execution-directory', seq: 0, time: 1, data: { sessionId: 'current', cwd: 'relative' } },
      { type: 'session/execution-directory', seq: 0, time: 1, data: { sessionId: '', cwd: '/worktree' } },
      { type: 'session/title-policy', seq: 0, time: 1, data: { automatic: 'yes' } },
      { type: 'session/title-generation', seq: 0, time: 1, data: { state: 'missing' } },
      { type: 'session/title-generation', seq: 0, time: 1, data: { state: 'ready', error: 'error' } },
      { type: 'session/title', seq: 0, time: 1, data: { inputTruncated: false } },
    ]
    for (const event of invalid) {
      const decoder = releasedV4SessionFormatCodec.createDecoder(releasedV4SessionFormatCodec.encodeHeader(header, 0), 'recoverable')
      expect(() => { decoder.decodeRow(event, new SessionFormatEventCollector()) }).toThrow()
    }
  })

  it('accepts inherited parent bindings while refusing a new foreign binding', () => {
    const event: SessionFormatEvent = {
      type: 'session/execution-directory', seq: 0, time: 1, data: { sessionId: 'parent', cwd: '/parent' },
    }
    expect(() => restoreReleasedV4Artifact({ header, events: [event], inheritedEventCount: 0 }, types)).toThrow('another Session')
    const child = { ...header, isSeeded: true, parentSession: 'parent' }
    const marker: SessionFormatEvent = { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } }
    const restored = restoreReleasedV4Artifact({ header: child, events: [event, marker], inheritedEventCount: 1 }, types)
    expect(restored.events).toEqual([event, marker])
  })
})
