/** Read-only schema for the released storage-domain message-feedback sidecar. */

import { z } from 'zod'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { MessageFeedbackItem, MessageFeedbackVersion } from './types.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** One exact item accepted by the released sidecar format. */
export const legacyMessageFeedbackItemSchema = z.object({
  messageId: z.string().min(1).transform(value => value as MessageId),
  rating: z.enum(['positive', 'negative']),
  note: z.string().refine(note => note.trim().length > 0).optional(),
  version: z.uuid().transform(value => value as MessageFeedbackVersion),
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
}).strict().refine(item => item.updatedAt >= item.createdAt, {
  path: ['updatedAt'],
  message: 'legacy message feedback updatedAt must not precede createdAt',
})

/** Persisted fields that bind a sidecar row to one Session lifecycle. */
export const legacyMessageFeedbackSessionSchema = z.object({
  createdAt: nonNegativeSafeInteger,
  cwd: z.string().optional(),
}).strict()

/** One released whole-Session sidecar row. */
export const legacyMessageFeedbackRowSchema = z.object({
  session: legacyMessageFeedbackSessionSchema,
  items: z.array(legacyMessageFeedbackItemSchema),
}).strict().superRefine((row, ctx) => {
  const messageIds = new Set<string>()
  const versions = new Set<string>()
  row.items.forEach((item, index) => {
    if (messageIds.has(item.messageId)) {
      ctx.addIssue({ code: 'custom', path: ['items', index, 'messageId'], message: 'duplicate legacy message feedback id' })
    }
    messageIds.add(item.messageId)
    if (versions.has(item.version)) {
      ctx.addIssue({ code: 'custom', path: ['items', index, 'version'], message: 'duplicate legacy message feedback version' })
    }
    versions.add(item.version)
  })
})

/** Released sidecar row after strict validation. */
export interface LegacyMessageFeedbackRow {
  readonly session: z.infer<typeof legacyMessageFeedbackSessionSchema>
  readonly items: readonly MessageFeedbackItem[]
}

/** Exact version-zero storage-domain identity used only for read-through. */
export const legacyMessageFeedbackDomainSpec = defineDomain({
  name: 'message_feedback',
  version: 0,
  tables: {
    sessions: domainTable<SessionId, LegacyMessageFeedbackRow>(
      legacyMessageFeedbackRowSchema as z.ZodType<LegacyMessageFeedbackRow>,
    ),
  },
})
