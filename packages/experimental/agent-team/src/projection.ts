/** Team state projected incrementally from committed Session events, with a durable-only client view. */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
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
} from './types.ts'
import { applyCompositionTransition, noteCompositionMemberChange, noteCompositionPermissionChange } from './composition.ts'
import {
  TeamId as toTeamId,
  TeamMessageId as toTeamMessageId,
  TeamTaskId as toTeamTaskId,
} from './types.ts'
import { assertTaskGraphCandidate } from './task-graph.ts'
import { applyTaskTransaction } from './task-transaction.ts'
import { projectTaskView } from './task-view.ts'

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
}).strict() as z.ZodType<TeamMessageSnapshot>

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
  notices: z.array(teamMessageSnapshotSchema).optional(),
}).strict() as z.ZodType<SessionEventMap['team/task/transaction']>

const teamExtensionEventSchema = z.object({
  version: z.literal(1),
  teamId: teamIdSchema,
  extension: z.object({ id: z.string().min(1), recordId: z.string().min(1), dataJson: z.string() }).strict(),
  notices: z.array(teamMessageSnapshotSchema).optional(),
  affectsComposition: z.literal(true).optional(),
}).strict() as z.ZodType<SessionEventMap['team/extension']>

const teamMessageQueuedEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  message: teamMessageSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/message/queued']>

const teamMessageDeliveredEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  messageId: teamMessageIdSchema,
  targetId: sessionIdSchema,
}).strict() as z.ZodType<SessionEventMap['team/message/delivered']>

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
  readonly mode?: TeamControlledMode
  readonly composition?: TeamCompositionState
  readonly members: readonly TeamMemberSnapshot[]
  readonly tasks: readonly TeamTaskSnapshot[]
  /** Durable event-derived writer identity for Tasks claimed by an extension. */
  readonly taskWriters: readonly { readonly taskId: TeamTaskId; readonly writerId: string }[]
  /** Writer-scoped idempotency and recovery index for extension-only records. */
  readonly extensionRecords: readonly { readonly writerId: string; readonly recordId: string; readonly dataJson: string }[]
  readonly messages: readonly TeamMessageSnapshot[]
  readonly delivered: readonly TeamMessageId[]
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
  mode: teamControlledModeSchema.optional(),
  composition: teamCompositionStateSchema.optional(),
  members: z.array(teamMemberSnapshotSchema),
  tasks: z.array(teamTaskSnapshotSchema),
  taskWriters: z.array(z.object({ taskId: teamTaskIdSchema, writerId: z.string().min(1) }).strict()),
  extensionRecords: z.array(z.object({
    writerId: z.string().min(1), recordId: z.string().min(1), dataJson: z.string(),
  }).strict()).default([]),
  messages: z.array(teamMessageSnapshotSchema),
  delivered: z.array(teamMessageIdSchema),
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
  | 'team/mode'
  | 'team/composition'
  | 'team/member'
  | 'team/member/configured'
  | 'team/task'
  | 'team/task/transaction'
  | 'team/extension'
  | 'team/message/queued'
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
  return event.type === 'team/mode'
    || event.type === 'team/composition'
    || event.type === 'team/member'
    || event.type === 'team/member/configured'
    || event.type === 'team/task'
    || event.type === 'team/task/transaction'
    || event.type === 'team/extension'
    || event.type === 'team/message/queued'
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
    case 'team/mode':
      return { ...event, data: parsePersisted(event.type, teamModeEventSchema, event.data) }
    case 'team/composition':
      return { ...event, data: parsePersisted(event.type, teamCompositionEventSchema, event.data) }
    case 'team/member':
      return { ...event, data: parsePersisted(event.type, teamMemberEventSchema, event.data) }
    case 'team/member/configured':
      return { ...event, data: parsePersisted(event.type, teamMemberConfiguredEventSchema, event.data) }
    case 'team/task':
      return { ...event, data: parsePersisted(event.type, teamTaskEventSchema, event.data) }
    case 'team/task/transaction':
      return { ...event, data: parsePersisted(event.type, teamTaskTransactionEventSchema, event.data) }
    case 'team/extension':
      return { ...event, data: parsePersisted(event.type, teamExtensionEventSchema, event.data) }
    case 'team/message/queued':
      return { ...event, data: parsePersisted(event.type, teamMessageQueuedEventSchema, event.data) }
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
    const expectedVersion = event.type === 'team/mode' || event.type === 'team/composition'
      || event.type === 'team/task/transaction'
      || event.type === 'team/extension' ? 1
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
    case 'team/mode': {
      if (state.mode !== undefined || state.members.length > 0 || state.tasks.length > 0 || state.messages.length > 0) {
        throw new Error('controlled Team mode must be the first Team event')
      }
      return { ...state, mode: event.data.mode }
    }
    case 'team/composition':
      return { ...state, composition: applyCompositionTransition(state.composition, event.data.transition, state.members) }
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
          && !state.messages.some(message => message.targetId === member.id && state.delivered.includes(message.id))
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
      return { ...state, extensionRecords: [...state.extensionRecords, { writerId: id, recordId, dataJson }],
        ...composition === undefined ? {} : { composition },
        messages: notices.length === 0 ? state.messages : [...state.messages, ...notices] }
    }
    case 'team/message/queued': {
      const message = event.data.message
      if (state.messages.some(candidate => candidate.id === message.id)) {
        throw new Error(`team message "${message.id}" was queued twice`)
      }
      return { ...state, messages: [...state.messages, message] }
    }
    case 'team/message/delivered': {
      const queued = state.messages.find(message => message.id === event.data.messageId)
      if (queued === undefined) throw new Error(`team message "${event.data.messageId}" was delivered before queueing`)
      if (queued.targetId !== event.data.targetId) throw new Error(`team message "${event.data.messageId}" target changed`)
      if (state.delivered.includes(event.data.messageId)) throw new Error(`team message "${event.data.messageId}" was delivered twice`)
      if (state.cancelled.some(item => item.messageId === event.data.messageId)) {
        throw new Error(`team message "${event.data.messageId}" was cancelled before delivery`)
      }
      return { ...state, delivered: [...state.delivered, event.data.messageId] }
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
  const members: TeamMemberProjection[] = [{ id: rootId, name: 'lead', role: 'lead', phase: 'active' }]
  for (const member of state.members) {
    members.push({
      id: member.id,
      name: member.name,
      role: 'teammate',
      phase: member.phase,
      ...state.mode === undefined ? {} : { executionStarted: state.messages.some(message =>
        message.targetId === member.id && state.delivered.includes(message.id)) },
      ...member.group === undefined ? {} : { group: member.group },
      ...member.preset === undefined ? {} : { preset: member.preset },
      ...member.slotId === undefined ? {} : { slotId: member.slotId },
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
  if (state.failure !== undefined || state.composition !== undefined || state.mode !== undefined) return buildTeamProjection(state)
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
  stateVersion: 16,
  stateSchema: teamProjectionEntrySchema,
  init: header => emptyTeamState(header.id),
  apply: applyProjectionEvent,
  wire: { viewSchema: teamProjectionSchema, view: teamProjectionView },
} satisfies ProjectionDefinition<'agentTeam', TeamProjectionState>
