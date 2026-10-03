import { InputControllerId } from '@deepseek-ai/dsh-agent'

export const name = 'controlled-input-fixture'
export const inject = ['agents']

export function apply(ctx, config = {}) {
  const expectedProvider = config.replayProviderName ?? 'Controlled Snapshot Replay'
  const controller = ctx.agents.registerInputController(InputControllerId('sdk-input-fixture'), {
    admit: () => ({ kind: 'accept' }),
    canStart: () => true,
    canClaim: () => true,
    initialize: session => {
      if (session.header.origin === 'subagent') return
      const providers = ctx.get('llm')?.listProviders() ?? []
      if (!providers.some(provider => provider.name === expectedProvider)) {
        throw new Error('controlled-input snapshot requires its configured replay adapter')
      }
      controller.bind(session)
    },
  })
}
