/** Team state projected incrementally from committed Session events, with a durable-only client view. */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AgentInput } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq, SessionId as toSessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {
  TeamCompositionState,
  TeamCompositionTransition,
  TeamCompositionView,
  TeamControlledMode,
  TeamId,
  TeamMemberProjection,
  TeamMemberLegacySnapshot,
  TeamMemberSnapshot,
  TeamMessageId,
  TeamMessageCancellation,
  TeamMessageSnapshot,
  TeamProjection,
  TeamTaskSnapshot,
  TeamTaskId,
  TeamTaskTransactionUpdate,
  TeamTaskView,
  TeamLeadDeliveryReceipt,
} from './types.ts'
import { applyCompositionTransition, noteCompositionMemberChange, noteCompositionPermissionChange } from './composition.ts'
import {
  TeamId as toTeamId,
  TeamMessageId as toTeamMessageId,
  TeamTaskId as toTeamTaskId,
  TeamLeadOperationId,
} from './types.ts'
import { assertTaskGraphCandidate } from './task-graph.ts'
import { applyTaskTransaction } from './task-transaction.ts'
import { projectTaskView } from './task-view.ts'
import { teamLeadBindingSchema } from './lead-seat.ts'
import type { TeamLeadBinding } from './lead-seat.ts'
import { applyLeadTransition, leadCoordinationActive, teamLeadCoordinationSchema, teamLeadTransitionSchema } from './lead-coordination.ts'
import type { TeamLeadCoordination } from './lead-coordination.ts'
import { applyMemberControl, applyMemberExecution, currentMemberExecution, memberExecutionOwner, memberExecutionStarted,
  teamMemberControlSchema, teamMemberDeliverySchema, teamMemberExecutionRecordSchema,
  teamMemberExecutionSchema } from './member-execution.ts'
import type { TeamMemberDeliveryReceipt, TeamMemberExecutionRecord, TeamMemberExecutionControl } from './member-execution.ts'
import { applyMemberSlotTransfer, currentMemberSlot, teamMemberSlotTransferSchema, teamProfileSlotSchema } from './member-slots.ts'
import type { TeamMemberSlotTransfer } from './member-slots.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveSafeInteger = nonNegativeSafeInteger.min(1)
const sessionIdSchema = z.string().min(1).transform(value => brandString<SessionId>(value))
const teamIdSchema = z.string().min(1).transform(value => toTeamId(value))
const numericTaskIdPattern = /^task-(\d+)$/u
const teamTaskIdSchema = z.string().min(1).refine((value) => {
  const match = numericTaskIdPattern.exec(value)
  return match === null || Number.isSafeInteger(Number(match[1]))
}, { message: 'numeric task id suffix must be a safe integer' }).transform(value => toTeamTaskId(value))
const teamMessageIdSchema = z.string().min(1).transform(value => toTeamMessageId(value))

const coreContentBlockTypes = new Set(['text', 'reasoning', 'image', 'tool-call', 'tool-result'])
const imageAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: nonNegativeSafeInteger,
  width: positiveSafeInteger,
  height: positiveSafeInteger,
  name: z.string().optional(),
}).strict()

// Validate the listed variants; retired tool-result tags cannot enter the
// merge-extensible fallback for JSON-decoded plugin content.
const contentBlockSchema: z.ZodType<ContentBlock> = z.lazy(() => z.union([
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('reasoning'), text: z.string() }).strict(),
  z.object({ type: z.literal('image'), attachment: imageAttachmentSchema }).strict(),
  z.object({
    type: z.literal('tool-call'),
    id: z.string().min(1),
    name: z.string(),
    arguments: z.string(),
  }).strict(),
  // Keep unknown JSON objects by reference; loose-object parsing drops their own __proto__ keys.
  z.custom<ContentBlock>((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const type = (value as { type?: unknown }).type
    return typeof type === 'string' && type.length > 0 && !coreContentBlockTypes.has(type)
  }),
])) as z.ZodType<ContentBlock>

const teamMemberFields = {
  id: sessionIdSchema,
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  context: z.enum(['fresh', 'fork']),
  error: z.string().optional(),
}
const legacyTeamMemberSnapshotSchema = z.object({
  ...teamMemberFields,
  phase: z.enum(['provisioning', 'active', 'failed']),
}).strict() as z.ZodType<TeamMemberLegacySnapshot>
const teamMemberSnapshotSchema = z.object({
  ...teamMemberFields,
  phase: z.enum(['provisioning', 'active', 'failed', 'retiring', 'retired']),
  group: z.string().min(1).max(64).optional(),
  preset: z.object({
    id: z.string().min(1),
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict().optional(),
  slotId: z.string().min(1).max(200).optional(),
}).strict() as z.ZodType<TeamMemberSnapshot>

const teamProfileAssociationSchema = z.object({
  id: z.string().min(1).max(200), version: positiveSafeInteger, modified: z.boolean(),
}).strict()
const teamCompositionApplicationSchema = z.object({
  id: z.string().min(1).max(200), profileId: z.string().min(1).max(200),
  profileVersion: positiveSafeInteger, targetJson: z.string().min(1),
  retiringMemberIds: z.array(sessionIdSchema), previousPhase: z.enum(['dynamic', 'fixed']),
  changed: z.boolean(), diagnostic: z.string().min(1).max(2_000).optional(),
}).strict()
const teamCompositionStateSchema = z.object({
  phase: z.enum(['dynamic', 'applying', 'fixed']),
  profile: teamProfileAssociationSchema.optional(),
  application: teamCompositionApplicationSchema.optional(),
  appliedTargetJson: z.string().min(1).optional(),
  slotBindings: z.array(teamProfileSlotSchema).optional(),
}).strict() as z.ZodType<TeamCompositionState>
const teamCompositionTransitionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('begin'), applicationId: z.string().min(1).max(200),
    profileId: z.string().min(1).max(200), profileVersion: positiveSafeInteger,
    targetJson: z.string().min(1), retiringMemberIds: z.array(sessionIdSchema),
    previousPhase: z.enum(['dynamic', 'fixed']) }).strict(),
  z.object({ kind: z.literal('target'), applicationId: z.string().min(1).max(200), targetJson: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('diagnostic'), applicationId: z.string().min(1).max(200),
    message: z.string().min(1).max(2_000) }).strict(),
  z.object({ kind: z.literal('finish'), applicationId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('stop'), applicationId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('lock') }).strict(),
  z.object({ kind: z.literal('unlock') }).strict(),
]) as z.ZodType<TeamCompositionTransition>
const teamCompositionEventSchema = z.object({
  version: z.literal(1), teamId: teamIdSchema, transition: teamCompositionTransitionSchema,
}).strict() as z.ZodType<SessionEventMap['team/composition']>

