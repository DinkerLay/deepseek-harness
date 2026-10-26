/** Request-only reasoning projection; the authoritative session is never edited. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { reasoningByteLimit } from './reasoning-history.ts'

/** Host-owned selection, applied independently on every model request. */
export interface PiAiReasoningReplay {
  policy: 'native' | 'none' | 'tool-loop' | 'all' | 'last-assistant'
  /** Bound on retained reasoning UTF-8 text, including separators within each message. */
  maxBytes?: number
}

/** Detach and validate trusted adapter configuration before it can be used by a request. */
export function resolveReasoningReplay(config?: PiAiReasoningReplay): Readonly<Required<PiAiReasoningReplay>> {
  const policy = config?.policy ?? 'native'
  if (!['native', 'none', 'tool-loop', 'all', 'last-assistant'].includes(policy)) {
    throw new LlmError('Unknown reasoning replay policy', 'INVALID_CONFIG')
  }
  return Object.freeze({ policy, maxBytes: reasoningByteLimit(config?.maxBytes) })
}

/**
 * Project a freshly converted context using original DSH roles for selection.
 * `last-assistant` selects the last assistant even if it has no reasoning;
 * `tool-loop` selects assistants after the last genuine user source, excluding context injections.
 * Retention requires OpenAI Chat; `none` can omit unsigned same-target reasoning on any protocol.
 * @param context - new request context owned by this adapter call.
 * @param options - frozen DSH request; not mutated.
 * @param model - exact model captured by prepareCall.
 * @param config - validated trusted adapter configuration.
 */
export function projectReasoningReplay(
  context: Context, options: GenerateOptions, model: Model<Api>, config: Readonly<Required<PiAiReasoningReplay>>,
): void {
  if (config.policy === 'native') return
  if (config.policy !== 'none' && (model.api !== 'openai-completions' || (model.compat !== undefined
    && 'requiresThinkingAsText' in model.compat && model.compat.requiresThinkingAsText === true))) {
    throw new LlmError('Reasoning selection requires OpenAI Chat text replay', 'UNSUPPORTED_REASONING_REPLAY')
  }
  let lastUser = -1, lastAssistant = -1
  options.messages.forEach((message, index) => {
    if (message.role === 'user' && message.source?.kind === 'user') lastUser = index
    if (message.role === 'assistant') lastAssistant = index
  })
  const originalAssistants = options.messages.flatMap((message, index) => message.role === 'assistant' ? [index] : [])
  let assistantIndex = 0, bytes = 0
  for (const message of context.messages) {
    if (message.role !== 'assistant') continue
    const index = originalAssistants[assistantIndex++] as number
    const thinking = message.content.filter(block => block.type === 'thinking')
    if (message.content.some(block => (block.type === 'text' && block.textSignature !== undefined)
      || (block.type === 'toolCall' && block.thoughtSignature !== undefined))) {
      throw new LlmError('Signed history requires explicit reconstruction', 'UNSUPPORTED_REASONING_REPLAY')
    }
    if (thinking.length === 0) continue
    if (message.api !== model.api || message.provider !== model.provider || message.model !== model.id
      || !['stop', 'toolUse'].includes(message.stopReason)
      || thinking.some(block => block.redacted !== undefined
        || (block.thinkingSignature !== undefined && block.thinkingSignature !== 'reasoning_content')
        || (config.policy !== 'none' && block.thinkingSignature !== 'reasoning_content'))) {
      throw new LlmError('Reasoning history requires explicit reconstruction', 'UNSUPPORTED_REASONING_REPLAY')
    }
    const keep = config.policy === 'all' || (config.policy === 'last-assistant' && index === lastAssistant)
      || (config.policy === 'tool-loop' && lastUser >= 0 && index > lastUser)
    if (keep) {
      bytes += Buffer.byteLength(thinking.map(block => block.thinking).join('\n'), 'utf8')
      if (bytes > config.maxBytes) {
        throw new LlmError('Request reasoning exceeds maxBytes', 'REASONING_HISTORY_TOO_LARGE')
      }
    } else {
      message.content = message.content.filter(block => block.type !== 'thinking')
    }
  }
}
