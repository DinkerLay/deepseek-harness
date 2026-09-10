import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceFiles from '../src/index.ts'

const CAPS = {
  maxBytes: 1024,
  maxFileBytes: 1024,
  maxLines: 100,
  maxEntries: 100,
}

function header(id: SessionId, cwd?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
    origin: 'subagent',
    ...cwd === undefined ? {} : { cwd },
  }
}

describe('Workspace Files Session scope lookup', () => {
  it('uses live or cold execution directories without an Agent and leaves with its plugin', async () => {
    const liveId = SessionId('live-subagent')
    const coldId = SessionId('cold-subagent')
    const fallbackId = SessionId('cold-without-cwd')
    const missingId = SessionId('missing')
    const liveRoot = resolve('live-workspace')
    const liveExecutionRoot = resolve('live-execution')
    const coldRoot = resolve('cold-workspace')
    const coldExecutionRoot = resolve('cold-execution')
    const fallbackRoot = resolve('fallback-workspace')
    const observeSession = vi.fn(async (id: SessionId) => {
      if (id === missingId) {
        throw new SessionQueryError('missing', 'SESSION_QUERY_SESSION_NOT_FOUND')
      }
      const storedHeader = id === coldId ? header(coldId, coldRoot) : header(fallbackId)
      const events = id === coldId ? [{
        type: 'session/execution-directory' as const,
        seq: SessionSeq(0),
        time: 1,
        data: { sessionId: coldId, cwd: coldExecutionRoot },
      }] : []
      return {
        source: 'persistence',
        header: storedHeader,
        events,
        inheritedEventCount: SessionLogOffset(0),
        [Symbol.dispose]() {},
      }
    })
    const ctx = new Context()
    ctx.provide('fs', {} as never)
    ctx.provide('sandboxPolicy', { workspaceRoot: fallbackRoot } as never)
    ctx.provide('sessionQuery', { observeSession } as never)
    const sessions = await ctx.plugin(SessionStore)
    const typert = await ctx.plugin(TypertRegistry)
    const workspaceFiles = await ctx.plugin(WorkspaceFiles, CAPS)

    try {
      const live = ctx.sessions.create(liveId, { meta: { cwd: liveRoot, origin: 'subagent' } })
      live.append('session/execution-directory', { sessionId: liveId, cwd: liveExecutionRoot })
      expect(ctx.get('agents')).toBeUndefined()
      const lookup = ctx.typert.lookups.get('workspaceFileScope')
      expect(lookup).toMatchObject({
        parameter: 'workspaceFileScope',
        wire: 'workspaceFileScopeId',
        hostTypeSymbol: '@deepseek-ai/dsh-api-workspace-files#WorkspaceFileScope',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      })
      if (lookup === undefined) throw new Error('workspaceFileScope lookup did not register')

      await expect(lookup.resolve(liveId)).resolves.toEqual({ sessionId: liveId, workspaceRoot: liveExecutionRoot })
      expect(observeSession).not.toHaveBeenCalled()
      await expect(lookup.resolve(coldId)).resolves.toEqual({ sessionId: coldId, workspaceRoot: coldExecutionRoot })
      await expect(lookup.resolve(fallbackId)).resolves.toEqual({ sessionId: fallbackId, workspaceRoot: fallbackRoot })
      await expect(lookup.resolve(missingId)).resolves.toBeUndefined()
      expect(observeSession.mock.calls.map(([id]) => id)).toEqual([coldId, fallbackId, missingId])

      await workspaceFiles.dispose()
      expect(ctx.typert.lookups.get('workspaceFileScope')).toBeUndefined()
    } finally {
      await workspaceFiles.dispose()
      await sessions.dispose()
      await typert.dispose()
    }
  })
})