const teamTaskSnapshotSchema = z.object({
  id: teamTaskIdSchema,
  revision: positiveSafeInteger,
  subject: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
  ownerId: sessionIdSchema.optional(),
  blockedBy: z.array(teamTaskIdSchema),
  writeScopes: z.array(z.string()),
  resultUnavailable: z.literal(true).optional(),
}).strict() as z.ZodType<TeamTaskSnapshot>

const teamMessageSnapshotSchema = z.object({
  id: teamMessageIdSchema,
  senderId: sessionIdSchema,
  senderName: z.string(),
  targetId: sessionIdSchema,
  content: z.array(contentBlockSchema),
  contentParts: z.array(z.enum(['sender', 'fact'])).optional(),
  senderTerm: positiveSafeInteger.optional(),
  contentAuthors: z.array(z.object({ executionId: sessionIdSchema, term: positiveSafeInteger }).strict().nullable()).optional(),
  transfer: z.object({ sourceExecutionId: sessionIdSchema, heldSeq: nonNegativeSafeInteger.transform(SessionSeq),
    input: z.custom<AgentInput>((value) => {
      if (value === null || typeof value !== 'object' || !('message' in value)) return false
      const item = value as Record<string, unknown>
      const message = item.message
      if (message === null || typeof message !== 'object') return false
      const data = message as Record<string, unknown>
      const source = data.source
      return typeof data.id === 'string' && data.id.length > 0 && data.role === 'user'
        && Array.isArray(data.content) && z.array(contentBlockSchema).safeParse(data.content).success
        && source !== null && typeof source === 'object' && 'kind' in source && typeof source.kind === 'string'
        && (item.target === 'next-step' || item.target === 'next-turn') && typeof item.wakeup === 'boolean'
        && (item.requestedTarget === undefined || item.requestedTarget === 'next-step' || item.requestedTarget === 'next-turn')
    }),
  }).strict().optional(),
}).strict() as z.ZodType<TeamMessageSnapshot>

const ordinaryTeamMessageSnapshotSchema = teamMessageSnapshotSchema.refine(message => message.transfer === undefined,
  'source input custody requires the native input-queued event')

const teamEventSelectorSchema = z.object({
  version: nonNegativeSafeInteger,
  teamId: teamIdSchema,
}).loose()

const teamMemberEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  member: legacyTeamMemberSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/member']>

