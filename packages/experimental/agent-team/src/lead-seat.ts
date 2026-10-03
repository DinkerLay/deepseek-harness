/** Durable Lead bindings and their atomic Team transition; no product workflow is interpreted here. */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamExtensionNotice, TeamPeerMessageSnapshot, TeamTaskTransactionUpdate } from './types.ts'
import { TeamId } from './types.ts'

/** One committed Lead execution and its immutable composition. */
export interface TeamLeadBinding {
  readonly executionId: SessionId
  readonly term: number
  readonly presetId: string
  readonly revision: string
}

/** Initial or committed Lead seat selected from the stable Team journal. */
export interface TeamLeadSeat {
  readonly executionId: SessionId
  readonly term: number
  readonly presetId?: string
  readonly revision?: string
}

/** One atomic seat change, opaque product record, Task updates and queued notices. */
export interface TeamLeadTransaction {
  readonly version: 1
  readonly teamId: TeamId
  readonly previousTerm: number
  readonly binding: TeamLeadBinding
  readonly extension: { readonly id: string; readonly dataJson: string }
  readonly releases: readonly TeamTaskTransactionUpdate[]
  readonly notices?: readonly TeamPeerMessageSnapshot[]
}

/** Authenticated coordinator plan; notices are framed by the native mailbox before writing. */
export interface TeamLeadCommitPlan {
  readonly previousTerm: number
  readonly binding: TeamLeadBinding
  readonly dataJson: string
  readonly releases: readonly TeamTaskTransactionUpdate[]
  readonly notices?: readonly TeamExtensionNotice[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Atomic stable-seat replacement and its native Team work. */
    'team/lead/transaction': TeamLeadTransaction
  }
}

/** Strict decoder for bindings loaded from persisted Team state. */
export const teamLeadBindingSchema: z.ZodType<TeamLeadBinding> = z.object({
  executionId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  term: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  presetId: z.string().min(1),
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()
