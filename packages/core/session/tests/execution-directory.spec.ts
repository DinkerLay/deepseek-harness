import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId, SessionSeq, executionDirectoryFromEvents, resolveSessionCwd } from '@deepseek-ai/dsh-session'

function create(id = 'worker', cwd = '/shared'): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, cwd, isSeeded: false })
}

describe('Session execution directory', () => {
  it('replays a changed execution directory without changing identity or storage cwd', () => {
    const session = create()
    expect(resolveSessionCwd(session)).toBe('/shared')
    session.append('session/execution-directory', { sessionId: session.id, cwd: '/branches/worker' })
    expect(resolveSessionCwd(session)).toBe('/branches/worker')
    expect(session.header.cwd).toBe('/shared')
    const restored = Session.fromRestore(
      session.id, structuredClone(session.snapshotEvents()), { ...session.header }, session.inheritedEventCount,
      'detached',
    )
    expect(resolveSessionCwd(restored)).toBe('/branches/worker')
    restored.append('session/execution-directory', { sessionId: restored.id, cwd: '/branches/continued' })
    expect(resolveSessionCwd(restored)).toBe('/branches/continued')
    expect(resolveSessionCwd(session)).toBe('/branches/worker')
  })

  it('does not inherit a parent execution binding through forked history', () => {
    const parent = create('parent')
    parent.append('session/execution-directory', { sessionId: parent.id, cwd: '/branches/parent' })
    const childId = SessionId('child')
    const child = Session.create(childId, parent.snapshotEvents(), { version: SESSION_FORMAT_VERSION, id: childId, createdAt: 1, cwd: '/selected-baseline', parentSession: parent.id, isSeeded: true }, parent.seq)
    expect(child.executionDirectory).toBeUndefined()
    expect(resolveSessionCwd(child)).toBe('/selected-baseline')
    child.append('session/execution-directory', { sessionId: child.id, cwd: '/branches/child' })
    expect(resolveSessionCwd(child)).toBe('/branches/child')
    expect(resolveSessionCwd(parent)).toBe('/branches/parent')
  })

  it('publishes the committed binding to observers', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('live'), { meta: { cwd: '/shared' } })
    const observed: (string | undefined)[] = []
    ctx.on('session/event', (owner, event) => {
      if (event.type === 'session/execution-directory') observed.push(resolveSessionCwd(owner))
    })
    session.append('session/execution-directory', { sessionId: session.id, cwd: '/branches/live' })
    expect(observed).toEqual(['/branches/live'])
    await ctx.fiber.dispose()
  })

  it.each(['relative', '', '/bad\0directory'])('rejects invalid persisted and appended directory %j', (cwd) => {
    const session = create()
    expect(() => session.append('session/execution-directory', { sessionId: session.id, cwd })).toThrow('absolute cwd')
    expect(() => Session.create(session.id, [{ type: 'session/execution-directory', seq: SessionSeq(0), time: 0, data: { sessionId: session.id, cwd } }], session.header)).toThrow('absolute cwd')
    expect(session.seq).toBe(0)
  })

  it('rejects a live binding naming another owner and leaves the current directory intact', () => {
    const session = create()
    expect(() => session.append('session/execution-directory', { sessionId: SessionId('foreign'), cwd: '/elsewhere' })).toThrow('another Session')
    expect(resolveSessionCwd(session)).toBe('/shared')
    expect(resolveSessionCwd(undefined)).toBeUndefined()
  })

  it('rejects a persisted non-object directory binding', () => {
    const owner = create()
    expect(() => Session.create(owner.id, [{ type: 'session/execution-directory', seq: SessionSeq(0), time: 0, data: null as never }], owner.header)).toThrow('absolute cwd')
  })

  it('forks the directory recorded at the selected prefix instead of the later binding', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const parent = ctx.sessions.create(SessionId('parent'), { meta: { cwd: '/shared' } })
    const first = parent.append('session/execution-directory', { sessionId: parent.id, cwd: '/branches/first' })
    parent.append('session/execution-directory', { sessionId: parent.id, cwd: '/branches/later' })
    expect(executionDirectoryFromEvents(parent.header, parent.snapshotEvents())).toBe('/branches/later')
    const child = ctx.sessions.fork(parent, first.seq, SessionId('historical-child'))
    expect(resolveSessionCwd(child)).toBe('/branches/first')
    expect(child.executionDirectory).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
