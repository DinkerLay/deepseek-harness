/** Loader fixture for a Session switching directories before its first file write. */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'

export const name = 'execution-directory-agent'
export const inject = ['agents', 'agentLoop', 'sessions', 'sessionPersistence', 'tools', 'llm']

/** Mount the scripted model and one ordinary Agent; the driver supplies its user input. */
export async function apply(ctx: Context): Promise<void> {
  const root = process.cwd()
  const branch = join(root, 'branch')
  ctx.llm.registerAdapter(['directory-fixture'], new MockAdapter([
    toolCallResponse('read-main', 'read', { file_path: 'baseline.txt' }),
    toolCallResponse('write-branch', 'write', { file_path: 'result.txt', content: 'branch-result' }),
    toolCallResponse('read-branch', 'read', { file_path: 'result.txt' }),
    toolCallResponse('search-branch', 'glob', { pattern: '*.txt' }),
    toolCallResponse('shell-branch', 'bash', { command: 'cat result.txt', description: 'read branch artifact from shell' }),
    textResponse('The file, search and shell tools see the branch result. The main directory is unchanged.'),
  ]))
  let isolated = false
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'write' && !isolated) {
      await mkdir(branch)
      exec.agent!.session.append('session/execution-directory', { sessionId: exec.agent!.id, cwd: branch })
      await ctx.sessions.flush(exec.agent!.session)
      isolated = true
    }
    return next()
  })
  const handle = await ctx.agents.create({ sessionId: SessionId('directory-fixture'), meta: { cwd: root }, agentOptions: { provider: 'directory-fixture', model: 'fixture' } })
  ctx.effect(() => () => handle.dispose(), 'execution-directory-agent.handle')
}