const teamMemberConfiguredEventSchema = z.object({
  version: z.literal(3),
  teamId: teamIdSchema,
  member: teamMemberSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/member/configured']>

const teamMemberExecutionEventSchema = z.object({
  version: z.literal(1), teamId: teamIdSchema,
  operationId: z.string().min(1).max(200), previousGeneration: positiveSafeInteger,
  binding: teamMemberExecutionSchema,
  record: z.object({ ownerId: z.string().min(1).max(200), recordId: z.string().min(1).max(200),
    dataJson: z.string() }).strict().optional(),
}).strict() as z.ZodType<SessionEventMap['team/member/execution']>

const teamMemberDeliveredEventSchema = z.object({
  version: z.literal(1), teamId: teamIdSchema, messageId: teamMessageIdSchema,
  targetId: sessionIdSchema, executionId: sessionIdSchema, generation: positiveSafeInteger,
}).strict() as z.ZodType<SessionEventMap['team/message/member-delivered']>

const teamMemberControlEventSchema = z.object({
  version: z.literal(1), teamId: teamIdSchema, control: teamMemberControlSchema,
  record: z.object({ recordId: z.string().min(1).max(200), dataJson: z.string() }).strict(),
  slotTransfer: teamMemberSlotTransferSchema.optional(),
}).strict() as z.ZodType<SessionEventMap['team/member/control']>

const teamMemberCandidateEventSchema = z.object({
  version: z.literal(1), teamId: teamIdSchema, previousExecutionId: sessionIdSchema, control: teamMemberControlSchema,
  record: z.object({ recordId: z.string().min(1).max(200), dataJson: z.string() }).strict(),
}).strict() as z.ZodType<SessionEventMap['team/member/candidate']>

const teamTaskEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  task: teamTaskSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/task']>

const teamTaskTransactionUpdateSchema = z.object({
  previousRevision: positiveSafeInteger.nullable(),
  task: teamTaskSnapshotSchema,
}).strict() as z.ZodType<TeamTaskTransactionUpdate>
const teamTaskTransactionEventSchema = z.object({
  version: z.literal(1),
  teamId: teamIdSchema,
  updates: z.array(teamTaskTransactionUpdateSchema).min(1),
  extension: z.object({ id: z.string().min(1), dataJson: z.string() }).strict(),
  notices: z.array(ordinaryTeamMessageSnapshotSchema).optional(),
}).strict() as z.ZodType<SessionEventMap['team/task/transaction']>

const teamLeadTransactionEventSchema = z.object({
  version: z.literal(1), teamId: teamIdSchema, previousTerm: positiveSafeInteger,
  binding: teamLeadBindingSchema,
  extension: z.object({ id: z.string().min(1).max(200), dataJson: z.string() }).strict(),
  releases: z.array(teamTaskTransactionUpdateSchema),
  notices: z.array(ordinaryTeamMessageSnapshotSchema).optional(),
  handoffRecord: z.object({ id: z.string().min(1).max(200), recordId: z.string().min(1).max(200),
    dataJson: z.string(), effectsHash: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict().optional(),
  preloadNoticesFirst: z.literal(true).optional(),
}).strict() as z.ZodType<SessionEventMap['team/lead/transaction']>

const teamExtensionEventSchema = z.object({
  version: z.literal(1),
  teamId: teamIdSchema,
  extension: z.object({ id: z.string().min(1), recordId: z.string().min(1), dataJson: z.string() }).strict(),
  notices: z.array(ordinaryTeamMessageSnapshotSchema).optional(),
  affectsComposition: z.literal(true).optional(),
  leadTransition: teamLeadTransitionSchema.optional(),
  coordinatorOperation: z.object({ operationId: z.string().min(1).max(200).transform(TeamLeadOperationId),
    previousTerm: positiveSafeInteger }).strict().optional(),
}).strict() as z.ZodType<SessionEventMap['team/extension']>

const teamMessageQueuedEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  message: ordinaryTeamMessageSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/message/queued']>

const teamMessageDeliveredEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  messageId: teamMessageIdSchema,
  targetId: sessionIdSchema,
}).strict() as z.ZodType<SessionEventMap['team/message/delivered']>

const teamInputQueuedEventSchema = z.object({ version: z.literal(1), teamId: teamIdSchema,
  message: teamMessageSnapshotSchema.refine(message => message.transfer !== undefined),
}).strict() as z.ZodType<SessionEventMap['team/message/input-queued']>
const leadDeliveryReceiptSchema = z.object({ messageId: teamMessageIdSchema, targetId: sessionIdSchema,
  executionId: sessionIdSchema, term: positiveSafeInteger }).strict()
const teamLeadDeliveredEventSchema = leadDeliveryReceiptSchema.extend({ version: z.literal(1), teamId: teamIdSchema })
  .strict() as z.ZodType<SessionEventMap['team/message/lead-delivered']>

const teamMessageCancelledEventSchema = z.object({
  version: z.literal(3),
  teamId: teamIdSchema,
  targetId: sessionIdSchema,
  messageIds: z.array(teamMessageIdSchema).min(1),
  reason: z.string().min(1).max(200),
}).strict() as z.ZodType<SessionEventMap['team/message/cancelled']>

const teamControlledModeSchema = z.object({
  kind: z.literal('controlled'),
  requiredTaskExtensionId: z.string().min(1).max(200),
  permissionTableId: z.string().min(1).max(200),
  permissionRevision: z.string().min(1).max(200),
  maxOrdinaryMessageBytes: positiveSafeInteger.optional(),
  memberToolLimit: z.object({
    allow: z.array(z.string().min(1).max(200)).optional(),
    deny: z.array(z.string().min(1).max(200)).optional(),
  }).strict().optional(),
}).strict() as z.ZodType<TeamControlledMode>
const teamModeEventSchema = z.object({
  version: z.literal(1),
  teamId: teamIdSchema,
  mode: teamControlledModeSchema,
}).strict() as z.ZodType<SessionEventMap['team/mode']>

/**
 * Current Team state selected by durable Team identity. Every applied Team
 * event produces a new state object and replaces only the collection it
 * touched; untouched collections keep their references.
 */
export interface TeamState {
  readonly id: TeamId
  /** Absent before the first authenticated seat transaction; the anchor remains term one. */
  readonly lead?: TeamLeadBinding
  readonly leadHistory?: readonly TeamLeadBinding[]
  readonly leadCoordination?: TeamLeadCoordination
  readonly mode?: TeamControlledMode
  readonly composition?: TeamCompositionState
  readonly members: readonly TeamMemberSnapshot[]
  /** Committed execution generations; the original roster address remains generation one. */
  readonly memberExecutions?: readonly TeamMemberExecutionRecord[]
  readonly memberDeliveries?: readonly TeamMemberDeliveryReceipt[]
  readonly memberControls?: readonly TeamMemberExecutionControl[]
  readonly memberCandidates?: readonly TeamMemberExecutionRecord[]
  readonly tasks: readonly TeamTaskSnapshot[]
  /** Durable event-derived writer identity for Tasks claimed by an extension. */
  readonly taskWriters: readonly { readonly taskId: TeamTaskId; readonly writerId: string }[]
  /** Writer-scoped idempotency and recovery index for extension-only records. */
  readonly extensionRecords: readonly {
    readonly writerId: string
    readonly recordId: string
    readonly dataJson: string
    readonly leadTransition?: import('./lead-coordination.ts').TeamLeadTransition
    readonly coordinatorOperation?: { readonly operationId: TeamLeadOperationId; readonly previousTerm: number }
    readonly leadEffectsHash?: string
    readonly noticeIds?: readonly TeamMessageId[]
    readonly memberControl?: TeamMemberExecutionControl
    readonly memberSlotTransfer?: TeamMemberSlotTransfer
  }[]
  readonly messages: readonly TeamMessageSnapshot[]
  readonly delivered: readonly TeamMessageId[]
  /** Recipient metadata for the same terminal delivered index, never another acknowledgement set. */
  readonly leadDeliveries?: readonly TeamLeadDeliveryReceipt[]
  readonly cancelled: readonly TeamMessageCancellation[]
  readonly nextTaskNumber: number
}

/**
 * Construct empty state for one Team identity.
 * @param rootId - root Session identity.
 * @returns empty Team state.
 */
export function emptyTeamState(rootId: SessionId): TeamProjectionState {
  return {
    id: toTeamId(rootId),
    members: [],
    tasks: [],
    taskWriters: [],
    extensionRecords: [],
    messages: [],
    delivered: [],
    cancelled: [],
    nextTaskNumber: 1,
  }
}

/** Checkpoint-safe state for the Team owned by the projected Session. */
export interface TeamProjectionState extends TeamState {
  readonly failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    agentTeam: TeamProjectionState
  }
}

const teamProjectionEntrySchema = z.object({
  id: teamIdSchema,
  lead: teamLeadBindingSchema.optional(),
  leadHistory: z.array(teamLeadBindingSchema).optional(),
  leadCoordination: teamLeadCoordinationSchema.optional(),
  mode: teamControlledModeSchema.optional(),
  composition: teamCompositionStateSchema.optional(),
  members: z.array(teamMemberSnapshotSchema),
  memberExecutions: z.array(teamMemberExecutionRecordSchema).optional(),
  memberDeliveries: z.array(teamMemberDeliverySchema).optional(),
  memberControls: z.array(teamMemberControlSchema).optional(),
  memberCandidates: z.array(teamMemberExecutionRecordSchema).optional(),
  tasks: z.array(teamTaskSnapshotSchema),
  taskWriters: z.array(z.object({ taskId: teamTaskIdSchema, writerId: z.string().min(1) }).strict()),
  extensionRecords: z.array(z.object({
    writerId: z.string().min(1), recordId: z.string().min(1), dataJson: z.string(),
    leadTransition: teamLeadTransitionSchema.optional(),
    coordinatorOperation: z.object({ operationId: z.string().min(1).max(200).transform(TeamLeadOperationId),
      previousTerm: positiveSafeInteger }).strict().optional(),
    leadEffectsHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    noticeIds: z.array(teamMessageIdSchema).optional(),
    memberControl: teamMemberControlSchema.optional(),
    memberSlotTransfer: teamMemberSlotTransferSchema.optional(),
  }).strict()).default([]),
  messages: z.array(teamMessageSnapshotSchema),
  delivered: z.array(teamMessageIdSchema),
  leadDeliveries: z.array(leadDeliveryReceiptSchema).optional(),
  cancelled: z.array(z.object({
    messageId: teamMessageIdSchema,
    targetId: sessionIdSchema,
    reason: z.string().min(1).max(200),
  }).strict()),
  nextTaskNumber: positiveSafeInteger,
  failure: z.string().optional(),
}).strict() as z.ZodType<TeamProjectionState>

/** Whether one event belongs to the Team domain. */
export type TeamEventType =
  | 'team/lead/transaction'
  | 'team/mode'
  | 'team/composition'
  | 'team/member'
  | 'team/member/configured'
  | 'team/member/execution'
  | 'team/message/member-delivered'
  | 'team/member/control'
  | 'team/member/candidate'
  | 'team/task'
  | 'team/task/transaction'
  | 'team/extension'
  | 'team/message/queued'
  | 'team/message/input-queued'
  | 'team/message/lead-delivered'
  | 'team/message/delivered'
  | 'team/message/cancelled'

/** One event owned by the Team domain. */
type TeamSessionEvent = SessionEvent<TeamEventType>

/**
 * Test whether a Session event belongs to the Team domain.
 * @param event - candidate Session event.
 * @returns whether the event has a Team-owned type.
 */
export function isTeamEvent(event: SessionEvent): event is TeamSessionEvent {
  return event.type === 'team/lead/transaction'
    || event.type === 'team/mode'
    || event.type === 'team/composition'
    || event.type === 'team/member'
    || event.type === 'team/member/configured'
    || event.type === 'team/member/execution'
    || event.type === 'team/message/member-delivered'
    || event.type === 'team/member/control'
    || event.type === 'team/member/candidate'
    || event.type === 'team/task'
    || event.type === 'team/task/transaction'
    || event.type === 'team/extension'
    || event.type === 'team/message/queued'
    || event.type === 'team/message/input-queued'
    || event.type === 'team/message/lead-delivered'
    || event.type === 'team/message/delivered'
    || event.type === 'team/message/cancelled'
}

/** Decode one persisted Team value and retain the schema failure as its cause. */
function parsePersisted<T>(type: TeamEventType, schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value)
  } catch (error: unknown) {
    throw new Error(`persisted Agent Teams ${type} payload is invalid`, { cause: error })
  }
}

