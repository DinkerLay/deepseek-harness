/**
 * Activation-local admission around one continuable subagent's Agent inbox.
 *
 * @module @deepseek-ai/dsh-subagent/inbox
 */

import type { Agent, AgentRegistry, InputReceipt } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { SubagentPromptRequest } from './control-types.ts'
import { SubagentError } from './error.ts'

/** One Agent inbox destination, as the wire request selects it. */
export type SubagentDelivery = SubagentPromptRequest['delivery']

/** Delegate Queue and Steer to one live Agent until its Activation starts closing. */
export class SubagentInbox {
  private closingPromise: Promise<void> | undefined
  private readonly receipts = new Set<Promise<InputReceipt>>()

  /**
   * Wrap one live continuable Agent.
   * @param agent - the Agent whose inbox receives accepted deliveries.
   */
  constructor(private readonly agent: Agent,
    private readonly registry?: Pick<AgentRegistry, 'isInputControlled' | 'receiveInput'>) {}

  /**
   * Read the Activation's close transaction.
   * @returns the memoized transaction, or `undefined` while delivery remains open.
   */
  get closing(): Promise<void> | undefined {
    return this.closingPromise
  }

  /**
   * Read whether the underlying Agent still has accepted work to claim.
   * @returns whether either Agent inbox destination is non-empty.
   */
  get hasPending(): boolean {
    return this.receipts.size > 0 || this.agent.inbox.nextTurn.length > 0 || this.agent.inbox.nextStep.length > 0
  }

  /**
   * Submit through the Agent only while its Activation remains resident.
   * @param message - the accepted input to submit.
   * @param delivery - whether to queue a distinct turn or steer the nearest step.
   * @returns controlled-input durability confirmation, or undefined for synchronous delivery.
   */
  deliver(message: UserMessage, delivery: SubagentDelivery): Promise<InputReceipt> | undefined {
    if (this.closingPromise !== undefined) {
      throw new SubagentError(
        `subagent "${this.agent.id}" activation is being disposed; the message was not accepted`,
        'ACTIVATION_CLOSING',
      )
    }
    if (this.registry?.isInputControlled(this.agent.session)) {
      const receipt = this.registry.receiveInput(this.agent, { message,
        target: delivery === 'steer' ? 'next-step' : 'next-turn', wakeup: true })
      const pending = receipt.finally(() => { this.receipts.delete(pending) })
      this.receipts.add(pending)
      return pending
    }
    if (delivery === 'steer') this.agent.steer(message)
    else this.agent.followup(message)
  }

  /**
   * Close delivery synchronously and share one asynchronous release.
   * @param release - the one release operation to start after closing admission.
   * @returns the memoized release transaction.
   */
  close(release: () => Promise<void>): Promise<void> {
    const existing = this.closingPromise
    if (existing !== undefined) return existing
    const completion = Promise.withResolvers<void>()
    this.closingPromise = completion.promise
    void release().then(completion.resolve, completion.reject)
    return completion.promise
  }
}
