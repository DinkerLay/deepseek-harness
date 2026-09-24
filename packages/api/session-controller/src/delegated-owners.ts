/** Explicit Host execution owners for delegated Sessions opened in the ordinary Client. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** A Host controller retains execution ownership; SessionController only routes to it. */
export interface DelegatedSessionOwner {
  /** Diagnostic name of the registering controller. */
  readonly name: string
  /** Current access to this exact physical identity; historical executions can remain read-only. */
  access(sessionId: SessionId): 'active' | 'readonly' | undefined
  /** Resume through the controller's own factory/handle, never ordinary Session adoption. */
  resolve(sessionId: SessionId): Promise<Agent>
  /** Recheck lifecycle/epoch and distinguish control lookup from direct user prompt admission. */
  assertWritable(agent: Agent, operation: 'lookup' | 'prompt'): void
}

/** Registration, exclusive claims and post-await admission for delegated execution owners. */
export class DelegatedSessionOwners {
  private readonly owners = new Set<{ owner: DelegatedSessionOwner }>()
  constructor(private readonly ctx: Context) {}

  /** Add one registration generation.
   * @param owner - physical identity controller.
   * @returns disposer for this generation only.
   */
  register(owner: DelegatedSessionOwner): () => void {
    if ([...this.owners].some(value => value.owner.name === owner.name)) throw new Error(`Delegated owner already registered: ${owner.name}`)
    const registration = { owner }
    this.owners.add(registration)
    return () => { this.owners.delete(registration) }
  }

  private claim(sessionId: SessionId) {
    let found: { registration: { owner: DelegatedSessionOwner }; access: 'active' | 'readonly' } | undefined
    for (const registration of this.owners) {
      const { owner } = registration
      const access = owner.access(sessionId)
      if (access === undefined) continue
      if (found) this.reject('Multiple controllers claim this delegated Session')
      found = { registration, access }
    }
    return found
  }

  /** Read exclusive access without activating an execution.
   * @param sessionId - exact physical identity.
   * @returns current access, or undefined when no controller claims it.
   */
  access(sessionId: SessionId): 'active' | 'readonly' | undefined { return this.claim(sessionId)?.access }

  /** Resume through the admitted owner, checking its registration again after the await.
   * @param sessionId - exact physical identity.
   * @returns the owner's current Agent, or undefined for an unclaimed identity.
   */
  resolve(sessionId: SessionId): Promise<Agent> | undefined {
    const claim = this.claim(sessionId)
    if (!claim) return undefined
    if (claim.access !== 'active') this.reject('This delegated execution is read-only')
    return claim.registration.owner.resolve(sessionId).then((agent) => {
      if (agent.id !== sessionId || this.claim(sessionId)?.registration !== claim.registration) this.reject('Delegated execution ownership changed during resume')
      this.assertWritable(agent)
      return agent
    })
  }

  /** Reject retired, superseded, unclaimed or nonresident delegated execution writes.
   * @param agent - exact execution receiving the pending input.
   * @param operation - lookup for control access, or prompt immediately before direct user input.
   */
  assertWritable(agent: Agent, operation: 'lookup' | 'prompt' = 'lookup'): void {
    const claim = this.claim(agent.id)
    if (!claim) {
      if (agent.session.header.origin === 'subagent') this.reject('Use the registered owner for this delegated Session')
      return
    }
    if (claim.access !== 'active' || agent.session.header.origin !== 'subagent'
      || this.ctx.agents.get(agent.id) !== agent) this.reject('Delegated execution is no longer writable')
    claim.registration.owner.assertWritable(agent, operation)
  }

  private reject(reason: string): never {
    throw new RemoteError('session/agent-busy', reason, { reason })
  }
}