/** Decode the complete current-version payload selected by one Team event type. */
function parseCurrentTeamEvent(event: TeamSessionEvent): TeamSessionEvent {
  switch (event.type) {
    case 'team/lead/transaction':
      return { ...event, data: parsePersisted(event.type, teamLeadTransactionEventSchema, event.data) }
    case 'team/mode':
      return { ...event, data: parsePersisted(event.type, teamModeEventSchema, event.data) }
    case 'team/composition':
      return { ...event, data: parsePersisted(event.type, teamCompositionEventSchema, event.data) }
    case 'team/member':
      return { ...event, data: parsePersisted(event.type, teamMemberEventSchema, event.data) }
    case 'team/member/configured':
      return { ...event, data: parsePersisted(event.type, teamMemberConfiguredEventSchema, event.data) }
    case 'team/member/execution':
      return { ...event, data: parsePersisted(event.type, teamMemberExecutionEventSchema, event.data) }
    case 'team/message/member-delivered':
      return { ...event, data: parsePersisted(event.type, teamMemberDeliveredEventSchema, event.data) }
    case 'team/member/control':
      return { ...event, data: parsePersisted(event.type, teamMemberControlEventSchema, event.data) }
    case 'team/member/candidate':
      return { ...event, data: parsePersisted(event.type, teamMemberCandidateEventSchema, event.data) }
    case 'team/task':
      return { ...event, data: parsePersisted(event.type, teamTaskEventSchema, event.data) }
    case 'team/task/transaction':
      return { ...event, data: parsePersisted(event.type, teamTaskTransactionEventSchema, event.data) }
    case 'team/extension':
      return { ...event, data: parsePersisted(event.type, teamExtensionEventSchema, event.data) }
    case 'team/message/queued':
      return { ...event, data: parsePersisted(event.type, teamMessageQueuedEventSchema, event.data) }
    case 'team/message/input-queued':
      return { ...event, data: parsePersisted(event.type, teamInputQueuedEventSchema, event.data) }
    case 'team/message/lead-delivered':
      return { ...event, data: parsePersisted(event.type, teamLeadDeliveredEventSchema, event.data) }
    case 'team/message/delivered':
      return { ...event, data: parsePersisted(event.type, teamMessageDeliveredEventSchema, event.data) }
    case 'team/message/cancelled':
      return { ...event, data: parsePersisted(event.type, teamMessageCancelledEventSchema, event.data) }
    /* v8 ignore next 2 -- TeamEventType is closed and every member is handled above. */
    default:
      return event
  }
}

