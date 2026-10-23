/** Strict function-call admission over terminal SDK wire metadata. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AssistantMessageEvent } from '@earendil-works/pi-ai'

type FunctionArguments = Extract<AssistantMessageEvent, { type: 'toolcall_end' }>['toolCall']['arguments']

/** Hosts opting into strict JSON function calls explicitly supply their byte limit. */
export interface PiAiToolCallValidation {
  /** Maximum UTF-8 bytes in one terminal raw argument string. */
  maxArgumentBytes: number
}

/**
 * Reject a whole response when any function call lacks valid terminal evidence.
 * @param events - SDK events with the pinned raw-function-call extension.
 * @param policy - host's argument byte budget.
 * @returns events with strictly parsed arguments; failure precedes a successful finish.
 */
export async function* validateToolCalls(
  events: AsyncIterable<AssistantMessageEvent>,
  policy: PiAiToolCallValidation,
): AsyncGenerator<AssistantMessageEvent> {
  const ended = new Set<number>()
  let malformed = false
  for await (const event of events) {
    if (event.type === 'toolcall_end') {
      if (ended.has(event.contentIndex)) malformed = true
      ended.add(event.contentIndex)
      const raw = event.rawFunctionCall
      let args: FunctionArguments | undefined
      if (raw !== undefined && raw.identityValid
        && typeof raw.id === 'string' && raw.id.length > 0
        && typeof raw.name === 'string' && raw.name.length > 0
        && typeof raw.arguments === 'string'
        && Buffer.byteLength(raw.arguments, 'utf8') <= policy.maxArgumentBytes) {
        try {
          const value: unknown = raw.arguments.trim() === '' ? {} : JSON.parse(raw.arguments)
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) args = value as FunctionArguments
        } catch (_invalidJson) {
          // SDK permissive parsing must not repair this response into tool effects.
        }
      }
      if (args === undefined) malformed = true
      else yield { ...event, toolCall: { ...event.toolCall, arguments: args } }
      continue
    }
    if (event.type === 'done') {
      const count = event.message.content.filter(block => block.type === 'toolCall').length
      if (malformed || count !== ended.size) {
        throw new LlmError('Model returned an invalid function call', 'MALFORMED_RESPONSE')
      }
    }
    yield event
  }
}
