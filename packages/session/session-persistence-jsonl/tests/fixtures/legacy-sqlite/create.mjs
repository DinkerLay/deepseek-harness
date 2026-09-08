import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const options = JSON.parse(process.argv[2])
const require = createRequire(join(options.runtimeRoot, 'package.json'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: SessionStore, SessionId } = await load('@deepseek-ai/dsh-session')
const { default: Sqlite } = await load('@deepseek-ai/dsh-session-persistence-sqlite')
const sessionRequire = createRequire(require.resolve('@deepseek-ai/dsh-session/package.json'))
const { createUserMessage, createMessage } = await import(pathToFileURL(sessionRequire.resolve('@deepseek-ai/dsh-llm')).href)
const ctx = new Context()
try {
  await ctx.plugin(SessionStore)
  await ctx.plugin(Sqlite, { path: options.database })
  await ctx.sessionPersistence.list()
  if (!options.empty) {
    await mkdir(options.cwd, { recursive: true })
    const parent = ctx.sessions.create(SessionId('legacy-parent'), { meta: { cwd: options.cwd } })
    parent.append('session/execution-directory', { sessionId: parent.id, cwd: join(options.cwd, 'parent-worktree') })
    parent.append('turn/start', { turn: 1 })
    parent.append('step/start', { turn: 1, step: 1 })
    parent.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Legacy question' }] }), { surfaceOp: 'append' })
    for (let index = 0; index < 4; index += 1) {
      parent.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '历史资料'.repeat(1500) } })
    }
    parent.append('assistant/message', { turn: 1, step: 1, message: createMessage({
      role: 'assistant', content: [{ type: 'text', text: 'Legacy answer' }], source: { kind: 'model', provider: 'mock', model: 'mock' },
    }) }, { surfaceOp: 'append' })
    parent.append('step/end', { turn: 1, step: 1 })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    parent.append('session/title-policy', { automatic: true })
    parent.append('session/title-generation', { state: 'ready' })
    await ctx.sessions.flush(parent)
    const child = ctx.sessions.fork(parent, undefined, SessionId('legacy-child'))
    child.append('session/execution-directory', { sessionId: child.id, cwd: join(options.cwd, 'child-worktree') })
    await ctx.sessions.flush(child)
  }
  const observations = []
  for (const header of await ctx.sessionPersistence.list()) observations.push(await ctx.sessionPersistence.inspect(header.id))
  await writeFile(options.expected, JSON.stringify(observations), { flag: 'wx' })
} finally {
  await ctx.fiber.dispose()
}