function applyProjectionEvent(state: TeamProjectionState, event: SessionEvent): TeamProjectionState {
  if (state.failure !== undefined) return state
  if (!isTeamEvent(event)) return state
  try {
    const selector = parsePersisted(event.type, teamEventSelectorSchema, event.data)
    if (selector.teamId !== state.id) return state
    const expectedVersion = event.type === 'team/lead/transaction' || event.type === 'team/mode' || event.type === 'team/composition'
      || event.type === 'team/task/transaction'
      || event.type === 'team/extension' || event.type === 'team/message/input-queued'
      || event.type === 'team/message/lead-delivered' || event.type === 'team/member/execution'
      || event.type === 'team/message/member-delivered' || event.type === 'team/member/control'
      || event.type === 'team/member/candidate' ? 1
      : event.type === 'team/member/configured' || event.type === 'team/message/cancelled' ? 3 : 2
    if (selector.version !== expectedVersion) {
      throw new Error(`unsupported Agent Teams event version ${String(selector.version)}`)
    }
    return applyCurrentTeamEvent(state, parseCurrentTeamEvent(event))
  } catch (error: unknown) {
    /* v8 ignore next -- the owned Team transition throws Error instances. */
    return { ...state, failure: error instanceof Error ? error.message : String(error) }
  }
}

function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  const next = [...items]
  if (index < 0) next.push(item)
  else next[index] = item
  return next
}

