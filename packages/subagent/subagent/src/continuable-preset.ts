/** Durable explicit preset binding for a continuable child. */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** A preset declaration captured before the child's first model request. */
export interface ContinuablePresetBinding {
  readonly id: string
  readonly revision: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Explicit child composition; absent from older children that inherit their parent's preset. */
    'subagent/continuable-preset': { version: 1; preset: ContinuablePresetBinding }
  }
}

const bindingSchema = z.object({
  version: z.literal(1),
  preset: z.object({
    id: z.string().min(1),
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
}).strict()

/**
 * Read a child's explicit preset from its own event suffix.
 * @param events - child-owned Session events, excluding a forked parent prefix.
 * @returns the bound preset, or undefined for legacy inherited-composition children.
 * @throws when the child contains a duplicate or malformed binding.
 */
export function foldContinuablePreset(events: readonly SessionEvent[]): ContinuablePresetBinding | undefined {
  const records = events.filter(event => event.type === 'subagent/continuable-preset')
  if (records.length === 0) return undefined
  if (records.length !== 1) throw new Error('continuable child has duplicate preset bindings')
  return bindingSchema.parse(records[0]?.data).preset
}
