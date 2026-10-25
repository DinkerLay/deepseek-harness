/** CLI snapshot overlay for native tools beside a filtered PTC SDK. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'scoped-ptc-filter'
export const inject = ['tools', 'ptcRuntime']

/** Apply one effect-owned policy before the new agent starts its first turn. */
export function apply(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.presentAs('both', { ptcFilter: { allow: ['template_echo'] } })
  })
}
