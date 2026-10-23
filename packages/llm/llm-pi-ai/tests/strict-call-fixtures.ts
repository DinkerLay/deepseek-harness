/** Wire fixtures exercise the installed SDK patch rather than synthetic SDK events. */
import { textEvents } from './mock-server.ts'
export const protocols = ['openai-completions', 'anthropic-messages', 'openai-responses'] as const
export type Protocol = typeof protocols[number]
interface Call { args: string; id?: string | null; name?: string | null }
interface Override { finalOnly?: boolean; done?: string; final?: string; finalIdentity?: Record<string, string> }
const response = { id: 'r1', object: 'response', created_at: 1, model: 'model', status: 'in_progress', output: [] }
const start = { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'model', content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } }
export function functionEvents(api: Protocol, calls: Call[], override: Override = {}): string[] {
  const values = calls.map((call, index) => ({ ...call, id: call.id === undefined ? `call-${index}` : call.id, name: call.name === undefined ? 'search' : call.name }))
  if (api === 'openai-completions') return [JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: values.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.args } })) }, finish_reason: null }] }), JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }), '[DONE]']
  if (api === 'anthropic-messages') return [start, ...values.flatMap((call, index) => [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.args } },
    { type: 'content_block_stop', index },
  ]), { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }].map(value => JSON.stringify(value))
  return [{ type: 'response.created', response }, ...values.flatMap((call, index) => {
    const item = { type: 'function_call', id: `fc-${index}`, call_id: call.id, name: call.name, arguments: '' }
    return [{ type: 'response.output_item.added', output_index: index, item },
      ...override.finalOnly ? [] : [{ type: 'response.function_call_arguments.delta', output_index: index, delta: call.args }],
      ...override.done === undefined ? [] : [{ type: 'response.function_call_arguments.done', output_index: index, arguments: override.done }],
      { type: 'response.output_item.done', output_index: index, item: { ...item, arguments: override.final ?? call.args, ...override.finalIdentity } }]
  }), { type: 'response.completed', response: { ...response, status: 'completed', usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 } } }].map(value => JSON.stringify(value))
}
export function protocolTextEvents(api: Protocol): string[] {
  if (api === 'openai-completions') return textEvents
  if (api === 'anthropic-messages') return [start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' }].map(value => JSON.stringify(value))
  const item = { id: 'm1', type: 'message', role: 'assistant', content: [] }
  return [{ type: 'response.created', response }, { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'done' },
    { type: 'response.output_item.done', output_index: 0, item: { ...item, content: [{ type: 'output_text', text: 'done', annotations: [] }] } },
    { type: 'response.completed', response: { ...response, status: 'completed', usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }].map(value => JSON.stringify(value))
}