function applyCurrentTeamEvent(state: TeamProjectionState, event: TeamSessionEvent): TeamProjectionState {
  switch (event.type) {
    case 'team/lead/transaction': {
      const { previousTerm, binding, extension, releases, notices = [], handoffRecord } = event.data
      if (state.mode?.kind !== 'controlled') throw new Error('Lead seat requires a controlled Team')
      if (extension.id !== state.mode.requiredTaskExtensionId) throw new Error('Lead transaction requires the bound Task writer')
      if (previousTerm !== (state.lead?.term ?? 1) || binding.term !== previousTerm + 1
        || binding.executionId === brandString<SessionId>(state.id)
        || state.leadHistory?.some(prior => prior.executionId === binding.executionId)
        || state.memberExecutions?.some(prior => prior.executionId === binding.executionId)
        || state.memberCandidates?.some(prior => prior.executionId === binding.executionId)
        || state.members.some(member => member.id === binding.executionId)) {
        throw new Error('Lead binding has a stale term or reused execution identity')
      }
      try { JSON.parse(extension.dataJson) } catch { throw new Error('Lead extension record is not JSON') }
      if (event.data.preloadNoticesFirst === true && handoffRecord === undefined) {
        throw new Error('Lead initialization order requires an independent coordinator record')
      }
      if (leadCoordinationActive(state.leadCoordination) && handoffRecord === undefined) {
        throw new Error('Lead coordination commit is missing its independent record')
      }
      if (releases.length !== state.tasks.filter(task => task.ownerId === brandString<SessionId>(state.id)
        && task.status === 'in_progress').length) throw new Error('Lead transaction must release every running Lead Task')
      for (const update of releases) {
        const prior = state.tasks.find(task => task.id === update.task.id)
        if (prior?.ownerId !== brandString<SessionId>(state.id) || prior.status !== 'in_progress'
          || update.previousRevision === null || update.task.status !== 'pending' || update.task.ownerId !== undefined
          || state.taskWriters.find(writer => writer.taskId === update.task.id)?.writerId !== extension.id) {
          throw new Error('Lead transaction may only release its writer-owned running Lead Tasks')
        }
        const { ownerId: _owner, revision: _revision, status: _status, ...unchanged } = prior
        const { ownerId: _nextOwner, revision: _nextRevision, status: _nextStatus, ...nextUnchanged } = update.task
        if (JSON.stringify(unchanged) !== JSON.stringify(nextUnchanged)) {
          throw new Error('Lead release cannot alter Task requirements or result availability')
        }
      }
      const next = releases.length === 0 ? {} : applyTaskTransaction(state.tasks, state.nextTaskNumber, releases)
      const seen = new Set<TeamMessageId>()
      for (const notice of notices) {
        if (seen.has(notice.id) || state.messages.some(message => message.id === notice.id)) {
          throw new Error(`team message "${notice.id}" was queued twice`)
        }
        seen.add(notice.id)
      }
      let leadCoordination = state.leadCoordination
      let extensionRecords = state.extensionRecords
      if (handoffRecord !== undefined) {
        if (leadCoordination?.phase !== 'prepared' || leadCoordination.coordinatorId !== handoffRecord.id
          || leadCoordination.previousTerm !== previousTerm || handoffRecord.id === extension.id) {
          throw new Error('Lead transaction requires its prepared independent coordinator')
        }
        try { JSON.parse(handoffRecord.dataJson) } catch { throw new Error('Lead coordinator record is not JSON') }
        if (extensionRecords.some(record => record.writerId === handoffRecord.id && record.recordId === handoffRecord.recordId)) {
          throw new Error('Lead coordinator commit record already exists')
        }
        extensionRecords = [...extensionRecords, { writerId: handoffRecord.id,
          recordId: handoffRecord.recordId, dataJson: handoffRecord.dataJson,
          ...handoffRecord.effectsHash === undefined ? {} : { leadEffectsHash: handoffRecord.effectsHash } }]
        leadCoordination = { ...leadCoordination, phase: 'committed' }
      }
      const first = event.data.preloadNoticesFirst === true ? state.messages.findIndex(message =>
        message.targetId === brandString<SessionId>(state.id) && !state.delivered.includes(message.id)
        && !state.cancelled.some(item => item.messageId === message.id)) : -1
      const messages = notices.length === 0 ? state.messages : first < 0 ? [...state.messages, ...notices]
        : [...state.messages.slice(0, first), ...notices, ...state.messages.slice(first)]
      return { ...state, ...next, lead: binding, leadHistory: [...state.leadHistory ?? [], binding],
        extensionRecords, ...leadCoordination === undefined ? {} : { leadCoordination },
        messages }
    }
    case 'team/mode': {
      if (state.mode !== undefined || state.members.length > 0 || state.tasks.length > 0 || state.messages.length > 0) {
        throw new Error('controlled Team mode must be the first Team event')
      }
      return { ...state, mode: event.data.mode }
    }
    case 'team/composition':
      if (event.data.transition.kind === 'begin' && leadCoordinationActive(state.leadCoordination)) {
        throw new Error('Profile application conflicts with Lead coordination')
      }
      if (event.data.transition.kind === 'begin' && state.memberControls?.some(control => control.held)) {
        throw new Error('Profile application conflicts with member execution changes')
      }
      return { ...state, composition: applyCompositionTransition(state.composition, event.data.transition, state.members) }
    case 'team/member/execution': {
      const memberExecutions = applyMemberExecution(state, event.data)
      const record = event.data.record
      let extensionRecords = state.extensionRecords
      if (record !== undefined) {
        if (state.memberControls?.find(item => item.memberId === event.data.binding.memberId)?.ownerId !== record.ownerId
          || extensionRecords.some(item => item.writerId === record.ownerId && item.recordId === record.recordId)) {
          throw new Error('member execution audit does not match its admission owner')
        }
        try { JSON.parse(record.dataJson) } catch { throw new Error('member execution audit is not JSON') }
        extensionRecords = [...extensionRecords, { writerId: record.ownerId, recordId: record.recordId, dataJson: record.dataJson }]
      }
      return { ...state, memberExecutions, extensionRecords }
    }
    case 'team/member/control': {
      const { control, record } = event.data
      if (state.extensionRecords.some(item => item.writerId === control.ownerId && item.recordId === record.recordId)) {
        throw new Error('member control record already exists')
      }
      try { JSON.parse(record.dataJson) } catch { throw new Error('member control record is not JSON') }
      const slotTransfer = event.data.slotTransfer
      if (slotTransfer !== undefined && (control.held || control.memberId !== slotTransfer.fromMemberId)) {
        throw new Error('slot transfer requires its source member operation to finish')
      }
      const composition = slotTransfer === undefined ? state.composition
        : applyMemberSlotTransfer(state.composition, state.members, slotTransfer)
      const reserved = control.nextExecutionId !== undefined
        && !state.memberCandidates?.some(candidate => candidate.executionId === control.nextExecutionId)
        ? { memberId: control.memberId, executionId: control.nextExecutionId, generation: control.generation + 1,
          operationId: control.operationId } : undefined
      return { ...state, ...composition === undefined ? {} : { composition },
        ...reserved === undefined ? {} : { memberCandidates: [...state.memberCandidates ?? [], reserved] },
        memberControls: applyMemberControl(state, control), extensionRecords: [
          ...state.extensionRecords, { writerId: control.ownerId, ...record, memberControl: control,
            ...slotTransfer === undefined ? {} : { memberSlotTransfer: slotTransfer } },
        ] }
    }
    case 'team/member/candidate': {
      const { control, record, previousExecutionId } = event.data
      const controls = state.memberControls ?? []
      const candidates = state.memberCandidates ?? []
      const old = controls.find(item => item.memberId === control.memberId && item.held)
      const current = state.members.find(member => member.id === control.memberId)
      if (old === undefined || current === undefined || old.nextExecutionId !== previousExecutionId
        || control.nextExecutionId === undefined || control.nextExecutionId === previousExecutionId
        || control.memberId !== old.memberId || control.ownerId !== old.ownerId || control.operationId !== old.operationId
        || control.executionId !== old.executionId || control.generation !== old.generation
        || control.leadTerm !== old.leadTerm || control.leadExecutionId !== old.leadExecutionId || !control.held
        || currentMemberExecution(state, current).generation !== control.generation) {
        throw new Error('candidate replacement does not match its held source')
      }
      const released = { ...state, memberControls: controls.filter(item => item !== old) }
      const memberControls = applyMemberControl(released, control)
      if (state.extensionRecords.some(item => item.writerId === control.ownerId && item.recordId === record.recordId)) {
        throw new Error('candidate replacement record already exists')
      }
      try { JSON.parse(record.dataJson) } catch { throw new Error('candidate replacement record is not JSON') }
      return { ...state, memberControls, memberCandidates: [...candidates, {
        memberId: control.memberId, executionId: control.nextExecutionId, generation: control.generation + 1,
        operationId: control.operationId,
      }], extensionRecords: [...state.extensionRecords, { writerId: control.ownerId, ...record, memberControl: control }] }
    }
    case 'team/message/member-delivered': {
      const { messageId, targetId, executionId, generation } = event.data
      const owner = memberExecutionOwner(state, executionId)
      const message = state.messages.find(candidate => candidate.id === messageId)
      if (state.mode === undefined || message?.targetId !== targetId || owner?.member.id !== targetId
        || owner.binding.generation !== generation || state.delivered.includes(messageId)
        || state.cancelled.some(item => item.messageId === messageId)) {
        throw new Error('member delivery does not match an unacknowledged message and recorded execution')
      }
      return { ...state, delivered: [...state.delivered, messageId],
        memberDeliveries: [...state.memberDeliveries ?? [], { messageId, targetId, executionId, generation }] }
    }
    case 'team/member':
    case 'team/member/configured': {
      const member: TeamMemberSnapshot = event.data.member
      const index = state.members.findIndex(candidate => candidate.id === member.id)
      const prior = state.members[index]
      const named = state.members.find(candidate => candidate.name === member.name)
      if (named !== undefined && named.id !== member.id) {
        throw new Error(`teammate name "${member.name}" is reused by another member`)
      }
      if (prior === undefined) {
        if (member.phase !== 'provisioning') throw new Error(`teammate "${member.name}" must begin provisioning`)
      } else {
        if (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context
          || prior.group !== member.group
          || prior.preset?.id !== member.preset?.id || prior.preset?.revision !== member.preset?.revision
          || prior.slotId !== member.slotId) {
          throw new Error(`teammate "${member.id}" changed immutable identity fields`)
        }
        const provisioningExit = prior.phase === 'provisioning'
          && (member.phase === 'active' || member.phase === 'failed')
        const retirementStart = (prior.phase === 'active' || prior.phase === 'failed') && member.phase === 'retiring'
        const retirementEnd = prior.phase === 'retiring' && member.phase === 'retired'
        const registeredStartFailure = state.mode !== undefined && prior.phase === 'active' && member.phase === 'failed'
          && !memberExecutionStarted(state, member)
        if (!provisioningExit && !retirementStart && !retirementEnd && !registeredStartFailure) {
          throw new Error(`teammate "${member.name}" has an invalid ${prior.phase} -> ${member.phase} transition`)
        }
      }
      const composition = noteCompositionMemberChange(state.composition, prior, member)
      return { ...state, members: replaceAt(state.members, index, member),
        ...composition === undefined ? {} : { composition } }
    }
    case 'team/task': {
      const task = event.data.task
      if (state.taskWriters.some(writer => writer.taskId === task.id)) {
        throw new Error(`team task "${task.id}" requires its registered extension writer`)
      }
      const index = state.tasks.findIndex(candidate => candidate.id === task.id)
      const prior = state.tasks[index]
      if (prior === undefined && task.revision !== 1) {
        throw new Error(`team task "${task.id}" must begin at revision 1`)
      }
      if (prior !== undefined && task.revision !== prior.revision + 1) {
        throw new Error(`team task "${task.id}" revision is not contiguous`)
      }
      assertTaskGraphCandidate(state.tasks, task)
      let nextTaskNumber = state.nextTaskNumber
      const match = numericTaskIdPattern.exec(task.id)
      if (match !== null) {
        const number = Number(match[1])
        nextTaskNumber = Math.max(
          nextTaskNumber,
          number === Number.MAX_SAFE_INTEGER ? number : number + 1,
        )
      }
      return { ...state, tasks: replaceAt(state.tasks, index, task), nextTaskNumber }
    }
    case 'team/task/transaction': {
      for (const update of event.data.updates) {
        const writer = state.taskWriters.find(candidate => candidate.taskId === update.task.id)?.writerId
        if (writer !== undefined && writer !== event.data.extension.id) {
          throw new Error(`team task "${update.task.id}" belongs to another extension writer`)
        }
      }
      const next = applyTaskTransaction(state.tasks, state.nextTaskNumber, event.data.updates)
      const taskWriters = [...state.taskWriters]
      for (const update of event.data.updates) {
        if (!taskWriters.some(writer => writer.taskId === update.task.id)) {
          taskWriters.push({ taskId: update.task.id, writerId: event.data.extension.id })
        }
      }
      const notices = event.data.notices ?? []
      const seen = new Set<TeamMessageId>()
      for (const notice of notices) {
        if (seen.has(notice.id) || state.messages.some(message => message.id === notice.id)) {
          throw new Error(`team message "${notice.id}" was queued twice`)
        }
        seen.add(notice.id)
      }
      return { ...state, ...next, taskWriters,
        messages: notices.length === 0 ? state.messages : [...state.messages, ...notices] }
    }
    case 'team/extension': {
      const { recordId, id, dataJson } = event.data.extension
      if (id.length > 200 || recordId.length > 200) throw new Error('Team extension record identity is too long')
      try { JSON.parse(dataJson) } catch { throw new Error('Team extension record is not JSON') }
      if (state.extensionRecords.some(record => record.writerId === id && record.recordId === recordId)) {
        throw new Error(`Team extension record "${recordId}" was written twice`)
      }
      const notices = event.data.notices ?? []
      const seen = new Set<TeamMessageId>()
      for (const notice of notices) {
        if (seen.has(notice.id) || state.messages.some(message => message.id === notice.id)) {
          throw new Error(`team message "${notice.id}" was queued twice`)
        }
        seen.add(notice.id)
      }
      const composition = event.data.affectsComposition === true
        ? noteCompositionPermissionChange(state.composition) : state.composition
      const leadCoordination = event.data.leadTransition === undefined ? state.leadCoordination
        : applyLeadTransition(state, id, event.data.leadTransition)
      return { ...state, extensionRecords: [...state.extensionRecords, { writerId: id, recordId, dataJson,
        ...event.data.leadTransition === undefined ? {} : { leadTransition: event.data.leadTransition },
        ...event.data.coordinatorOperation === undefined ? {} : { coordinatorOperation: event.data.coordinatorOperation },
        ...event.data.coordinatorOperation === undefined || notices.length === 0 ? {} : { noticeIds: notices.map(notice => notice.id) } }],
      ...leadCoordination === undefined ? {} : { leadCoordination },
      ...composition === undefined ? {} : { composition },
      messages: notices.length === 0 ? state.messages : [...state.messages, ...notices] }
    }
    case 'team/message/queued':
    case 'team/message/input-queued': {
      const message = event.data.message
      if (event.type === 'team/message/input-queued' && (state.mode === undefined || message.targetId !== toSessionId(state.id)
        || message.content.length > 0)) throw new Error('input transfer requires its controlled logical Lead target')
      if (state.messages.some(candidate => candidate.id === message.id)) {
        throw new Error(`team message "${message.id}" was queued twice`)
      }
      return { ...state, messages: [...state.messages, message] }
    }
    case 'team/message/delivered': {
      const queued = state.messages.find(message => message.id === event.data.messageId)
      if (queued === undefined) throw new Error(`team message "${event.data.messageId}" was delivered before queueing`)
      if (queued.targetId !== event.data.targetId) throw new Error(`team message "${event.data.messageId}" target changed`)
      if (queued.transfer !== undefined) throw new Error('input transfer requires one Lead delivery receipt')
      if (state.delivered.includes(event.data.messageId)) throw new Error(`team message "${event.data.messageId}" was delivered twice`)
      if (state.cancelled.some(item => item.messageId === event.data.messageId)) {
        throw new Error(`team message "${event.data.messageId}" was cancelled before delivery`)
      }
      return { ...state, delivered: [...state.delivered, event.data.messageId] }
    }
    case 'team/message/lead-delivered': {
      const { messageId, targetId, executionId, term } = event.data
      const queued = state.messages.find(message => message.id === messageId)
      if (state.mode === undefined || queued === undefined
        || queued.targetId !== toSessionId(state.id) || targetId !== toSessionId(state.id)) {
        throw new Error('Lead receipt requires a queued controlled logical Lead item')
      }
      const initial = executionId === toSessionId(state.id) && term === 1
      if (!initial && !state.leadHistory?.some(binding => binding.executionId === executionId && binding.term === term)) {
        throw new Error('Lead receipt execution and term never held this seat')
      }
      if (state.delivered.includes(messageId) || state.cancelled.some(item => item.messageId === messageId)) {
        throw new Error('Lead mailbox item was already settled')
      }
      return { ...state, delivered: [...state.delivered, messageId],
        leadDeliveries: [...state.leadDeliveries ?? [], { messageId, targetId, executionId, term }] }
    }
    case 'team/message/cancelled': {
      const { targetId, messageIds, reason } = event.data
      const seen = new Set<TeamMessageId>()
      const additions: TeamMessageCancellation[] = []
      for (const messageId of messageIds) {
        if (seen.has(messageId)) throw new Error(`team message "${messageId}" was cancelled twice`)
        seen.add(messageId)
        const queued = state.messages.find(message => message.id === messageId)
        if (queued === undefined) throw new Error(`team message "${messageId}" was cancelled before queueing`)
        if (queued.transfer !== undefined) throw new Error('source input custody cannot be cancelled as Team mail')
        if (queued.targetId !== targetId) throw new Error(`team message "${messageId}" target changed`)
        if (state.delivered.includes(messageId) || state.cancelled.some(item => item.messageId === messageId)) {
          throw new Error(`team message "${messageId}" was already settled`)
        }
        additions.push({ messageId, targetId, reason })
      }
      return { ...state, cancelled: [...state.cancelled, ...additions] }
    }
    /* v8 ignore next 2 -- TeamEventType is closed and every member is handled above. */
    default:
      return state
  }
}

