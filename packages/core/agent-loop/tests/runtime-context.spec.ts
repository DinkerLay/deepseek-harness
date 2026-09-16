import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { RuntimeContextProjection } from '../src/runtime-context.ts'

const SOURCE = '@deepseek-ai/dsh-system-prompt'

function contextMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: SOURCE },
  })
}

describe('RuntimeContextProjection', () => {
  it('restores the latest visible owned snapshot and ignores other sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('runtime-context-replay'))
    const retained = session.append('user/message', contextMessage('retained'), { surfaceOp: 'append' })
    const shadowed = session.append('user/message', contextMessage('shadowed'), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'test-compaction' },
    }), {
      surfaceOp: { op: 'replace', startSeq: shadowed.seq, endSeq: shadowed.seq },
      sourceEventSeqs: [shadowed.seq],
    })

    const projection = new RuntimeContextProjection(ctx, session, SOURCE, [])
    expect(session.surface.nodes).toContain(retained.seq)
    expect(projection.project('retained', [])).toBeUndefined()
    expect(projection.project('next', [{ name: 'sandbox:policy', text: 'policy' }])?.source).toEqual({
      kind: 'plugin',
      plugin: SOURCE,
      form: 'snapshot',
      sections: [{ name: 'sandbox:policy', text: 'policy' }],
    })

    const other = ctx.sessions.create(SessionId('runtime-context-other'))
    other.append('user/message', contextMessage('other'), { surfaceOp: 'append' })
    expect(projection.project('retained', [])).toBeUndefined()
  })
})


it('restores a previous provider snapshot and records the new identity even when its text is unchanged', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('provider-replacement'))
    const old = session.append('user/message', contextMessage('same'), { surfaceOp: 'append' })
    const source = '@example/product-prompt'
    const projection = new RuntimeContextProjection(ctx, session, source, [SOURCE])
    const next = projection.project('same', [{ name: 'policy', text: 'same' }])!
    expect(next.source).toMatchObject({ kind: 'plugin', plugin: source })
    session.append('user/message', next, { surfaceOp: 'append' })
    expect(projection.project('same', [])).toBeUndefined()
    expect(old.data.source).toMatchObject({ plugin: SOURCE })
    const restored = new RuntimeContextProjection(ctx, session, source, [SOURCE])
    expect(restored.project('same', [])).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})

it('does not claim a foreign provider when clearing an empty current context', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('foreign-provider'))
    session.append('user/message', contextMessage('foreign'), { surfaceOp: 'append' })
    const projection = new RuntimeContextProjection(ctx, session, '@example/other-prompt', [])
    expect(projection.project('', [])).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})
