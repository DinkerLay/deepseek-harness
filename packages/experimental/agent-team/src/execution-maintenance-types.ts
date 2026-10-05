/** Scoped native input maintenance; products retain operation intent and result ownership. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { AgentInput, StoredInputCustodySnapshot } from '@deepseek-ai/dsh-agent'

/** Exact current execution and optional running turn admitted by the Host preview. */
export type TeamExecutionMaintenanceTarget = {
  readonly kind: 'lead'
  readonly executionId: SessionId
  readonly term: number
  readonly turn?: number
} | {
  readonly kind: 'member'
  readonly memberId: SessionId
  readonly executionId: SessionId
  readonly generation: number
  readonly turn?: number
}

/** Additional product operation ownership remains a synchronous caller-owned check. */
export interface TeamExecutionMaintenanceRequest {
  readonly target: TeamExecutionMaintenanceTarget
  readonly assertCurrent?: () => void
}

/** Custody operations remain original-source, non-waking and tied to this callback lifetime. */
export interface TeamExecutionMaintenanceScope {
  readonly target: TeamExecutionMaintenanceTarget
  /** Aborted when the callback finishes; admitted writes are drained under their original owner. */
  readonly signal: AbortSignal
  readonly source: 'live' | 'stored' | 'absent'
  /** @returns detached actual source facts, or verified uncreated-source absence. */
  read(): StoredInputCustodySnapshot | undefined
  /** @param messageIds - exact pending selection, or undefined to capture all. @returns confirmed selected held input. */
  capture(messageIds?: readonly MessageId[]): Promise<readonly AgentInput[]>
  /** @param messageIds - held original identities to return without changing source or wake intent. */
  restore(messageIds: readonly MessageId[]): Promise<void>
  /** @param messageIds - held source identities whose explicit disposition is confirmed. */
  release(messageIds: readonly MessageId[]): Promise<void>
}