const teamMemberProjectionSchema = z.object({
  id: sessionIdSchema,
  name: z.string(),
  role: z.enum(['lead', 'teammate']),
  phase: z.enum(['provisioning', 'active', 'failed', 'retiring', 'retired']),
  group: z.string().min(1).max(64).optional(),
  preset: z.object({ id: z.string().min(1), revision: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().optional(),
  slotId: z.string().min(1).max(200).optional(),
  error: z.string().optional(),
  executionStarted: z.boolean().optional(),
  execution: teamMemberExecutionSchema.optional(),
  executionHeld: z.boolean().optional(),
}).strict() as z.ZodType<TeamMemberProjection>

const teamTaskViewSchema = z.object({
  id: teamTaskIdSchema,
  revision: positiveSafeInteger,
  subject: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
  blockedBy: z.array(teamTaskIdSchema),
  writeScopes: z.array(z.string()),
  ownerName: z.string().optional(),
  ready: z.boolean(),
  resultUnavailable: z.literal(true).optional(),
  writeScopeWarnings: z.array(z.string()),
}).strict() as z.ZodType<TeamTaskView>

const teamProjectionSchema = z.object({
  lead: teamLeadBindingSchema.optional(),
  members: z.array(teamMemberProjectionSchema),
  tasks: z.array(teamTaskViewSchema),
  composition: z.object({
    phase: z.enum(['dynamic', 'applying', 'fixed']),
    profile: teamProfileAssociationSchema.optional(),
    application: z.object({
      id: z.string(), profileId: z.string(), profileVersion: positiveSafeInteger,
      diagnostic: z.string().optional(),
    }).strict().optional(),
  }).strict().optional(),
  failure: z.string().optional(),
}).strict() as z.ZodType<TeamProjection>

/** Client views keyed by the member and task collections they were derived from. */
const teamProjectionViews = new WeakMap<readonly TeamMemberSnapshot[], WeakMap<readonly TeamTaskSnapshot[], TeamProjection>>()

function buildTeamProjection(state: TeamProjectionState): TeamProjection {
  const rootId = brandString<SessionId>(state.id)
  const members: TeamMemberProjection[] = [{ id: rootId, name: 'lead', role: 'lead', phase: 'active',
    ...state.lead === undefined ? {} : { preset: { id: state.lead.presetId, revision: state.lead.revision } } }]
  for (const member of state.members) {
    const slotId = currentMemberSlot(state.composition, member)
    members.push({
      id: member.id,
      name: member.name,
      role: 'teammate',
      phase: member.phase,
      ...state.memberExecutions?.some(binding => binding.memberId === member.id)
        ? { execution: currentMemberExecution(state, member) } : {},
      ...state.mode === undefined ? {} : { executionStarted: memberExecutionStarted(state, member) },
      ...state.memberControls?.some(control => control.memberId === member.id && control.held) ? { executionHeld: true } : {},
      ...member.group === undefined ? {} : { group: member.group },
      ...member.preset === undefined ? {} : { preset: member.preset },
      ...slotId === undefined ? {} : { slotId },
      ...member.error === undefined ? {} : { error: member.error },
    })
  }
  const composition: TeamCompositionView | undefined = state.composition === undefined ? undefined : {
    phase: state.composition.phase,
    ...state.composition.profile === undefined ? {} : { profile: state.composition.profile },
    ...state.composition.application === undefined ? {} : { application: {
      id: state.composition.application.id,
      profileId: state.composition.application.profileId,
      profileVersion: state.composition.application.profileVersion,
      ...state.composition.application.diagnostic === undefined ? {}
        : { diagnostic: state.composition.application.diagnostic },
    } },
  }
  return {
    members,
    ...state.lead === undefined ? {} : { lead: state.lead },
    tasks: state.tasks
      .filter(task => task.status !== 'deleted')
      .map(task => projectTaskView(state, task)),
    ...composition === undefined ? {} : { composition },
    ...state.failure === undefined ? {} : { failure: state.failure },
  }
}

/**
 * Durable client view of one Team state. Mailbox-only state changes reuse the
 * previous view reference, so the live drive publishes nothing for them.
 * A failure is terminal: later events retain the failed state reference and
 * do not republish its view.
 * @param state - current Team state.
 * @returns the roster and non-deleted task board, plus any projection failure.
 */
export function teamProjectionView(state: TeamProjectionState): TeamProjection {
  if (state.failure !== undefined || state.composition !== undefined || state.mode !== undefined
    || state.lead !== undefined) return buildTeamProjection(state)
  let byTasks = teamProjectionViews.get(state.members)
  if (byTasks === undefined) {
    byTasks = new WeakMap()
    teamProjectionViews.set(state.members, byTasks)
  }
  let view = byTasks.get(state.tasks)
  if (view === undefined) {
    view = buildTeamProjection(state)
    byTasks.set(state.tasks, view)
  }
  return view
}

/** Team projection selected by the projected Session identity; the wire view carries durable roster and task state only. */
export const teamProjectionDefinition = {
  key: 'agentTeam',
  stateVersion: 20,
  stateSchema: teamProjectionEntrySchema,
  init: header => emptyTeamState(header.id),
  apply: applyProjectionEvent,
  wire: { viewSchema: teamProjectionSchema, view: teamProjectionView },
} satisfies ProjectionDefinition<'agentTeam', TeamProjectionState>
