/** Optional input policy, durable custody facts, and driver-provider requests. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionLogOffset, SessionHeader, SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { UserMessage, ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { InboxTarget } from './types.ts'

/** Stable provider identity retained by a controlled Session. */
export type InputControllerId = Branded<'InputControllerId'>

/** One producer input with its effective queue and original wake intent. */
export interface AgentInput {
  readonly message: UserMessage
  readonly target: InboxTarget
  readonly wakeup: boolean
  /** Present only when the driver reclassified an aborted activity's queue. */
  readonly requestedTarget?: InboxTarget
}

/** Audited custody, retained after consumption to de-duplicate retries. */
export interface ControlledInputRecord {
  readonly input: AgentInput
  /** Original receipt identity when a pending edit changed its content or queue. */
  readonly originalInput?: AgentInput | undefined
  readonly location: 'inbox' | 'held' | 'released'
  /** Captured pending work precedes input received while admission is held. */
  readonly captured?: true | undefined
}

/** Caller-authorized changes to input that is still pending, never to model history. */
export type AgentInputMutation = { readonly kind: 'replace'; readonly messageId: MessageId; readonly content: readonly ContentBlock[] }
  | { readonly kind: 'remove' | 'steer'; readonly messageId: MessageId }

/** Host-only fold; it is audit state, not a second executable inbox. */
export interface InputControlState {
  readonly inheritedEventCount: SessionLogOffset
  readonly controllerId: InputControllerId | null
  readonly records: readonly ControlledInputRecord[]
}

/** Durable receipt says custody was confirmed, not that a model processed it. */
export interface InputReceipt {
  readonly messageId: MessageId
  readonly location: 'inbox' | 'held' | 'released'
}

/** One exact pending item exposed by the concrete stored-input driver. */
export interface StoredPendingInput {
  readonly target: InboxTarget
  readonly message: UserMessage
}

/** Non-waking operations on a detached Session's existing durable inbox. */
export interface StoredInputDriver {
  /** @returns pending input in the driver's capture order. */
  pending(): readonly StoredPendingInput[]
  /** @param messageId - pending identity already placed into held custody. @returns whether it was removed. */
  hold(messageId: MessageId): boolean
}

/** Detached original-source facts; reading these never makes the source executable. */
export interface StoredInputCustodySource {
  readonly header: Readonly<SessionHeader>
  readonly events: readonly SessionEvent[]
  readonly inheritedEventCount: SessionLogOffset
}

/** Current owned source plus reliable input custody and concrete pending work. */
export interface StoredInputCustodySnapshot extends StoredInputCustodySource {
  readonly inputControl: InputControlState
  readonly pending: readonly StoredPendingInput[]
}

/** Exclusive original-Session custody with no Agent, append or wake capability. */
export interface StoredInputCustody {
  /** @returns a detached current cut of the exclusively owned source. */
  read(): StoredInputCustodySnapshot
  /** @returns all held input after pending capture and original-writer confirmation. */
  holdPending(): Promise<readonly AgentInput[]>
  /** @param messageId - exact held identity to settle. @returns after original-writer confirmation. */
  releaseHeld(messageId: MessageId): Promise<void>
  /** @returns after admitted mutations and the original writer close; no source is awakened. */
  dispose(): Promise<void>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Optional controller binding and durable input custody facts. */
    inputControl: InputControlState
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Immutable optional policy binding; absence preserves the original driver. */
    'agent/input/controller-bound': { readonly version: 1; readonly controllerId: InputControllerId }
    /** Non-executable custody, preserving identity, source, effective queue and wake intent. */
    'agent/input/held': {
      readonly version: 1
      readonly controllerId: InputControllerId
      readonly input: AgentInput
      /** Pending-queue capture, rather than a newly arriving held input. */
      readonly captured?: true
    }
    /** Source custody settled by its registered owner; this is not a target delivery receipt. */
    'agent/input/released': { readonly version: 1; readonly controllerId: InputControllerId; readonly messageId: MessageId }
  }
}
