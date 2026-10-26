/** Versioned import of unsigned OpenAI text reasoning. No SDK state is accepted. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { freezeMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { toPiReplayState } from './replay.ts'
import type { AssistantMessage as PiAssistant } from '@earendil-works/pi-ai'

/** Exact identity admitted by the host for imported reasoning. */
export interface PiAiReasoningTarget {
  api: 'openai-completions'
  provider: string
  model: string
}

/** Portable assistant record; signatures, redactions, usage and private SDK JSON are excluded. */
export interface OpenAIReasoningMessageV1 {
  version: 1
  id: string
  source: PiAiReasoningTarget
  content: readonly (
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'tool-call'; id: string; name: string; arguments: string }
  )[]
}

/** Import budget counts the entire serialized UTF-8 record, including metadata. */
export interface PiAiReasoningImportOptions {
  maxBytes?: number
  signal?: AbortSignal
}

/** Default bound for one imported record or retained request reasoning. */
export const DEFAULT_REASONING_MAX_BYTES = 1024 * 1024

function invalid(): never {
  throw new LlmError('Unsupported or invalid OpenAI reasoning history', 'INVALID_REASONING_HISTORY')
}

/** Validate a positive UTF-8 byte budget without including caller data in diagnostics. */
export function reasoningByteLimit(value = DEFAULT_REASONING_MAX_BYTES): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LlmError('Reasoning maxBytes must be a positive safe integer', 'INVALID_CONFIG')
  }
  return value
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !keys.includes(key))) return invalid()
  return record
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) return invalid()
  return value
}

/**
 * Import a same-route, same-model OpenAI Chat assistant with unsigned text reasoning.
 * Unknown fields/versions, other protocols, signatures and malformed tool JSON fail before HTTP.
 * The returned immutable DSH message preserves its id and contains only shared-owned replay metadata.
 * Historical usage is zero; seeding the message never executes its tools.
 * @param value - versioned, JSON-compatible external assistant record.
 * @param target - exact trusted request identity; vendor aliases are not interchangeable.
 * @param options - complete record byte limit and optional cancellation signal.
 * @returns an identified message suitable for a new session seed or host-owned persistence.
 */
export function importOpenAIReasoningMessage(
  value: unknown, target: PiAiReasoningTarget, options: PiAiReasoningImportOptions = {},
): AssistantMessage {
  options.signal?.throwIfAborted()
  const limit = reasoningByteLimit(options.maxBytes)
  const record = object(value, ['version', 'id', 'source', 'content'])
  if (record['version'] !== 1) return invalid()
  const id = identifier(record['id'])
  const source = object(record['source'], ['api', 'provider', 'model'])
  if (source['api'] !== 'openai-completions' || target.api !== 'openai-completions'
    || identifier(source['provider']) !== identifier(target.provider)
    || identifier(source['model']) !== identifier(target.model)) return invalid()
  const blocks = record['content']
  if (!Array.isArray(blocks) || blocks.length === 0) return invalid()
  const native: PiAssistant['content'] = blocks.map(value => {
    const block = object(value, ['type', 'text', 'id', 'name', 'arguments'])
    if (block['type'] === 'text' || block['type'] === 'reasoning') {
      object(block, ['type', 'text'])
      if (typeof block['text'] !== 'string') return invalid()
      return block['type'] === 'text' ? { type: 'text', text: block['text'] }
        : { type: 'thinking', thinking: block['text'], thinkingSignature: 'reasoning_content' }
    }
    if (block['type'] !== 'tool-call') return invalid()
    object(block, ['type', 'id', 'name', 'arguments'])
    if (typeof block['arguments'] !== 'string') return invalid()
    let args: unknown
    try { args = JSON.parse(block['arguments']) } catch { return invalid() }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return invalid()
    return { type: 'toolCall', id: identifier(block['id']), name: identifier(block['name']),
      arguments: args as Record<string, unknown> }
  })
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > limit) {
    throw new LlmError('OpenAI reasoning history exceeds maxBytes', 'REASONING_HISTORY_TOO_LARGE')
  }
  const replayState = toPiReplayState({
    role: 'assistant', ...target, content: native, timestamp: 0,
    stopReason: native.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  })
  options.signal?.throwIfAborted()
  return freezeMessage({ id: brandString<MessageId>(id), role: 'assistant',
    content: blocks as AssistantMessage['content'],
    source: { kind: 'model', provider: target.provider, model: target.model, replayState } })
}
