/** Host-only Team state projected incrementally from committed Session events. */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {
  TeamId,
  TeamMemberLegacySnapshot,
  TeamMemberSnapshot,
  TeamLinkedMessageSnapshot,
  TeamMessageId,
  TeamMessageSnapshot,
  TeamManagedTaskState,
  TeamManagedTaskUpdate,
  TeamTaskSnapshot,
} from './types.ts'
import {
  TeamId as toTeamId,
  TeamMessageId as toTeamMessageId,
  TeamTaskAttemptId as toTeamTaskAttemptId,
  TeamTaskId as toTeamTaskId,
} from './types.ts'
import { assertTaskGraph, assertTaskGraphCandidate } from './task-graph.ts'

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

const memberFields = {
  id: sessionIdSchema,
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  context: z.enum(['fresh', 'fork']),
  error: z.string().optional(),
}

const legacyTeamMemberSnapshotSchema = z.object({
  ...memberFields,
  phase: z.enum(['provisioning', 'active', 'failed']),
}).strict() as z.ZodType<TeamMemberLegacySnapshot>

const teamMemberSnapshotSchema = z.object({
  ...memberFields,
  phase: z.enum(['provisioning', 'active', 'failed', 'retiring', 'retired']),
  preset: z.object({
    id: z.string().min(1),
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict().optional(),
}).strict() as z.ZodType<TeamMemberSnapshot>

const teamTaskSnapshotSchema = z.object({
  id: teamTaskIdSchema,
  revision: positiveSafeInteger,
  subject: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
  ownerId: sessionIdSchema.optional(),
  blockedBy: z.array(teamTaskIdSchema),
  writeScopes: z.array(z.string()),
}).strict() as z.ZodType<TeamTaskSnapshot>

const teamTaskInputSchema = z.object({ taskId: teamTaskIdSchema, revision: positiveSafeInteger }).strict()
const teamTaskResultSchema = z.object({ summary: z.string().min(1), artifacts: z.array(z.string().min(1)) }).strict()
const teamTaskAttemptSchema = z.object({
  id: z.string().min(1).transform(toTeamTaskAttemptId),
  ownerId: sessionIdSchema,
  status: z.enum(['running', 'submitted', 'accepted', 'rejected', 'cancelled']),
  inputs: z.array(teamTaskInputSchema),
  result: teamTaskResultSchema.optional(),
  reason: z.string().optional(),
}).strict()
const teamManagedReviewSchema = z.object({
  attempts: z.array(teamTaskAttemptSchema),
  validity: z.enum(['none', 'valid', 'stale']),
  origin: z.object({ kind: z.literal('rework'), taskId: teamTaskIdSchema, reason: z.string().min(1) }).strict().optional(),
  replacedByTaskId: teamTaskIdSchema.optional(),
}).strict() as z.ZodType<TeamManagedTaskState>
const teamManagedUpdateSchema = z.object({
  task: teamTaskSnapshotSchema,
  review: teamManagedReviewSchema,
}).strict() as z.ZodType<TeamManagedTaskUpdate>

const messageFields = {
  id: teamMessageIdSchema,
  senderId: sessionIdSchema,
  senderName: z.string(),
  targetId: sessionIdSchema,
  content: z.array(contentBlockSchema),
}

const teamMessageSnapshotSchema = z.object(messageFields).strict() as z.ZodType<TeamMessageSnapshot>
const teamLinkedMessageSnapshotSchema = z.object({
  ...messageFields,
  taskId: teamTaskIdSchema,
}).strict() as z.ZodType<TeamLinkedMessageSnapshot>

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

const teamTaskManagedEventSchema = z.object({
  version: z.literal(1),
  teamId: teamIdSchema,
  updates: z.array(teamManagedUpdateSchema).min(1),
}).strict() as z.ZodType<SessionEventMap['team/task/managed']>

const teamMessageQueuedEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  message: teamMessageSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/message/queued']>

const teamMessageQueuedTaskEventSchema = z.object({
  version: z.literal(3),
  teamId: teamIdSchema,
  message: teamLinkedMessageSnapshotSchema,
}).strict() as z.ZodType<SessionEventMap['team/message/queued-task']>

const teamMessageDeliveredEventSchema = z.object({
  version: z.literal(2),
  teamId: teamIdSchema,
  messageId: teamMessageIdSchema,
  targetId: sessionIdSchema,
}).strict() as z.ZodType<SessionEventMap['team/message/delivered']>

/** Current Team state selected by durable Team identity. */
export interface TeamState {
  readonly id: TeamId
  readonly members: TeamMemberSnapshot[]
  readonly tasks: TeamTaskSnapshot[]
  readonly managed: Record<string, TeamManagedTaskState>
  readonly messages: Array<TeamMessageSnapshot | TeamLinkedMessageSnapshot>
  readonly messageTimes: Record<string, number>
  readonly delivered: TeamMessageId[]
  nextTaskNumber: number
}

/**
 * Construct empty state for one Team identity.
 * @param rootId - root Session identity.
 * @returns mutable empty Team state.
 */
export function emptyTeamState(rootId: SessionId): TeamProjectionState {
  return {
    id: toTeamId(rootId),
    members: [],
    tasks: [],
    managed: {},
    messages: [],
    messageTimes: {},
    delivered: [],
    nextTaskNumber: 1,
  }
}

/** Checkpoint-safe state for the Team owned by the projected Session. */
export interface TeamProjectionState extends TeamState {
  failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    agentTeam: TeamProjectionState
  }
}

const teamProjectionEntrySchema = z.object({
  id: teamIdSchema,
  members: z.array(teamMemberSnapshotSchema),
  tasks: z.array(teamTaskSnapshotSchema),
  managed: z.record(z.string(), teamManagedReviewSchema),
  messages: z.array(z.union([teamMessageSnapshotSchema, teamLinkedMessageSnapshotSchema])),
  messageTimes: z.record(z.string(), nonNegativeSafeInteger),
  delivered: z.array(teamMessageIdSchema),
  nextTaskNumber: positiveSafeInteger,
  failure: z.string().optional(),
}).strict().refine(value => value.messages.every(message => Object.hasOwn(value.messageTimes, message.id)), {
  message: 'every queued Team message requires its original event time',
}).refine(value => Object.keys(value.managed).every(id => value.tasks.some(task => task.id === id)), {
  message: 'every managed Task state requires its Task record',
}) as z.ZodType<TeamProjectionState>

/** Whether one event belongs to the Team domain. */
export type TeamEventType =
  | 'team/member'
  | 'team/member/configured'
  | 'team/task'
  | 'team/task/managed'
  | 'team/message/queued'
  | 'team/message/queued-task'
  | 'team/message/delivered'

/** One event owned by the Team domain. */
type TeamSessionEvent = SessionEvent<TeamEventType>

/**
 * Test whether a Session event belongs to the Team domain.
 * @param event - candidate Session event.
 * @returns whether the event has a Team-owned type.
 */
export function isTeamEvent(event: SessionEvent): event is TeamSessionEvent {
  return event.type === 'team/member'
    || event.type === 'team/member/configured'
    || event.type === 'team/task'
    || event.type === 'team/task/managed'
    || event.type === 'team/message/queued'
    || event.type === 'team/message/queued-task'
    || event.type === 'team/message/delivered'
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
    case 'team/member':
      return { ...event, data: parsePersisted(event.type, teamMemberEventSchema, event.data) }
    case 'team/member/configured':
      return { ...event, data: parsePersisted(event.type, teamMemberConfiguredEventSchema, event.data) }
    case 'team/task':
      return { ...event, data: parsePersisted(event.type, teamTaskEventSchema, event.data) }
    case 'team/task/managed':
      return { ...event, data: parsePersisted(event.type, teamTaskManagedEventSchema, event.data) }
    case 'team/message/queued':
      return { ...event, data: parsePersisted(event.type, teamMessageQueuedEventSchema, event.data) }
    case 'team/message/queued-task':
      return { ...event, data: parsePersisted(event.type, teamMessageQueuedTaskEventSchema, event.data) }
    case 'team/message/delivered':
      return { ...event, data: parsePersisted(event.type, teamMessageDeliveredEventSchema, event.data) }
    /* v8 ignore next 2 -- TeamEventType is closed and every member is handled above. */
    default:
      return event
  }
}

