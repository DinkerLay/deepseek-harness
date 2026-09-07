/** Example deployment policy keeping root-parent reports in its inbox without waking it. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
export const name = 'quiet-parent-delivery'
export const inject = ['subagents']
/**
 * Install this example's root-parent scheduling choice.
 * @param ctx - example context owning the policy registration.
 */
export function apply(ctx: Context): void {
  ctx.subagents.registerParentDeliveryPolicy(({ parent }) =>
    parent.session.header.parentSession === undefined ? 'quiet' : undefined)
}
