/** Durable Host ownership and idempotent inbox delivery for delegated executions. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ChildComposition } from './child-agent.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from './continuation-messages.ts'

/** Stable identity of the Host controller, not a parent Agent execution. */
export type DelegationOwnerId = Branded<'delegation-owner'>
/** Brand an owner admitted by the Host controller.
 * @param value - stable controller identity.
 * @returns the branded identity; authorization remains the controller's responsibility.
 */
export function DelegationOwnerId(value: string): DelegationOwnerId { return brandString<DelegationOwnerId>(value) }
/** Durable delivery identity assigned before an outbox effect runs. */
export type DelegationRequestId = Branded<'delegation-request'>
/** Brand an admitted outbox request.
 * @param value - unique request identity within the execution.
 * @returns the branded identity.
 */
export function DelegationRequestId(value: string): DelegationRequestId { return brandString<DelegationRequestId>(value) }

/** Derive the durable message identity from its owner and outbox identity.
 * @param ownerId - durable execution owner.
 * @param requestId - unique delivery request.
 * @returns the same stable identity for every retry.
 */
export function delegationMessageId(ownerId: DelegationOwnerId, requestId: DelegationRequestId): MessageId {
  return MessageId(`delegated:${createHash('sha256').update(JSON.stringify([ownerId, requestId])).digest('hex')}`)
}

/** Fingerprint the actual sender and text, without widening the persisted MessageSource union.
 * @param senderSessionId - Agent execution that authored the message.
 * @param text - complete message text.
 * @returns the delivery content digest.
 */
export function delegationMessageDigest(senderSessionId: SessionId, text: string): string {
  return createHash('sha256').update(JSON.stringify([senderSessionId, [{ type: 'text', text }]])).digest('hex')
}

const descriptorSchema = z.object({
  version: z.literal(1), ownerId: z.string().min(1).transform(DelegationOwnerId),
  presetId: z.string().min(1), presetRevision: z.string().regex(/^[a-f0-9]{64}$/),
  options: z.object({
    provider: z.string().optional(), model: z.string().optional(),
    reasoningEffort: z.string().transform(ReasoningEffortId).optional(),
    maxTokens: z.number().int().positive().optional(), subagentDepth: z.number().int().positive(),
  }).strict(),
  composition: z.object({
    persona: z.string().optional(),
    toolFilter: z.object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() }).strict().optional(),
  }).strict(),
}).strict().transform((value): HostDelegatedDescriptor => ({
  ...value,
  options: {
    subagentDepth: value.options.subagentDepth,
    ...(value.options.provider === undefined ? {} : { provider: value.options.provider }),
    ...(value.options.model === undefined ? {} : { model: value.options.model }),
    ...(value.options.reasoningEffort === undefined ? {} : { reasoningEffort: value.options.reasoningEffort }),
    ...(value.options.maxTokens === undefined ? {} : { maxTokens: value.options.maxTokens }),
  },
  composition: {
    ...(value.composition.persona === undefined ? {} : { persona: value.composition.persona }),
    ...(value.composition.toolFilter === undefined ? {} : { toolFilter: {
      ...(value.composition.toolFilter.allow === undefined ? {} : { allow: value.composition.toolFilter.allow }),
      ...(value.composition.toolFilter.deny === undefined ? {} : { deny: value.composition.toolFilter.deny }),
    } }),
  },
}))

/** Versioned creation configuration; permissions are recorded separately by delegation policy events. */
export interface HostDelegatedDescriptor {
  readonly version: 1
  readonly ownerId: DelegationOwnerId
  readonly presetId: string
  readonly presetRevision: string
  readonly options: Pick<AgentOptions, 'provider' | 'model' | 'reasoningEffort' | 'maxTokens'> & { subagentDepth: number }
  readonly composition: ChildComposition
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Required owner/configuration record. Ordinary parent-owned continuation cannot adopt this execution. */
    'subagent/host-owned': HostDelegatedDescriptor
    /** Permanent end of Host delivery admission; transcript and previous messages remain readable. */
    'subagent/host-retired': { ownerId: DelegationOwnerId }
  }
}

const stateSchema = z.object({
  descriptor: descriptorSchema.nullable(), retired: z.boolean(),
  deliveries: z.record(z.string(), z.object({ messageId: z.string().transform(MessageId), digest: z.string() })),
})
/** Host-only ownership projection; not a client authorization receipt. */
export type HostDelegatedState = z.infer<typeof stateSchema>
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { hostDelegation: HostDelegatedState }
}

/** Owner configuration and accepted delivery ids reconstructed before resumed Agent publication. */
export const hostDelegationProjection = {
  key: 'hostDelegation', stateVersion: 1, stateSchema,
  init: () => ({ descriptor: null, retired: false, deliveries: {} }),
  apply: (state, event) => {
    if (event.type === 'subagent/host-owned') {
      if (state.descriptor !== null) throw new Error('Duplicate Host delegation descriptor')
      return { ...state, descriptor: descriptorSchema.parse(event.data) }
    }
    if (event.type === 'subagent/host-retired') {
      if (state.descriptor?.ownerId !== event.data.ownerId) throw new Error('Host delegation retirement owner mismatch')
      return { ...state, retired: true }
    }
    if (event.type !== 'agent/inbox/spliced') return state
    let deliveries = state.deliveries
    for (const message of event.data.inserted) {
      const source = message.source
      if (source.kind !== 'agent-message' || !message.id.startsWith('delegated:')) continue
      if (state.descriptor === null || state.retired) throw new Error('Invalid Host delegation delivery')
      const digest = createHash('sha256').update(JSON.stringify([source.senderSessionId, message.content])).digest('hex')
      const existing = deliveries[message.id]
      if (existing !== undefined && existing.digest !== digest) {
        throw new Error('Host delegation request identity conflict')
      }
      deliveries = { ...deliveries, [message.id]: { messageId: message.id, digest } }
    }
    return deliveries === state.deliveries ? state : { ...state, deliveries }
  },
} satisfies ProjectionDefinition<'hostDelegation', HostDelegatedState>
