/** Durable input custody fold for the optional, provider-owned controller. */

import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { AgentInput, InputControlState, InputControllerId } from './input-control-types.ts'
import { InputControllerId as brandController } from './input-control.ts'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, type UserMessage } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const controllerId = z.string().min(1).transform(brandController)
const messageId = z.string().min(1).transform(MessageId)
const message = z.custom<UserMessage>((value) => {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !row.id || row.role !== 'user' || !Array.isArray(row.content)) return false
  const source = row.source
  return source !== null && typeof source === 'object' && 'kind' in source && typeof source.kind === 'string'
    && row.content.every((block: unknown) => block !== null && typeof block === 'object'
      && 'type' in block && typeof block.type === 'string')
})
const input = z.object({ message, target: z.enum(['next-step', 'next-turn']), wakeup: z.boolean(),
  requestedTarget: z.enum(['next-step', 'next-turn']).optional(),
}).strict().transform(({ requestedTarget, ...rest }) => ({ ...rest,
  ...requestedTarget === undefined ? {} : { requestedTarget },
}))
const binding = z.object({ version: z.literal(1), controllerId }).strict()
const held = binding.extend({ input, captured: z.literal(true).optional() }).strict()
const released = binding.extend({ messageId }).strict()
const stateSchema: z.ZodType<InputControlState> = z.object({
  inheritedEventCount: z.number().int().nonnegative().transform(SessionLogOffset),
  controllerId: controllerId.nullable(),
  records: z.array(z.object({ input, originalInput: input.optional(), location: z.enum(['inbox', 'held', 'released']),
    captured: z.literal(true).optional(),
  }).strict()).readonly(),
}).strict()

/** Refuse a durable fact whose provider does not own this Session's binding. */
function owned(state: InputControlState, id: InputControllerId): void {
  if (state.controllerId !== id) throw new Error('input controller binding does not match')
}

/** Preserve one immutable input identity while advancing custody. */
function remember(state: InputControlState, value: AgentInput, location: 'inbox' | 'held', captured = false): InputControlState {
  const previous = state.records.find(record => record.input.message.id === value.message.id)
  if (previous !== undefined) {
    if (!isDeepStrictEqual(previous.input, value)) throw new Error('input identity reused with different contents or intent')
    if (previous.location === 'released') throw new Error('released input cannot be inserted again')
    if (previous.location === location) return state
  }
  const record = { input: value, location, ...captured ? { captured: true as const } : {},
    ...previous?.originalInput === undefined ? {} : { originalInput: previous.originalInput } }
  if (location === 'held') {
    const records = state.records.filter(item => item !== previous)
    const firstArrival = captured ? records.findIndex(item => item.location === 'held' && item.captured !== true) : -1
    records.splice(firstArrival < 0 ? records.length : firstArrival, 0, record)
    return { ...state, records }
  }
  return { ...state, records: previous === undefined ? [...state.records, record]
    : state.records.map(item => item === previous ? record : item) }
}

/** Register only on the concrete driver; no client wire or alternative queue. */
export const inputControlProjection: ProjectionDefinition<'inputControl'> = {
  key: 'inputControl', stateVersion: 3, stateSchema,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, controllerId: null, records: [] }),
  apply: (state, event) => {
    if (event.seq < state.inheritedEventCount) return state
    switch (event.type) {
      case 'agent/input/controller-bound': {
        const data = binding.parse(event.data)
        if (state.controllerId !== null) throw new Error('duplicate input controller binding')
        return { ...state, controllerId: data.controllerId }
      }
      case 'agent/input/held': {
        const data = held.parse(event.data)
        owned(state, data.controllerId)
        return remember(state, data.input, 'held', data.captured === true)
      }
      case 'agent/input/released': {
        const data = released.parse(event.data)
        owned(state, data.controllerId)
        const previous = state.records.find(record => record.input.message.id === data.messageId)
        if (previous?.location !== 'held') throw new Error('input release requires held custody')
        return { ...state, records: state.records.map(record => record === previous
          ? { ...record, location: 'released' } : record) }
      }
      case 'agent/inbox/spliced': {
        if (state.controllerId === null) return state
        if (event.data.heldInput !== undefined) {
          const record = state.records.find(item => item.input.message.id === event.data.heldInput)
          if (record?.location !== 'held' || record.input.target !== event.data.target
            || event.data.removedCount !== 1 || event.data.inserted.length !== 0 || event.data.outcome !== undefined) {
            throw new Error('inbox custody removal requires its recorded held input')
          }
          return state
        }
        let next = state
        for (const item of event.data.inserted) {
          const prior = next.records.find(record => record.input.message.id === item.id)
          const wakeup = event.data.wakeup ?? prior?.input.wakeup
          if (wakeup === undefined) continue
          const requestedTarget = event.data.wakeup === undefined ? prior?.input.requestedTarget : event.data.requestedTarget
          const value = input.parse({ message: item, target: event.data.target, wakeup,
            ...requestedTarget === undefined ? {} : { requestedTarget } })
          if (prior?.location === 'inbox' && !isDeepStrictEqual(prior.input, value)) {
            if (!isDeepStrictEqual(prior.input.message.source, value.message.source)) throw new Error('pending input source cannot change')
            next = { ...next, records: next.records.map(record => record === prior
              ? { ...record, input: value, originalInput: prior.originalInput ?? prior.input } : record) }
          } else next = remember(next, value, 'inbox')
        }
        return next
      }
      default:
        // This merge-extensible log contains unrelated transcript and plugin facts.
        return state
    }
  },
}