function applyProjectionEvent(state: TeamProjectionState, event: SessionEvent): void {
  if (state.failure !== undefined) return
  if (!isTeamEvent(event)) return
  try {
    const selector = parsePersisted(event.type, teamEventSelectorSchema, event.data)
    if (selector.teamId !== state.id) return
    const expectedVersion = event.type === 'team/task/managed' ? 1
      : event.type === 'team/member/configured' || event.type === 'team/message/queued-task' ? 3 : 2
    if (selector.version !== expectedVersion) {
      throw new Error(`unsupported Agent Teams event version ${String(selector.version)}`)
    }
    applyCurrentTeamEvent(state, parseCurrentTeamEvent(event))
  } catch (error: unknown) {
    /* v8 ignore next -- the owned Team transition throws Error instances. */
    state.failure = error instanceof Error ? error.message : String(error)
  }
}

function applyCurrentTeamEvent(state: TeamState, event: TeamSessionEvent): void {
  switch (event.type) {
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
          || prior.preset?.id !== member.preset?.id || prior.preset?.revision !== member.preset?.revision) {
          throw new Error(`teammate "${member.id}" changed immutable identity fields`)
        }
        const provisioningExit = prior.phase === 'provisioning'
          && (member.phase === 'active' || member.phase === 'failed')
        const retirementStart = prior.phase === 'active' && member.phase === 'retiring'
        const retirementEnd = prior.phase === 'retiring' && member.phase === 'retired'
        if (!provisioningExit && !retirementStart && !retirementEnd) {
          throw new Error(`teammate "${member.name}" has an invalid ${prior.phase} -> ${member.phase} transition`)
        }
      }
      if (index < 0) state.members.push(member)
      else state.members[index] = member
      break
    }
    case 'team/task': {
      const task = event.data.task
      if (state.managed[task.id] !== undefined) {
        throw new Error(`managed task "${task.id}" cannot be changed by a legacy task event`)
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
      const match = numericTaskIdPattern.exec(task.id)
      if (match !== null) {
        const number = Number(match[1])
        state.nextTaskNumber = Math.max(
          state.nextTaskNumber,
          number === Number.MAX_SAFE_INTEGER ? number : number + 1,
        )
      }
      if (index < 0) state.tasks.push(task)
      else state.tasks[index] = task
      break
    }
    case 'team/task/managed': {
      const tasks = [...state.tasks]
      const managed = { ...state.managed }
      const touched = new Set<string>()
      let nextTaskNumber = state.nextTaskNumber
      for (const { task, review } of event.data.updates) {
        if (touched.has(task.id)) throw new Error(`managed task "${task.id}" occurs twice in one transaction`)
        touched.add(task.id)
        const index = tasks.findIndex(candidate => candidate.id === task.id)
        const prior = tasks[index]
        if (prior === undefined && task.revision !== 1) {
          throw new Error(`managed task "${task.id}" must begin at revision 1`)
        }
        if (prior !== undefined && task.revision !== prior.revision + 1) {
          throw new Error(`managed task "${task.id}" revision is not contiguous`)
        }
        if (prior !== undefined && managed[task.id] === undefined) {
          throw new Error(`legacy task "${task.id}" cannot gain managed history`)
        }
        const attemptIds = review.attempts.map(attempt => attempt.id)
        if (new Set(attemptIds).size !== attemptIds.length) {
          throw new Error(`managed task "${task.id}" repeats an attempt identity`)
        }
        const latest = review.attempts.at(-1)
        if (review.validity === 'valid' && (task.status !== 'completed'
          || latest?.status !== 'accepted' || review.replacedByTaskId !== undefined)) {
          throw new Error(`managed task "${task.id}" has no valid accepted result`)
        }
        if (task.status === 'in_progress' && latest?.status !== 'running' && latest?.status !== 'submitted') {
          throw new Error(`managed task "${task.id}" has no active attempt`)
        }
        if (review.origin?.taskId === task.id || review.replacedByTaskId === task.id) {
          throw new Error(`managed task "${task.id}" cannot replace itself`)
        }
        if (index < 0) tasks.push(task)
        else tasks[index] = task
        managed[task.id] = review
        const match = numericTaskIdPattern.exec(task.id)
        if (match !== null) {
          const number = Number(match[1])
          nextTaskNumber = Math.max(nextTaskNumber,
            number === Number.MAX_SAFE_INTEGER ? number : number + 1)
        }
      }
      assertTaskGraph(tasks)
      for (const { task, review } of event.data.updates) {
        if (review.origin !== undefined && !tasks.some(candidate => candidate.id === review.origin?.taskId)) {
          throw new Error(`managed task "${task.id}" has no rework origin`)
        }
        if (review.replacedByTaskId !== undefined && !tasks.some(candidate => candidate.id === review.replacedByTaskId
          && managed[candidate.id]?.origin?.taskId === task.id)) {
          throw new Error(`managed task "${task.id}" has no matching replacement`)
        }
      }
      state.tasks.splice(0, state.tasks.length, ...tasks)
      Object.assign(state.managed, managed)
      state.nextTaskNumber = nextTaskNumber
      break
    }
    case 'team/message/queued':
    case 'team/message/queued-task': {
      const message = event.data.message
      if (state.messages.some(candidate => candidate.id === message.id)) {
        throw new Error(`team message "${message.id}" was queued twice`)
      }
      state.messages.push(message)
      state.messageTimes[message.id] = event.time
      break
    }
    case 'team/message/delivered': {
      const queued = state.messages.find(message => message.id === event.data.messageId)
      if (queued === undefined) throw new Error(`team message "${event.data.messageId}" was delivered before queueing`)
      if (queued.targetId !== event.data.targetId) throw new Error(`team message "${event.data.messageId}" target changed`)
      if (state.delivered.includes(event.data.messageId)) throw new Error(`team message "${event.data.messageId}" was delivered twice`)
      state.delivered.push(event.data.messageId)
      break
    }
    /* v8 ignore next 2 -- TeamEventType is closed and every member is handled above. */
    default:
      return
  }
}

/** Host-only Team projection selected by the projected Session identity. */
export const teamProjectionDefinition = {
  key: 'agentTeam',
  stateVersion: 7,
  stateSchema: teamProjectionEntrySchema,
  init: header => emptyTeamState(header.id),
  apply: (state, event) => {
    applyProjectionEvent(state, event)
    return state
  },
} satisfies ProjectionDefinition<'agentTeam', TeamProjectionState>
