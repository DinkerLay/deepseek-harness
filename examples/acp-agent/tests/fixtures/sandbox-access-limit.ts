/** Example deployment limiting every sandboxed operation to workspace writes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
export const name = 'sandbox-access-limit'
export const inject = ['sandboxPolicy']
/**
 * Install an execution limit independent of the selected permission preset.
 * @param ctx - example context owning the constraint.
 */
export function apply(ctx: Context): void {
  ctx.sandboxPolicy.registerConstraint((_request, policy) => ({
    ...policy, mode: policy.mode === 'danger-full-access' ? 'workspace-write' : policy.mode,
  }))
}
