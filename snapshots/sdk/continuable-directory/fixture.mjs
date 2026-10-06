/** Authored SDK coordination: the production continuation API owns the real child directory. */
import { join } from 'node:path'

export const name = 'continuable-directory-fixture'
export const inject = ['agents', 'subagents', 'llm', 'sessions']

export function apply(ctx) {
  let root
  let started = false
  let flow
  const lifetime = new AbortController()
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Directory snapshot disposed'))
    await Promise.allSettled(flow === undefined ? [] : [flow])
  })
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.parentSession === undefined) root = agent
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (session !== root?.session || event.type !== 'turn/end' || started) return
    started = true
    flow = Promise.resolve().then(async () => {
      await root.whenIdle()
      if (!ctx.llm.listProviders().some(provider => provider.name === 'Continuable Directory Replay')) {
        throw new Error('Directory snapshot requires its keyless adapter')
      }
      await ctx.subagents.startContinuable({
        provider: 'spawn', label: 'directory-worker',
        cwd: join(root.session.header.cwd, 'worker'),
        request: { parent: root, prompt: [{ type: 'text', text: 'Reply CHILD_DIRECTORY_OK and do not call any tools.' }] },
        signal: lifetime.signal,
      })
    })
    void flow.catch(error => { ctx.logger.error(error) })
  }, { global: true })
}
